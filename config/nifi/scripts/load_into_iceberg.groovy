// Load one staged extract into Iceberg through Trino.
//
// The staged object is already in RustFS. This creates the target Iceberg
// table if needed, points a throwaway external table at the single staged
// file, inserts through it with the audit columns attached, drops the
// pointer, and closes the ingest_run row that the extraction stage opened.
//
// NiFi cannot write to this Polaris directly (its Iceberg processors fail
// against it), so Trino SQL is the bridge. See README section 6.4.
//
// Runs inside ExecuteGroovyScript. Additional Classpath:
//   /opt/nifi/nifi-current/drivers

import groovy.json.JsonSlurper
import java.sql.DriverManager
import java.time.Instant
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

final TRINO_URL      = "https://trino:8443/v1/statement"
final TRINO_USER     = System.getenv("TRINO_INGESTION_USERNAME") ?: "nifi"
final TRINO_PASSWORD = System.getenv("TRINO_INGESTION_PASSWORD")
final PLATFORM_URL   = "jdbc:postgresql://postgres:5432/platform"
final PLATFORM_USER  = "platform_app"
final BUCKET         = System.getenv("RUSTFS_BUCKET") ?: "psu-lakehouse"

if (!TRINO_PASSWORD) { throw new IllegalStateException("TRINO_INGESTION_PASSWORD is not set") }

// Trino now authenticates over TLS with a certificate this stack generated
// itself, so there is no chain to validate against. Verification is disabled
// for this one host rather than globally, and the credential still has to be
// correct -- the transport is what is unverified here, not the identity.
final TRUST_SELF_SIGNED = { connection ->
    if (connection instanceof HttpsURLConnection) {
        def trustAll = [
            getAcceptedIssuers: { null },
            checkClientTrusted: { chain, authType -> },
            checkServerTrusted: { chain, authType -> },
        ] as X509TrustManager
        def context = SSLContext.getInstance("TLS")
        context.init(null, [trustAll] as javax.net.ssl.TrustManager[], new java.security.SecureRandom())
        connection.setSSLSocketFactory(context.getSocketFactory())
        connection.setHostnameVerifier({ hostname, session -> hostname == "trino" } as HostnameVerifier)
    }
    def credentials = "${TRINO_USER}:${TRINO_PASSWORD}".getBytes("UTF-8").encodeBase64().toString()
    connection.setRequestProperty("Authorization", "Basic " + credentials)
    return connection
}

def flowFile = session.get()
if (!flowFile) { return }

def attr = { String name -> flowFile.getAttribute(name) }

def runId         = attr("ingest.run.id")
def sourceKey     = attr("ingest.source.key")
def sourceSchema  = attr("ingest.source.schema")
def sourceTable   = attr("ingest.source.table")
def targetSchema  = attr("ingest.target.schema")
def targetTable   = attr("ingest.target.table")
def loadMode      = attr("ingest.load.mode")
def columns       = attr("ingest.columns").split(",") as List
def columnTypes   = attr("ingest.column.types").split(",") as List
def rowsRead      = (attr("ingest.rows.read") ?: "0") as long
def stagingKey    = attr("ingest.staging.key")
def watermark     = attr("ingest.watermark.value")
def watermarkType = attr("ingest.watermark.type")
def sourceTableId = (attr("ingest.source.table.id")) as int

// ---------------------------------------------------------------------------
// Trino REST client. Errors arrive in the response body with HTTP 200, so the
// body has to be inspected rather than the status code alone.
// ---------------------------------------------------------------------------
def runQuery = { String sql ->
    def slurper = new JsonSlurper()
    def connection = TRUST_SELF_SIGNED(new URL(TRINO_URL).openConnection())
    connection.setRequestMethod("POST")
    connection.setRequestProperty("Content-Type", "text/plain")
    connection.doOutput = true
    connection.outputStream.withWriter("UTF-8") { it.write(sql) }
    def response = slurper.parseText(connection.inputStream.getText("UTF-8"))

    Long updateCount = null
    while (true) {
        if (response.error) {
            throw new RuntimeException("Trino: " + response.error.message + " [" + response.error.errorName + "]")
        }
        if (response.updateCount != null) { updateCount = response.updateCount as Long }
        if (!response.nextUri) { break }
        def next = TRUST_SELF_SIGNED(new URL(response.nextUri).openConnection())
        response = slurper.parseText(next.inputStream.getText("UTF-8"))
    }
    return updateCount
}

