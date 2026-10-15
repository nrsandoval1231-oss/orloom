# Orloom current state

Updated 2026-10-15 UTC. Canonical authority: [CANONICAL_HARNESS](../docs/architecture/CANONICAL_HARNESS.md) and latest owner instruction. Product completion remains OPEN.

Baseline main `eed0a9264ec2b5c64f59a247a4aa6be93e3677e4`, tree `6666a4b575e6fc412b0a165eebbde720f1a83423`. Active isolated branch: `feat/approved-worker-composition`. [Packet](APPROVED_COMPOSITION_PACKET.md), [graph](WORK_GRAPH.md), [acceptance ledger](../docs/validation/2026-10-15-approved-composition.md). Previous state and graph bytes are archived unchanged under `.agent/archive/2026-10-15-before-approved-composition-*`.

This candidate composes protected admission into explicitly configured verifier startup, adds the trusted in-process one-approved-slice Docker execution API and controller-private cancellation settlement. Lease content/credentials are validated before builder work. Existing executeLease, candidate importer, independent verifier and Loom remain authoritative. Cancellation before runtime launch or after candidate submission can settle conservatively; UNKNOWN retains quarantine and all reserved spend. Terminal journal evidence supports restart settlement replay.

Independent review returned FIX, then PASS for the repaired bounded source. Final build/typecheck/validate passed; Linux Node 24.22.0 serial suite: 285/287 pass, zero failures, two existing skips, 125907 ms. Actual PostgreSQL 18 fresh database/two-pool proof passed. The 126-entry final source manifest has zero mismatches after the suite; see exact evidence in the ledger.

Normal worker main remains disabled. The generic lane is an injectable fixture/source seam; the concrete wrapper constructs DockerWorkerRuntime with the trusted journal bridge. No provider execution, operational deployment, runsc image acceptance, real R2/App publication or autonomous verified PR is established. If SQL intent persists but trusted file intent cannot be written, automatic settlement remains quarantined for operator recovery. Spend is not refunded without authoritative billing evidence.

Next action: publish the focused branch and review PR, then obtain independent publication review before any merge or release. Do not merge or deploy.

Remaining product gates: operational startup/restart ownership; secure provider/App/R2 configuration and bounded spending; owner target task/base/scopes/checks; Sol planning; multiple isolated productive lanes; bounded checkpoint recovery; lesson activation and measured fresh-task benefits; exact-candidate runsc final checks; real UI execution/recovery controls; operational delivery and release authority. Existing deployed UI/version is unchanged and unknown. Fixtures are not live evidence.

