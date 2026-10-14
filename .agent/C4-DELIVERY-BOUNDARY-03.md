# C4-DELIVERY-BOUNDARY-03

## Objective

Repair only the failing GitHub adapter boundary assertion on exact source `21a90dfa7b1123c12b8f7d2e7739049472accd8f`, branch `feat/certified-delivery`. The independent review `work/delivery-source-review-21a90df.json` found one config-adapter test failure: Check creation now mints a scoped token before calling the installation-bound client.

## Scope and proof

Only `tests/config-adapters.test.ts` plus this packet and its completion artifact. The test asserts the Check operation mints for installation 44, repository `repo`, and `{contents: read, checks: write}`; the exact scoped token is bound to installation 44; the Check POST then executes through that client with owner/repository/head SHA. It also retains the general token scope assertion and verifies invalid repository input causes no token request.

No product-source changes, credentials, network calls, external/provider actions, commits, pushes, merges, or root-owned evidence/manifest changes. Test-double adapter-boundary behavior is not live SDK or GitHub acceptance.

## Validation

`npm run typecheck`; `npm run build`; `node --test dist/tests/config-adapters.test.js dist/tests/delivery-adapter.test.js`; `git diff --check`. Root owns final exact-candidate gates and independent rereview.
