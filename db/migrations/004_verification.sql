CREATE TABLE IF NOT EXISTS verification_attempts (
  attempt_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  check_id text NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  capability_hash text NOT NULL CHECK (capability_hash ~ '^[a-f0-9]{64}$'),
  capability_expires_at timestamptz NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  outcome text CHECK (outcome IN ('pass','fail','unknown')),
  receipt jsonb,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mission_id,slice_id) REFERENCES mission_slices(mission_id,id)
  ,UNIQUE (mission_id,slice_id,lease_epoch,check_id)
);
CREATE INDEX IF NOT EXISTS verification_attempts_open_idx ON verification_attempts(capability_expires_at) WHERE terminal_at IS NULL;
CREATE TABLE IF NOT EXISTS check_certificates (
  certificate_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES verification_attempts(attempt_id),
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  check_id text NOT NULL,
  certificate jsonb NOT NULL CHECK (jsonb_typeof(certificate)='object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  head_observed_at timestamptz NOT NULL,
  head_observation_digest text NOT NULL CHECK (head_observation_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mission_id,slice_id) REFERENCES mission_slices(mission_id,id),
  UNIQUE (mission_id,slice_id,check_id)
);

ALTER TABLE mission_slices ADD COLUMN IF NOT EXISTS verification_policy_digest text;
CREATE TABLE IF NOT EXISTS verification_dispatch_failures (
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  check_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('candidate_unavailable','local_head_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id,slice_id,lease_epoch,check_id),
  FOREIGN KEY (mission_id,slice_id) REFERENCES mission_slices(mission_id,id)
);
