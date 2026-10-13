ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'final' CHECK (purpose IN ('final','recovery'));
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS recovery_ordinal integer;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS target_check_id text;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS strategy_id text;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS lease_policy_digest text;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS recovery_policy_digest text;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS bound_lesson_id uuid REFERENCES operational_lessons(id);
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS bound_lesson_version integer;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS bound_lesson_challenge_digest text CHECK (bound_lesson_challenge_digest IS NULL OR bound_lesson_challenge_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS head_observed_at timestamptz;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS head_observation_digest text CHECK (head_observation_digest IS NULL OR head_observation_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS result_head_observed_at timestamptz;
ALTER TABLE verification_attempts ADD COLUMN IF NOT EXISTS result_head_observation_digest text CHECK (result_head_observation_digest IS NULL OR result_head_observation_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE operational_lessons ADD COLUMN IF NOT EXISTS independent_challenge_digest text CHECK (independent_challenge_digest IS NULL OR independent_challenge_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE verification_attempts DROP CONSTRAINT IF EXISTS verification_attempts_mission_id_slice_id_lease_epoch_check_key;
ALTER TABLE verification_attempts DROP CONSTRAINT IF EXISTS verification_attempts_mission_id_slice_id_lease_epoch_check_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS verification_attempts_final_unique ON verification_attempts(mission_id,slice_id,lease_epoch,check_id) WHERE purpose='final';
CREATE UNIQUE INDEX IF NOT EXISTS verification_attempts_recovery_unique ON verification_attempts(mission_id,slice_id,lease_epoch,recovery_ordinal) WHERE purpose='recovery';
CREATE UNIQUE INDEX IF NOT EXISTS verification_attempts_recovery_event_unique ON verification_attempts(attempt_id) WHERE purpose='recovery';
ALTER TABLE verification_attempts ADD CONSTRAINT verification_attempts_recovery_binding_check CHECK (
  (purpose='final' AND recovery_ordinal IS NULL AND target_check_id IS NULL AND strategy_id IS NULL)
  OR (purpose='recovery' AND recovery_ordinal > 0 AND target_check_id IS NOT NULL AND strategy_id IS NOT NULL)
);

ALTER TABLE mission_recovery_progress ADD COLUMN IF NOT EXISTS trusted_attempt_id uuid REFERENCES verification_attempts(attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS mission_recovery_progress_attempt_unique ON mission_recovery_progress(trusted_attempt_id) WHERE trusted_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operational_lesson_challenges (
  challenge_digest text PRIMARY KEY CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
  lesson_id uuid NOT NULL REFERENCES operational_lessons(id),
  lesson_version integer NOT NULL CHECK (lesson_version > 0),
  verifier_id text NOT NULL,
  algorithm_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  reason text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_lesson_accepted_challenge_unique
  ON operational_lesson_challenges(lesson_id,lesson_version) WHERE decision='accepted';
CREATE UNIQUE INDEX IF NOT EXISTS operational_lessons_active_scope_unique
  ON operational_lessons(repository,cohort,from_check_id,policy_digest) WHERE status='promoted';
