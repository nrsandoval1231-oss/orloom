-- Permit one explicitly requested final recheck after a terminal UNKNOWN.
-- Keep the established index name: migration 005 is replayed on connect and
-- uses IF NOT EXISTS, so it must continue to see this ordinal-aware index.
ALTER TABLE verification_attempts
  ADD COLUMN IF NOT EXISTS final_retry_ordinal integer NOT NULL DEFAULT 0;

ALTER TABLE verification_attempts
  DROP CONSTRAINT IF EXISTS verification_attempts_final_retry_ordinal_check;
ALTER TABLE verification_attempts
  ADD CONSTRAINT verification_attempts_final_retry_ordinal_check
  CHECK ((purpose='final' AND final_retry_ordinal IN (0,1)) OR (purpose='recovery' AND final_retry_ordinal=0));

DROP INDEX IF EXISTS verification_attempts_final_unique;
CREATE UNIQUE INDEX verification_attempts_final_unique
  ON verification_attempts(mission_id,slice_id,lease_epoch,check_id,final_retry_ordinal)
  WHERE purpose='final';