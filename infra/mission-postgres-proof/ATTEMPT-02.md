# Proof attempt 02 — database hostname resolution

- Candidate: source manifest `c418a11e1e616eda7d1005c45a317082013d2c9923883f9dd58ed92bf414b287`, PostgreSQL proof bundle manifest `5840ff1f91c4c4c9b2757a24e2956ffb9fadc693662d59e6b86a8ad0ffb6de97`.
- Result: harness printed `POSTGRES_MISSION_PROOF=FAIL stage=connect details_suppressed=true` (exit 1). A separate credential-safe connection diagnostic printed only `postgres_connect=failed code=EAI_AGAIN name=Error`; Docker's embedded DNS lookup of the database container name was unavailable from this `runsc` test container.
- No database password, SQL parameters, stack trace, or driver message was emitted. No production or Hostinger database was involved.
- Repair: retain the internal-only network and use the database's inspected private address `172.19.0.2` via the nonsecret test-only variable `ORLOOM_PG_HOST`. It connected successfully and the same frozen-candidate proof passed. Product source and schema were not changed for this runtime-specific test route.
