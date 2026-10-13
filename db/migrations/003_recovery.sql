ALTER TABLE mission_slices ADD COLUMN IF NOT EXISTS lease_plan_digest text;
ALTER TABLE mission_slices ADD COLUMN IF NOT EXISTS lease_policy_digest text;
ALTER TABLE mission_slices ADD COLUMN IF NOT EXISTS lease_recovery_policy_digest text;

CREATE TABLE IF NOT EXISTS mission_recovery_state (
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_ordinal integer NOT NULL DEFAULT 0 CHECK (last_ordinal >= 0),
  PRIMARY KEY (mission_id, slice_id),
  FOREIGN KEY (mission_id, slice_id) REFERENCES mission_slices(mission_id, id)
);

CREATE TABLE IF NOT EXISTS mission_recovery_progress (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  progress jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  judgment jsonb,
  action jsonb,
  decision_status text NOT NULL DEFAULT 'prepared' CHECK (decision_status IN ('prepared','committed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, slice_id, lease_epoch, ordinal),
  FOREIGN KEY (mission_id, slice_id) REFERENCES mission_slices(mission_id, id)
);

CREATE TABLE IF NOT EXISTS operational_lessons (
  id uuid PRIMARY KEY,
  repository text NOT NULL,
  cohort text NOT NULL,
  from_check_id text NOT NULL,
  strategy_id text NOT NULL,
  rule text NOT NULL,
  lesson_version integer NOT NULL DEFAULT 1 CHECK (lesson_version > 0),
  metric text NOT NULL CHECK (metric='trusted_check_pass_rate'),
  direction text NOT NULL CHECK (direction='increase'),
  baseline_failed integer NOT NULL DEFAULT 0 CHECK (baseline_failed >= 0),
  baseline_observed integer NOT NULL DEFAULT 0 CHECK (baseline_observed >= baseline_failed),
  outcome_passed integer NOT NULL DEFAULT 0 CHECK (outcome_passed >= 0),
  outcome_observed integer NOT NULL DEFAULT 0 CHECK (outcome_observed >= outcome_passed),
  policy_version text NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('candidate','promoted','withdrawn')),
  evidence_event_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_event_ids)='array'),
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[a-f0-9]{64}$'),
  proposed_by text NOT NULL,
  reviewer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  withdrawn_at timestamptz
);
ALTER TABLE operational_lessons ADD COLUMN IF NOT EXISTS lesson_version integer NOT NULL DEFAULT 1;
ALTER TABLE operational_lessons ADD COLUMN IF NOT EXISTS baseline_failed integer NOT NULL DEFAULT 0;
ALTER TABLE operational_lessons ADD COLUMN IF NOT EXISTS baseline_observed integer NOT NULL DEFAULT 0;
ALTER TABLE operational_lessons ADD COLUMN IF NOT EXISTS outcome_passed integer NOT NULL DEFAULT 0;
ALTER TABLE operational_lessons ADD COLUMN IF NOT EXISTS outcome_observed integer NOT NULL DEFAULT 0;
ALTER TABLE operational_lessons DROP CONSTRAINT IF EXISTS operational_lessons_repository_cohort_from_check_id_strategy_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS operational_lessons_version_idx
  ON operational_lessons(repository, cohort, from_check_id, strategy_id, lesson_version);
CREATE INDEX IF NOT EXISTS operational_lessons_lookup_idx ON operational_lessons(repository, cohort, status);

CREATE TABLE IF NOT EXISTS operational_lesson_events (
  id bigserial PRIMARY KEY,
  lesson_id uuid NOT NULL REFERENCES operational_lessons(id),
  lesson_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('candidate','promoted','withdrawn')),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lesson_id, state)
);
