# FLW integration packet — local source reconciliation

Issued 2026-10-16. Repository `C:/Users/nrsan/Nucleus/02_Projects/Orloom-live`, branch `feat/first-live-workflow`, current base `15e312d5bf7e1484514a769413e83549340cd703`; integrate current fetched `origin/main` `8a910f0bf58bbe9db457cb971996a9b2bba32101`. Preserve the existing dirty FLW worker-input/verifier repairs and all canonical harness/UI intent.

## Objective and owned files

Freeze a locally integrated source candidate that contains the current mainline and both existing bounded FLW repairs. First preserve the complete tracked binary diff and all untracked non-secret owned files under `C:/Users/nrsan/Nucleus/02_Projects/Orloom/live-workflow-evidence/resume-20261016`. Then record the pre-integration work as a local preservation commit, integrate `origin/main` serially, resolve only direct content conflicts required by mainline UI changes, and record a final local integration commit. No push.

Expected pre-existing edits: `.agent/WORK_GRAPH.md`, `apps/worker/src/docker-runtime.ts`, `apps/worker/src/main.ts`, `infra/verifier-isolation/launch-verifier.sh`, `packages/verification/src/policy.ts`, `packages/verification/src/repository.ts`, `tests/approved-worker-startup.test.ts`, `tests/verification-runner.test.ts`, `tests/worker-execution-input.test.ts`; FLW packet/checkpoint/completion artifacts under `.agent/`. Add this packet and a concise checkpoint after preservation.

## Invariants and exclusions

Do not discard or rewrite existing repairs; do not change ForestBrass or canonical harness intent. Do not alter provider, verifier, admission, integration, delivery, database, credentials, budgets, host/runtime state or deployment. No provider/storage/host operation, external write, GitHub merge, or push. Tests/build output are local and must not be committed. If reconciliation needs a material behavior or schema decision beyond a direct UI conflict, stop with evidence and a bounded escalation recommendation.

## Acceptance and handoff

Preservation folder contains `tracked-diff.patch`, pre-mutation status, and copies of every untracked non-secret file. Final candidate is a local commit atop the integrated mainline; provide exact HEAD/tree, parent/base relationship, clean/dirty status, changed-file summary, preservation patch SHA-256, validation commands/exit codes, and platform limitations. Run `npm run build`, `npm run typecheck`, `npm run validate`, and focused Windows-safe worker-projection/archive regressions. Windows skipping the POSIX archive extraction behavior remains an open Linux controller gate. Independent review, Linux full suite, genuine runsc and all live workflow gates remain controller-owned and pending.
