-- Allows psu-auth to record the review decisions (status, target_table,
-- reviewed_by_username, reviewed_at, columns_included, columns_excluded)
-- when an analyst or admin approves or rejects an upload from the web portal.

GRANT UPDATE (status, reviewed_by_username, reviewed_at, target_table, columns_included, columns_excluded)
  ON identity.upload_event TO identity_app;