// PostgreSQL types as reported by information_schema, mapped to Trino types.
// Anything unrecognised stays VARCHAR rather than being guessed at.
def trinoType = { String pgType ->
    def t = (pgType ?: "").toLowerCase().trim()
    if (t in ["smallint", "int2"])                          { return "SMALLINT" }
    if (t in ["integer", "int", "int4"])                    { return "INTEGER" }
    if (t in ["bigint", "int8"])                            { return "BIGINT" }
    if (t.startsWith("numeric") || t.startsWith("decimal")) { return "DECIMAL(38,9)" }
    if (t in ["real", "float4"])                            { return "REAL" }
    if (t in ["double precision", "float8"])                { return "DOUBLE" }
    if (t in ["boolean", "bool"])                           { return "BOOLEAN" }
    if (t == "date")                                        { return "DATE" }
    if (t.startsWith("timestamp with time zone"))           { return "TIMESTAMP(6) WITH TIME ZONE" }
    if (t.startsWith("timestamp"))                          { return "TIMESTAMP(6)" }
    return "VARCHAR"
}

def quoted = { String name -> "\"" + name + "\"" }

def stagingTable     = "stg_" + runId.replaceAll("-", "")
def qualifiedTarget  = "polaris." + targetSchema + "." + quoted(targetTable)
def qualifiedStaging = "hive.raw_staging." + quoted(stagingTable)
def stagingDirectory = stagingKey.substring(0, stagingKey.lastIndexOf("/") + 1)

def platformPassword = System.getenv("PLATFORM_DB_PASSWORD")
Class.forName("org.postgresql.Driver")

def failRun = { String message ->
    try {
        DriverManager.getConnection(PLATFORM_URL, PLATFORM_USER, platformPassword).withCloseable { c ->
            c.prepareStatement("UPDATE ingest.ingest_run SET status = 'failed', ended_at = now(), error_message = ? WHERE run_id = CAST(? AS uuid)").withCloseable { ps ->
                ps.setString(1, message)
                ps.setString(2, runId)
                ps.executeUpdate()
            }
        }
    } catch (Exception e) {
        log.error("could not mark run " + runId + " as failed: " + e.message)
    }
}

