# C4-DELIVERY-COMPOSITION-02

## Objective and exact scope

Compose reviewed C4 replay source with the existing C4 delivery path and close review finding DELIVERY-F1. Branch `feat/certified-delivery`, delivery source `bdd8dcdfb445418f3bf5c7326874da1f2937f39c`; incoming replay source `5c71c6bbbecae72d960c6371defb6ec7d2beb4b9` (root-controlled serialized merge). Allowed implementation/test files: `packages/governor/src/governor.ts`, `packages/integration/src/delivery.ts`, `tests/delivery-effects.test.ts`, and `tests/delivery-c4-flow.test.ts`. This packet and its completion record are owned here. Root owns Git integration outside the single Governor conflict resolution, state/manifest/docs and final gates.

## Accepted behavior

- Governor exposes both the delivery command and all C4 completed-replay fences from the incoming source.
- Delivery validates the exact durable integrated intent before accepting `integration:<integratedSha>` and `review:<reviewDigest>` evidence refs. Each marker must occur once and exactly match both the delivery command and persisted intent; all other non-SHA refs fail closed. SHA refs still require content-digest readback from the artifact store.
- Controlled metadata regressions reject duplicate, mismatched, unknown and unreadable refs before any GitHub effect.
- A positive composition test follows mission submit, approved plan, Governor claim/complete, `TrustedCheckCoordinator` persisted final PASS, Governor C4 integration using real local bare Git, then delivery using controlled runner/artifact/GitHub adapters. No direct status/certificate/intent SQL shortcut is used in this path.

## Boundaries

No startup activation, provider calls, credentials, external GitHub/R2, host action, PR2/broker change, migration, or runtime acceptance claim. The control-plane delivery controller remains closed by default; real PostgreSQL multi-connection delivery and external-provider proof remain open. Tests with fixture verification/GitHub/R2 adapters prove source composition only.

## Validation contract

Run `npm run build`, `npm run typecheck`, affected `delivery-*` tests including the C4 flow and replay race tests with `--test-concurrency=1`, and `git diff --check`. Preserve source/test result separately from real operational delivery. Retry budget: two bounded source fixes.
