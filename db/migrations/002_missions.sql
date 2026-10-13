CREATE TABLE IF NOT EXISTS missions (
  id uuid PRIMARY KEY,
  repository text NOT NULL,
  base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-fA-F]{40}$'),
  objective text NOT NULL,
  acceptance jsonb NOT NULL CHECK (jsonb_typeof(acceptance)='array' AND jsonb_array_length(acceptance)>0),
  budget_cents bigint NOT NULL CHECK (budget_cents>0),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents>=0),
  status text NOT NULL CHECK (status IN ('planning','ready','running','awaiting_verification','verified','blocked','unknown')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mission_plans (
  mission_id uuid PRIMARY KEY REFERENCES missions(id),
  slices jsonb NOT NULL CHECK (jsonb_typeof(slices)='array'),
  recommended_by text NOT NULL,
  recommended_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);
CREATE TABLE IF NOT EXISTS mission_slices (
  mission_id uuid NOT NULL REFERENCES missions(id),
  id text NOT NULL,
  objective text NOT NULL,
  dependencies jsonb NOT NULL,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 128 AND owner !~ '[[:cntrl:]]'),
  scopes jsonb NOT NULL,
  checks jsonb NOT NULL,
  budget_cents bigint NOT NULL CHECK (budget_cents>=0),
  status text NOT NULL CHECK (status IN ('waiting_dependency','blocked','ready','running','awaiting_verification','verified','failed','unknown')),
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_token_hash text,
  capability_hash text,
  lease_expires_at timestamptz,
  candidate_sha text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  capacity_slot integer,
  PRIMARY KEY (mission_id,id),
  CHECK ((status='running') = (lease_token_hash IS NOT NULL AND capability_hash IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mission_slices_claim_idx ON mission_slices(status,owner,mission_id);
CREATE TABLE IF NOT EXISTS mission_events (
  cursor bigserial PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES missions(id),
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_events_replay_idx ON mission_events(mission_id,cursor);
CREATE TABLE IF NOT EXISTS mission_governor_lock (lock_id integer PRIMARY KEY CHECK (lock_id=1));
INSERT INTO mission_governor_lock(lock_id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS capacity_slots (
  slot_id integer PRIMARY KEY CHECK (slot_id BETWEEN 1 AND 6),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-fA-F0-9]{64}$'),
  evidence_expires_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  configured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_slices_capacity_slot_idx ON mission_slices(capacity_slot) WHERE status='running';
