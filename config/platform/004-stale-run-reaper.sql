-- Close runs abandoned by a crash.
--
-- The one-active-run index means a run stuck in the running state would block
-- its table forever. This function ends any run that has been in progress for
-- longer than the given age, so the next attempt can proceed and the
-- abandoned attempt is visible as a failure rather than as a run that never
-- ended.

CREATE OR REPLACE FUNCTION ingest.close_stale_runs(max_age interval DEFAULT interval '6 hours')
RETURNS integer
LANGUAGE sql
AS $$
  WITH closed AS (
    UPDATE ingest.ingest_run
    SET status = 'failed',
        ended_at = now(),
        error_message = 'abandoned: still in progress after ' || max_age::text
    WHERE status = 'running'
      AND started_at < now() - max_age
    RETURNING 1
  )
  SELECT count(*)::integer FROM closed;
$$;

GRANT EXECUTE ON FUNCTION ingest.close_stale_runs(interval) TO platform_app;
