CREATE TABLE IF NOT EXISTS mission_integration_intents (
  mission_id uuid NOT NULL REFERENCES missions(id),
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[a-f0-9]{40}$'),
  certificate_ids jsonb NOT NULL CHECK (jsonb_typeof(certificate_ids)='array'),
  certificate_digests jsonb NOT NULL CHECK (jsonb_typeof(certificate_digests)='array'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending','integrated','unknown')),
  observed_integration_sha text CHECK (observed_integration_sha IS NULL OR observed_integration_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id,slice_id,lease_epoch)
);
CREATE INDEX IF NOT EXISTS mission_integration_intents_state_idx ON mission_integration_intents(state,updated_at);
