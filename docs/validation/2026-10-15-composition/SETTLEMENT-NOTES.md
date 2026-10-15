# Cancellation settlement evidence

This slice adds the controller-private settlement store seam and an idempotent SQL migration. A runtime lease epoch is bound to the expected run ID, container name, pinned image reference, and ownership-label digest; the container ID is fixed once observed. Settlement accepts only a retained runtime-journal v2 `absent` record whose identity, binding, observation, transition history, and timestamps match that durable binding. An `unknown` record is retained as quarantine. Exact absence can settle a cancelled slice that already reached `awaiting_verification`. When the worker stops before recording any runtime binding, a separate atomic path checks the current lease epoch, cancellation state, `runtime_required=false`, and absence of a binding row before settling. New runtime binding creation is fenced once cancellation starts. Both paths release capacity while preserving the full spend reservation.

No HTTP settlement route was added. The controller bridge is expected to supply entries read from the protected trusted runtime journal; a source string by itself does not pass the persisted-binding and journal-history checks.

## Validation

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `node --test dist/tests/cancellation-settlement.test.js`: PASS, five SQL and memory tests cover mismatch ignored, UNKNOWN quarantine, absence after candidate submission, pre-runtime settlement, idempotency, capacity release, and unchanged spend reservation.
- `node --test dist/tests/cancellation-settlement.test.js dist/tests/runtime-cancellation.test.js`: settlement and 14 runtime cancellation tests passed; two pre-existing loopback HTTP tests could not connect because this Windows sandbox denies `127.0.0.1` sockets (`EACCES`). The full focused output is in [settlement-focused-tests.log](settlement-focused-tests.log).

No real PostgreSQL or Docker/runsc acceptance is claimed by these deterministic PGlite tests.
