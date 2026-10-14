CREATE TABLE IF NOT EXISTS mission_delivery_intents (
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  state text NOT NULL CHECK (state IN ('pending','check_created','pr_created','unknown')),
  check_run_id text,
  pull_request_number integer,
  observed_remote_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id,slice_id,lease_epoch),
  CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  CHECK (observed_remote_sha IS NULL OR observed_remote_sha ~ '^[a-f0-9]{40}$'),
  CHECK (state NOT IN ('check_created','pr_created') OR check_run_id IS NOT NULL),
  CHECK (state <> 'pr_created' OR pull_request_number IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mission_delivery_intents_state_idx ON mission_delivery_intents(state,updated_at);

-- A claim is permanent once a create request may have escaped the process.
-- Recovery is read-only until the exact external object is observed.
CREATE TABLE IF NOT EXISTS mission_delivery_effects (
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL,
  effect text NOT NULL CHECK (effect IN ('check','pull_request')),
  state text NOT NULL CHECK (state IN ('claimed','observed')),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz,
  PRIMARY KEY (mission_id,slice_id,lease_epoch,effect),
  FOREIGN KEY (mission_id,slice_id,lease_epoch)
    REFERENCES mission_delivery_intents(mission_id,slice_id,lease_epoch),
  CHECK ((state='claimed' AND external_id IS NULL AND observed_at IS NULL)
      OR (state='observed' AND external_id IS NOT NULL AND observed_at IS NOT NULL))
);
