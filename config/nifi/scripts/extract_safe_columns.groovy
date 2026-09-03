// Metadata-driven extraction.
//
// Reads the control plane to decide what to pull, mirrors the classification
// each source publishes about its own columns, and selects ONLY the columns
// that classification marks safe. A table with no safe column is skipped and
// says so; it is never widened to "select everything".
//
// Emits one FlowFile per table, containing the extracted rows as CSV, with
// the attributes the load stage needs. Claims one ingest_run row per table
// before doing any work and leaves it in the running state for the load stage
// to close, so two overlapping runs of the same table cannot both extract it.
//
// Runs inside ExecuteGroovyScript. Additional Classpath:
//   /opt/nifi/nifi-current/drivers/*.jar

import java.sql.*

final PLATFORM_URL  = "jdbc:postgresql://postgres:5432/platform"
final PLATFORM_USER = "platform_app"
final GUARDRAIL_DIR = "/guardrail"

def inputFlowFile = session.get()
if (!inputFlowFile) { return }

// ---------------------------------------------------------------------------
// Guardrail: the pipeline refuses an unapproved host itself, rather than
// trusting that whoever wrote the registry row checked first.
// ---------------------------------------------------------------------------
def readList = { String name ->
    def f = new File(GUARDRAIL_DIR, name)
    if (!f.exists()) { throw new IllegalStateException("guardrail list missing: " + f) }
    f.readLines().collect { it.replaceAll(/#.*/, "").trim().toLowerCase() }.findAll { it }
}
def allowedHosts   = readList("allowed-source-hosts.txt")
def forbiddenHosts = readList("forbidden-source-hosts.txt")

def hostRefusedReason = { String rawHost ->
    def host = (rawHost ?: "").trim().toLowerCase().split(":")[0]
    if (!host) { return "no host configured" }
    def denied = forbiddenHosts.find { host == it || host.endsWith("." + it) }
    if (denied) { return "host " + host + " matches the forbidden-source denylist (" + denied + ")" }
    if (!allowedHosts.contains(host)) { return "host " + host + " is not in allowed-source-hosts.txt" }
    return null
}

def csvCell = { Object value ->
    if (value == null) { return "" }
    def text = value.toString()
    if (text =~ /[",\r\n]/) { return '"' + text.replace('"', '""') + '"' }
    return text
}

def platformPassword = System.getenv("PLATFORM_DB_PASSWORD")
if (!platformPassword) { throw new IllegalStateException("PLATFORM_DB_PASSWORD is not set") }

Class.forName("org.postgresql.Driver")

def emitted = 0
def skipped = 0

Connection platform = DriverManager.getConnection(PLATFORM_URL, PLATFORM_USER, platformPassword)
try {
    platform.autoCommit = true

    // A run abandoned by a crash would hold its table forever, because at most
    // one run per table may be in progress. Close those first.
    platform.prepareStatement("SELECT ingest.close_stale_runs()").withCloseable { ps ->
        ps.executeQuery().withCloseable { rs ->
            rs.next()
            def closed = rs.getInt(1)
            if (closed > 0) { log.warn("closed " + closed + " abandoned run(s) before starting") }
        }
    }

    def targets = []
    def targetSql = "SELECT st.source_table_id, st.source_schema, st.source_table_name," +
        " st.target_schema, st.target_table_name, st.load_mode, st.incremental_column," +
        " ss.source_system_id, ss.source_key, ss.host, ss.port, ss.database_name," +
        " ss.credentials_env_prefix, ss.registry_schema, w.watermark_value" +
        " FROM ingest.source_table AS st" +
        " JOIN ingest.source_system AS ss USING (source_system_id)" +
        " LEFT JOIN ingest.ingest_watermark AS w USING (source_table_id)" +
        " WHERE st.is_enabled AND ss.is_enabled" +
        " ORDER BY ss.source_key, st.source_schema, st.source_table_name"
    platform.prepareStatement(targetSql).withCloseable { ps ->
        ps.executeQuery().withCloseable { rs ->
            while (rs.next()) {
                targets << [
                    sourceTableId : rs.getInt("source_table_id"),
                    sourceSchema  : rs.getString("source_schema"),
                    sourceTable   : rs.getString("source_table_name"),
                    targetSchema  : rs.getString("target_schema"),
                    targetTable   : rs.getString("target_table_name"),
                    loadMode      : rs.getString("load_mode"),
                    incrementalCol: rs.getString("incremental_column"),
                    sourceSystemId: rs.getInt("source_system_id"),
                    sourceKey     : rs.getString("source_key"),
                    host          : rs.getString("host"),
                    port          : rs.getInt("port"),
                    databaseName  : rs.getString("database_name"),
                    envPrefix     : rs.getString("credentials_env_prefix"),
                    registrySchema: rs.getString("registry_schema"),
                    watermark     : rs.getString("watermark_value")
                ]
            }
        }
    }
    log.info("metadata-driven ingest: " + targets.size() + " enabled table(s) to consider")

    // Claim the table before doing any work. The unique index on running runs
    // means a second, overlapping attempt loses the race here instead of
    // discovering the conflict after it has already extracted the rows.
    def claimRun = { Map t ->
        try {
            def sql = "INSERT INTO ingest.ingest_run (source_table_id, source_key, target_table, status)" +
                      " VALUES (?, ?, ?, 'running') RETURNING run_id"
            return platform.prepareStatement(sql).withCloseable { ps ->
                ps.setInt(1, t.sourceTableId)
                ps.setString(2, t.sourceKey)
                ps.setString(3, t.targetSchema + "." + t.targetTable)
                ps.executeQuery().withCloseable { rs -> rs.next(); rs.getString(1) }
            }
        } catch (SQLException e) {
            // 23505 is unique_violation: another run holds this table.
            if (e.getSQLState() == "23505") { return null }
            throw e
        }
    }

    def finishRun = { String runId, String status, String skipReason, String errorMessage,
                      Integer selected, Integer excluded, Long rowsRead ->
        def sql = "UPDATE ingest.ingest_run SET status = ?, ended_at = now(), skip_reason = ?," +
                  " error_message = ?, columns_selected = ?, columns_excluded = ?, rows_read = ?" +
                  " WHERE run_id = CAST(? AS uuid)"
        platform.prepareStatement(sql).withCloseable { ps ->
            ps.setString(1, status)
            ps.setString(2, skipReason)
            ps.setString(3, errorMessage)
            if (selected == null) { ps.setNull(4, Types.INTEGER) } else { ps.setInt(4, selected) }
            if (excluded == null) { ps.setNull(5, Types.INTEGER) } else { ps.setInt(5, excluded) }
            if (rowsRead == null) { ps.setNull(6, Types.BIGINT) } else { ps.setLong(6, rowsRead) }
            ps.setString(7, runId)
            ps.executeUpdate()
        }
    }

    def noteColumns = { String runId, Integer selected, Integer excluded ->
        platform.prepareStatement(
            "UPDATE ingest.ingest_run SET columns_selected = ?, columns_excluded = ? WHERE run_id = CAST(? AS uuid)"
        ).withCloseable { ps ->
            ps.setInt(1, selected)
            ps.setInt(2, excluded)
            ps.setString(3, runId)
            ps.executeUpdate()
        }
    }

    // -----------------------------------------------------------------------
    // One table at a time. A failure on one table is recorded and the run
    // continues with the next, so one bad source does not stall everything.
    // -----------------------------------------------------------------------
    targets.each { t ->
        def runId = null
        try {
            runId = claimRun(t)
            if (runId == null) {
                skipped++
                log.warn("skipping " + t.sourceSchema + "." + t.sourceTable + ": a run is already in progress")
                return
            }

            def refusal = hostRefusedReason(t.host)
            if (refusal) {
                finishRun(runId, "skipped", "guardrail refused the source: " + refusal, null, null, null, null)
                skipped++
                log.warn("skipped " + t.sourceSchema + "." + t.sourceTable + ": " + refusal)
                return
            }
            if (!t.registrySchema) {
                finishRun(runId, "skipped", "source publishes no classification registry", null, null, null, null)
                skipped++
                return
            }

            def sourceUser = System.getenv(t.envPrefix + "_READER_USER")
            def sourcePass = System.getenv(t.envPrefix + "_READER_PASSWORD")
            if (!sourceUser || !sourcePass) {
                throw new IllegalStateException(t.envPrefix + "_READER_USER or _READER_PASSWORD is not set")
            }

            def sourceUrl = "jdbc:postgresql://" + t.host + ":" + t.port + "/" + t.databaseName
            Connection source = DriverManager.getConnection(sourceUrl, sourceUser, sourcePass)
            try {
                source.readOnly = true

                // The source can withdraw a table from ingestion on its own
                // side. That decision wins over the local registry row.
                def sourceActive = false
                source.prepareStatement(
                    "SELECT is_active FROM " + t.registrySchema + ".db_table WHERE schema_name = ? AND table_name = ?"
                ).withCloseable { ps ->
                    ps.setString(1, t.sourceSchema)
                    ps.setString(2, t.sourceTable)
                    ps.executeQuery().withCloseable { rs -> sourceActive = rs.next() ? rs.getBoolean(1) : false }
                }
                if (!sourceActive) {
                    finishRun(runId, "skipped", "the source has withdrawn this table from ingestion", null, null, null, null)
                    skipped++
                    return
                }

                // Mirror the classification the source publishes.
                def published = []
                source.prepareStatement(
                    "SELECT column_name, data_type, classification, secret_level FROM " + t.registrySchema +
                    ".db_column WHERE schema_name = ? AND table_name = ? ORDER BY column_name"
                ).withCloseable { ps ->
                    ps.setString(1, t.sourceSchema)
                    ps.setString(2, t.sourceTable)
                    ps.executeQuery().withCloseable { rs ->
                        while (rs.next()) {
                            published << [name          : rs.getString("column_name"),
                                          dataType      : rs.getString("data_type"),
                                          classification: rs.getString("classification"),
                                          secretLevel   : rs.getInt("secret_level")]
                        }
                    }
                }
                if (published.isEmpty()) {
                    finishRun(runId, "skipped", "no column classification published for this table", null, 0, null, null)
                    skipped++
                    return
                }

                platform.prepareStatement(
                    "INSERT INTO ingest.column_classification (source_system_id, source_schema, source_table_name," +
                    " column_name, data_type, classification, secret_level, synced_at)" +
                    " VALUES (?, ?, ?, ?, ?, ?, ?, now())" +
                    " ON CONFLICT (source_system_id, source_schema, source_table_name, column_name) DO UPDATE" +
                    " SET data_type = EXCLUDED.data_type, classification = EXCLUDED.classification," +
                    " secret_level = EXCLUDED.secret_level, synced_at = EXCLUDED.synced_at"
                ).withCloseable { ps ->
                    published.each { c ->
                        ps.setInt(1, t.sourceSystemId)
                        ps.setString(2, t.sourceSchema)
                        ps.setString(3, t.sourceTable)
                        ps.setString(4, c.name)
                        ps.setString(5, c.dataType)
                        ps.setString(6, c.classification)
                        ps.setInt(7, c.secretLevel)
                        ps.addBatch()
                    }
                    ps.executeBatch()
                }

                // Ask the control plane which of those columns are safe, so
                // the rule is applied in exactly one place (the generated
                // is_safe column) rather than re-implemented here.
                def safeNames = []
                def safeTypes = [:]
                platform.prepareStatement(
                    "SELECT column_name, data_type FROM ingest.column_classification" +
                    " WHERE source_system_id = ? AND source_schema = ? AND source_table_name = ?" +
                    " AND is_safe ORDER BY column_name"
                ).withCloseable { ps ->
                    ps.setInt(1, t.sourceSystemId)
                    ps.setString(2, t.sourceSchema)
                    ps.setString(3, t.sourceTable)
                    ps.executeQuery().withCloseable { rs ->
                        while (rs.next()) {
                            def n = rs.getString("column_name")
                            safeNames << n
                            safeTypes[n] = rs.getString("data_type")
                        }
                    }
                }
                // Only columns the source published in THIS sync are eligible,
                // so a column dropped from the registry cannot linger as safe.
                def publishedNames = published.collect { it.name } as Set
                safeNames = safeNames.findAll { publishedNames.contains(it) }
                def excludedCount = published.size() - safeNames.size()

                if (safeNames.isEmpty()) {
                    finishRun(runId, "skipped",
                        "every one of the " + published.size() + " published columns is classified as not safe",
                        null, 0, excludedCount, null)
                    skipped++
                    log.warn("skipped " + t.sourceSchema + "." + t.sourceTable + ": no safe column")
                    return
                }
                noteColumns(runId, safeNames.size(), excludedCount)

                def watermarkType = "text"
                if (t.loadMode == "incremental" && !safeNames.contains(t.incrementalCol)) {
                    finishRun(runId, "skipped",
                        "the incremental column " + t.incrementalCol + " is not classified as safe",
                        null, safeNames.size(), excludedCount, null)
                    skipped++
                    return
                }

                // Build the projection from the safe columns only. There is no
                // code path in this script that emits SELECT star.
                def projection = safeNames.collect { "\"" + it + "\"" }.join(", ")
                def sql = new StringBuilder("SELECT " + projection +
                    " FROM \"" + t.sourceSchema + "\".\"" + t.sourceTable + "\"")

                if (t.loadMode == "incremental") {
                    def incType = (safeTypes[t.incrementalCol] ?: "").toLowerCase()
                    if (incType =~ /int|numeric|decimal|real|double/) { watermarkType = "numeric" }
                    else if (incType =~ /timestamp|date/)             { watermarkType = "timestamp" }
                    if (t.watermark != null) {
                        def castTo = (watermarkType == "numeric") ? "numeric"
                                   : (watermarkType == "timestamp") ? "timestamptz" : "text"
                        sql.append(" WHERE \"" + t.incrementalCol + "\" > CAST(? AS " + castTo + ")")
                    }
                    sql.append(" ORDER BY \"" + t.incrementalCol + "\"")
                }

                def csv = new StringBuilder()
                csv.append(safeNames.collect { csvCell(it) }.join(",")).append("\n")
                long rowsRead = 0
                String maxWatermark = t.watermark

                source.prepareStatement(sql.toString()).withCloseable { ps ->
                    if (t.loadMode == "incremental" && t.watermark != null) { ps.setString(1, t.watermark) }
                    ps.fetchSize = 5000
                    ps.executeQuery().withCloseable { rs ->
                        while (rs.next()) {
                            csv.append(safeNames.collect { csvCell(rs.getObject(it)) }.join(",")).append("\n")
                            rowsRead++
                            if (t.loadMode == "incremental") {
                                def v = rs.getObject(t.incrementalCol)
                                if (v != null) { maxWatermark = v.toString() }
                            }
                        }
                    }
                }

                if (rowsRead == 0L) {
                    // Nothing new is a normal outcome for an incremental load,
                    // and recording it keeps the freshness view honest.
                    platform.prepareStatement(
                        "UPDATE ingest.ingest_run SET status = 'succeeded', ended_at = now()," +
                        " rows_read = 0, rows_written = 0 WHERE run_id = CAST(? AS uuid)"
                    ).withCloseable { ps -> ps.setString(1, runId); ps.executeUpdate() }
                    log.info("no new rows for " + t.sourceSchema + "." + t.sourceTable)
                    return
                }

                def stagingKey = "staging/db/" + t.sourceKey + "/" + t.sourceSchema + "/" +
                                 t.sourceTable + "/" + runId + "/data.csv"

                def out = session.create(inputFlowFile)
                out = session.write(out, { outputStream ->
                    outputStream.write(csv.toString().getBytes("UTF-8"))
                } as org.apache.nifi.processor.io.OutputStreamCallback)
                out = session.putAllAttributes(out, [
                    "ingest.run.id"          : runId,
                    "ingest.source.table.id" : t.sourceTableId.toString(),
                    "ingest.source.key"      : t.sourceKey,
                    "ingest.source.schema"   : t.sourceSchema,
                    "ingest.source.table"    : t.sourceTable,
                    "ingest.target.schema"   : t.targetSchema,
                    "ingest.target.table"    : t.targetTable,
                    "ingest.load.mode"       : t.loadMode,
                    "ingest.columns"         : safeNames.join(","),
                    "ingest.column.types"    : safeNames.collect { safeTypes[it] }.join(","),
                    "ingest.columns.excluded": excludedCount.toString(),
                    "ingest.rows.read"       : rowsRead.toString(),
                    "ingest.watermark.value" : (maxWatermark ?: ""),
                    "ingest.watermark.type"  : watermarkType,
                    "ingest.staging.key"     : stagingKey,
                    "filename"               : "data.csv"
                ])
                session.transfer(out, REL_SUCCESS)
                emitted++
                log.info("extracted " + rowsRead + " row(s), " + safeNames.size() + " safe column(s), " +
                         excludedCount + " excluded from " + t.sourceSchema + "." + t.sourceTable)
            } finally {
                source.close()
            }
        } catch (Exception e) {
            log.error("extraction failed for " + t.sourceSchema + "." + t.sourceTable + ": " + e.message, e)
            try {
                // The exception type and message only. Never a row value.
                def detail = e.class.simpleName + ": " + e.message
                if (runId != null) {
                    finishRun(runId, "failed", null, detail, null, null, null)
                } else {
                    platform.prepareStatement(
                        "INSERT INTO ingest.ingest_run (source_table_id, source_key, target_table, status," +
                        " error_message, ended_at) VALUES (?, ?, ?, 'failed', ?, now())"
                    ).withCloseable { ps ->
                        ps.setInt(1, t.sourceTableId)
                        ps.setString(2, t.sourceKey)
                        ps.setString(3, t.targetSchema + "." + t.targetTable)
                        ps.setString(4, detail)
                        ps.executeUpdate()
                    }
                }
            } catch (Exception recordFailure) {
                log.error("could not record the failed run: " + recordFailure.message)
            }
        }
    }
} finally {
    platform.close()
}

log.info("metadata-driven ingest planning finished: " + emitted + " extracted, " + skipped + " skipped")
session.remove(inputFlowFile)