try {
    // 1. Target table, created with the audit columns every ingested table
    //    carries and partitioned by ingest day so maintenance has something
    //    to work with later.
    def targetColumns = []
    columns.eachWithIndex { name, i -> targetColumns << (quoted(name) + " " + trinoType(columnTypes[i])) }
    targetColumns << (quoted("_ingested_at") + " TIMESTAMP(6)")
    targetColumns << (quoted("_source_system") + " VARCHAR")
    targetColumns << (quoted("_source_table") + " VARCHAR")
    targetColumns << (quoted("_run_id") + " VARCHAR")

    runQuery("CREATE TABLE IF NOT EXISTS " + qualifiedTarget +
             " (" + targetColumns.join(", ") + ")" +
             " WITH (partitioning = ARRAY['day(_ingested_at)'])")

    // 2. The staged file is CSV, so every column of the pointer table is
    //    VARCHAR; the cast to the real type happens in the INSERT.
    def stagingColumns = columns.collect { quoted(it) + " VARCHAR" }.join(", ")
    runQuery("CREATE TABLE " + qualifiedStaging + " (" + stagingColumns + ")" +
             " WITH (external_location = 's3://" + BUCKET + "/" + stagingDirectory + "'," +
             " format = 'CSV', skip_header_line_count = 1)")

    long rowsWritten = 0
    try {
        // 3. A full refresh replaces the contents; an incremental load appends.
        if (loadMode == "full_refresh") {
            runQuery("DELETE FROM " + qualifiedTarget)
        }

        def selectList = []
        columns.eachWithIndex { name, i ->
            selectList << ("CAST(NULLIF(" + quoted(name) + ", '') AS " + trinoType(columnTypes[i]) + ")")
        }
        def ingestedAt = Instant.now().toString().replace("T", " ").replace("Z", "")
        selectList << ("TIMESTAMP '" + ingestedAt + "'")
        selectList << ("'" + sourceKey + "'")
        selectList << ("'" + sourceSchema + "." + sourceTable + "'")
        selectList << ("'" + runId + "'")

        def insertColumns = columns.collect { quoted(it) }
        insertColumns << quoted("_ingested_at")
        insertColumns << quoted("_source_system")
        insertColumns << quoted("_source_table")
        insertColumns << quoted("_run_id")

        def updateCount = runQuery("INSERT INTO " + qualifiedTarget +
            " (" + insertColumns.join(", ") + ") SELECT " + selectList.join(", ") +
            " FROM " + qualifiedStaging)
        rowsWritten = (updateCount != null) ? updateCount : rowsRead
    } finally {
        // 4. Metadata only: the staged object in RustFS is untouched, so this
        //    is safe whether the insert succeeded or not.
        try {
            runQuery("DROP TABLE IF EXISTS " + qualifiedStaging)
        } catch (Exception dropFailure) {
            log.warn("could not drop the staging pointer " + stagingTable + ": " + dropFailure.message)
        }
    }

    // 5. Close the run, and move the watermark only now that the rows are
    //    committed, so a failed load is retried rather than silently skipped.
    DriverManager.getConnection(PLATFORM_URL, PLATFORM_USER, platformPassword).withCloseable { c ->
        c.autoCommit = false
        c.prepareStatement("UPDATE ingest.ingest_run SET status = 'succeeded', ended_at = now(), rows_read = ?, rows_written = ?, staged_object_key = ? WHERE run_id = CAST(? AS uuid)").withCloseable { ps ->
            ps.setLong(1, rowsRead)
            ps.setLong(2, rowsWritten)
            ps.setString(3, stagingKey)
            ps.setString(4, runId)
            ps.executeUpdate()
        }
        if (loadMode == "incremental" && watermark) {
            c.prepareStatement("INSERT INTO ingest.ingest_watermark (source_table_id, watermark_value, watermark_type, last_run_id, updated_at) VALUES (?, ?, ?, CAST(? AS uuid), now()) ON CONFLICT (source_table_id) DO UPDATE SET watermark_value = EXCLUDED.watermark_value, watermark_type = EXCLUDED.watermark_type, last_run_id = EXCLUDED.last_run_id, updated_at = EXCLUDED.updated_at").withCloseable { ps ->
                ps.setInt(1, sourceTableId)
                ps.setString(2, watermark)
                ps.setString(3, watermarkType)
                ps.setString(4, runId)
                ps.executeUpdate()
            }
        }
        c.commit()
    }

    flowFile = session.putAttribute(flowFile, "ingest.rows.written", rowsWritten.toString())
    session.transfer(flowFile, REL_SUCCESS)
    log.info("loaded " + rowsWritten + " row(s) into " + targetSchema + "." + targetTable + " for run " + runId)
} catch (Exception e) {
    log.error("load failed for " + targetSchema + "." + targetTable + " run " + runId + ": " + e.message, e)
    failRun(e.class.simpleName + ": " + e.message)
    flowFile = session.putAttribute(flowFile, "ingest.error", e.message ?: "unknown")
    session.transfer(flowFile, REL_FAILURE)
}
