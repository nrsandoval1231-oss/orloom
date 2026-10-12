CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  repository text NOT NULL CHECK (length(repository) BETWEEN 1 AND 256),
  task text NOT NULL CHECK (length(task) BETWEEN 1 AND 20000),
  status text NOT NULL CHECK (status IN ('queued','leased','running','succeeded','failed','unknown')),
  lease_token text,
  lease_expires_at timestamptz,
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('leased','running')) = (lease_token IS NOT NULL)),
  CHECK ((status IN ('leased','running')) = (lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
