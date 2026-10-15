-- Controller-owned cancellation runtime bindings and settlement evidence.
-- Bindings are immutable for one lease epoch; UNKNOWN remains quarantined.
CREATE TABLE IF NOT EXISTS cancellation_runtime_bindings (
  mission_id uuid NOT NULL,
  slice_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  controller_run_id text NOT NULL CHECK (controller_run_id ~ '^[a-f0-9]{64}$'),
  runtime_name text NOT NULL CHECK (runtime_name ~ '^[a-z0-9][a-z0-9_.-]{0,127}$'),
  image_ref text NOT NULL CHECK (image_ref ~* '^(ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:|sha256:)[a-f0-9]{64}$'),
  labels_digest text NOT NULL CHECK (labels_digest ~ '^[a-f0-9]{64}$'),
  container_id text CHECK (container_id ~ '^[a-f0-9]{64}$'),
  reconciliation_state text NOT NULL DEFAULT 'pending' CHECK (reconciliation_state IN ('pending','unknown','absent')),
  reconciliation_evidence jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id,slice_id,lease_epoch),
  FOREIGN KEY (mission_id,slice_id) REFERENCES mission_slices(mission_id,id),
  CHECK ((reconciliation_state='pending') = (reconciliation_evidence IS NULL))
);
