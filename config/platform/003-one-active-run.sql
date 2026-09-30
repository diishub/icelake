-- Stop two runs of the same table from overlapping.
--
-- Found the hard way: two overlapping runs of an incremental table each read
-- the same rows, because the second one started before the first had
-- committed the new watermark, and the target ended up with the rows twice.
-- A full refresh happens to survive this because it clears the table first;
-- an incremental append does not.
--
-- The database enforces it rather than the pipeline checking first, so the
-- guarantee does not depend on the timing of that check.

CREATE UNIQUE INDEX IF NOT EXISTS ingest_run_one_active_per_table
  ON ingest.ingest_run (source_table_id)
  WHERE status = 'running';

COMMENT ON INDEX ingest.ingest_run_one_active_per_table IS
  'At most one run per table may be in progress. A stale run left behind by a crash is closed by the extraction stage before it starts, see 004.';
