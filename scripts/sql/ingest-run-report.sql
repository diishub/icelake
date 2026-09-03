SELECT target_table,
       status,
       rows_read,
       rows_written,
       columns_selected AS cols_in,
       columns_excluded AS cols_out,
       left(coalesce(skip_reason, error_message, ''), 64) AS note
FROM ingest.ingest_run
WHERE started_at > now() - interval '10 minutes'
ORDER BY target_table, started_at;
