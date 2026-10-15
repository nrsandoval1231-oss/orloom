-- Slice 1b: durable authenticated owner cancellation.
--
-- postgres-store.ts re-executes every migration file on every startup, so the
-- whole file must be idempotent. Only the owner cancellation substrate is
-- introduced here; worker runtime bindings belong to a later slice.
--
-- The columns below are the claim-scoped runtime identity a later slice writes;
-- they are added here because the cancellation fence accounts for them.
ALTER TABLE mission_slices ADD COLUMN IF NOT EXISTS controller_run_id text;
ALTER TABLE mission_slices ADD COLUMN IF NOT EXISTS runtime_required boolean NOT NULL DEFAULT false;

ALTER TABLE missions DROP CONSTRAINT IF EXISTS missions_status_check;
ALTER TABLE missions ADD CONSTRAINT missions_status_check
  CHECK (status IN ('planning','ready','running','awaiting_verification','verified','blocked','unknown','cancelling','cancelled'));

ALTER TABLE mission_slices DROP CONSTRAINT IF EXISTS mission_slices_status_check;
ALTER TABLE mission_slices ADD CONSTRAINT mission_slices_status_check
  CHECK (status IN ('waiting_dependency','blocked','ready','running','awaiting_verification','verified','failed','unknown','cancel_requested','cancelled'));

-- A cancellation request retains the lease proof for the lease it is fencing:
-- the cancellation poll needs the exact epoch/token binding, and clearing the
-- columns would silently refund the reserved spend. Every productive lease
-- operation still requires `running`, so retention grants no new authority.
ALTER TABLE mission_slices DROP CONSTRAINT IF EXISTS mission_slices_check;
ALTER TABLE mission_slices ADD CONSTRAINT mission_slices_check
  CHECK ((status IN ('running','cancel_requested')) = (lease_token_hash IS NOT NULL AND capability_hash IS NOT NULL AND lease_expires_at IS NOT NULL));

CREATE TABLE IF NOT EXISTS mission_cancellations (
  mission_id uuid PRIMARY KEY REFERENCES missions(id),
  owner_request_id text NOT NULL,
  reason text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
-- Owner request ids are scoped to their mission by the primary key above. A
-- global uniqueness rule would reject a legitimate id reused on another mission
-- with a raw constraint error, and the store already refuses a competing id for
-- the same mission. Drop the constraint if an earlier build created it.
ALTER TABLE mission_cancellations DROP CONSTRAINT IF EXISTS mission_cancellations_owner_request_id_key;
