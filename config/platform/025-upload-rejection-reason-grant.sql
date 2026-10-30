-- Allows psu-auth to record rejection_reason (added by 020) alongside the
-- other review-decision columns 019 already grants. recordReviewDecision in
-- services/auth/src/store.ts sets it on every approve or reject, so without
-- this grant both fail with "permission denied for table upload_event".
--
-- Reversal:
--   REVOKE UPDATE (rejection_reason) ON identity.upload_event FROM identity_app;

GRANT UPDATE (rejection_reason)
  ON identity.upload_event TO identity_app;
