// Load one staged aggregate CSV into Iceberg through Trino.
//
// Sibling of load_into_iceberg.groovy, for file sources rather than database
// sources. The differences are deliberate:
//
//   - there is no ingest_run row to close, because a dropped-in file has no
//     entry in the ingest.source_system registry; the run record for these
//     extracts is the _ingested_at/_run_id pair carried on every row;
//   - the column list comes from dotblue_tables.json, not from a source's
//     information_schema, so a column cannot silently change type between
//     runs and an unknown file is refused rather than guessed at;
//   - load mode is always full_refresh: these are snapshot aggregates
//     recomputed from the whole source, so appending would double-count.
//
// NiFi cannot write to this Polaris directly (its Iceberg processors fail
// against it), so Trino SQL is the bridge. See README section 6.4.
//
// Runs inside ExecuteGroovyScript. Additional Classpath:
//   /opt/nifi/nifi-current/drivers
//
// Expects these FlowFile attributes:
//   dotblue.table    target table name, must exist in dotblue_tables.json
//   dotblue.s3.key   full object key of the single staged CSV in RustFS
//   dotblue.run.id   identifier recorded in the _run_id audit column

import groovy.json.JsonSlurper
import java.time.Instant
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

final TRINO_URL      = "https://trino:8443/v1/statement"
final TRINO_USER     = System.getenv("TRINO_INGESTION_USERNAME") ?: "nifi"
final TRINO_PASSWORD = System.getenv("TRINO_INGESTION_PASSWORD")
final BUCKET         = System.getenv("RUSTFS_BUCKET") ?: "psu-lakehouse"
final SCHEMA_FILE    = "/opt/nifi/nifi-current/ingest-scripts/dotblue_tables.json"
final TARGET_SCHEMA  = "raw"

if (!TRINO_PASSWORD) { throw new IllegalStateException("TRINO_INGESTION_PASSWORD is not set") }

// Trino authenticates over TLS with a certificate this stack generated itself,
// so there is no chain to validate against. Verification is disabled for this
// one host rather than globally, and the credential still has to be correct --
// the transport is what is unverified here, not the identity.
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

def tableName = flowFile.getAttribute("dotblue.table")
def stagingKey = flowFile.getAttribute("dotblue.s3.key")
def runId = flowFile.getAttribute("dotblue.run.id") ?: java.util.UUID.randomUUID().toString()

// Trino REST client. Errors arrive in the response body with HTTP 200, so the
// body has to be inspected rather than the status code alone.
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

def quoted = { String name -> "\"" + name + "\"" }

try {
    def spec = new JsonSlurper().parse(new File(SCHEMA_FILE))
    def table = spec.tables[tableName]
    if (table == null) {
        // An unregistered file is refused, not guessed at: the same fail-closed
        // rule the ingestion registry applies to database tables.
        throw new IllegalStateException("table '" + tableName + "' is not declared in dotblue_tables.json")
    }

    def columns = table.columns
    def stagingTable = "stg_" + tableName + "_" + runId.replaceAll("-", "")
    def qualifiedTarget = "polaris." + TARGET_SCHEMA + "." + quoted(tableName)
    def qualifiedStaging = "hive.raw_staging." + quoted(stagingTable)
    // external_location addresses a directory and Trino reads every file in
    // it, so each staged CSV gets a directory of its own upstream.
    def stagingDirectory = stagingKey.substring(0, stagingKey.lastIndexOf("/") + 1)

    // 1. Target table, with the audit columns every ingested table carries and
    //    partitioned by ingest day so maintenance has something to work with.
    def targetColumns = columns.collect { quoted(it.name) + " " + it.type }
    targetColumns << (quoted("_ingested_at") + " TIMESTAMP(6)")
    targetColumns << (quoted("_source_system") + " VARCHAR")
    targetColumns << (quoted("_source_table") + " VARCHAR")
    targetColumns << (quoted("_run_id") + " VARCHAR")

    runQuery("CREATE TABLE IF NOT EXISTS " + qualifiedTarget +
             " (" + targetColumns.join(", ") + ")" +
             " WITH (partitioning = ARRAY['day(_ingested_at)'])")

    // 2. The staged file is CSV, so every column of the pointer table is
    //    VARCHAR; the cast to the declared type happens in the INSERT.
    def stagingColumns = columns.collect { quoted(it.name) + " VARCHAR" }.join(", ")
    runQuery("CREATE TABLE " + qualifiedStaging + " (" + stagingColumns + ")" +
             " WITH (external_location = 's3://" + BUCKET + "/" + stagingDirectory + "'," +
             " format = 'CSV', skip_header_line_count = 1)")

    long rowsWritten = 0
    try {
        // 3. Snapshot semantics: replace, never append.
        runQuery("DELETE FROM " + qualifiedTarget)

        def selectList = columns.collect {
            "CAST(NULLIF(" + quoted(it.name) + ", '') AS " + it.type + ")"
        }
        def ingestedAt = Instant.now().toString().replace("T", " ").replace("Z", "")
        selectList << ("TIMESTAMP '" + ingestedAt + "'")
        selectList << ("'" + spec.source_system + "'")
        selectList << ("'" + tableName + "'")
        selectList << ("'" + runId + "'")

        def insertColumns = columns.collect { quoted(it.name) }
        insertColumns << quoted("_ingested_at")
        insertColumns << quoted("_source_system")
        insertColumns << quoted("_source_table")
        insertColumns << quoted("_run_id")

        def updateCount = runQuery("INSERT INTO " + qualifiedTarget +
            " (" + insertColumns.join(", ") + ") SELECT " + selectList.join(", ") +
            " FROM " + qualifiedStaging)
        rowsWritten = (updateCount != null) ? updateCount : 0
    } finally {
        // 4. Metadata only: the staged object in RustFS is untouched, so this
        //    is safe whether the insert succeeded or not.
        try {
            runQuery("DROP TABLE IF EXISTS " + qualifiedStaging)
        } catch (Exception dropFailure) {
            log.warn("could not drop the staging pointer " + stagingTable + ": " + dropFailure.message)
        }
    }

    flowFile = session.putAttribute(flowFile, "dotblue.rows.written", rowsWritten.toString())
    session.transfer(flowFile, REL_SUCCESS)
    log.info("loaded " + rowsWritten + " row(s) into " + TARGET_SCHEMA + "." + tableName + " for run " + runId)
} catch (Exception e) {
    log.error("load failed for " + tableName + " run " + runId + ": " + e.message, e)
    flowFile = session.putAttribute(flowFile, "dotblue.error", e.message ?: "unknown")
    session.transfer(flowFile, REL_FAILURE)
}
