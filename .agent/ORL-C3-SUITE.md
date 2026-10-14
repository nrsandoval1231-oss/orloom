# ORL-C3-SUITE — one trusted offline repository suite

READY after independently accepted bounded C3 syntax source `765943e`. Base/evidence head: `226e4d9ac26f2b83b05b82f678dc07966a1b6bdb`. Worktree: `work/orloom-suite`; branch: `feat/trusted-verification-suite`. Parent mission is the revised canonical Orloom directive. Sol's approved direction is `.agent/ORL-C3-SUITE-DIRECTION.md`.

## Objective and scope

Add one finite, versioned `node-repo-suite-v1` policy using the existing runner, private capability, durable evidence and certificate path. Preserve the existing syntax policy's meaning. Keep every certification `local-exact-commit`. This is not lesson promotion, integration or full product acceptance.

One Luna owns `packages/verification/src/`, `apps/verifier/src/index.ts`, `apps/control-plane/src/main.ts` and `packages/config/src/config.ts` only for trusted operator policy selection, `infra/verifier-isolation/`, `tests/verification-*.test.ts`, `.env.example`, `docs/verification.md`, and README verification wording. A small trusted dependency/security manifest may be added inside the verifier isolation directory. Builder completion goes in `.agent/ORL-C3-SUITE-COMPLETION.json`. Controller owns all other `.agent` files and integration. No dependency version, package.json or package-lock mutation without a bounded replan.

Exclude frozen PR #2 and its broker/worker launcher; all other worktrees; contracts, Governor authorization/certification semantics and SQL migrations; learning/recovery/Jev authority; credentials, provider calls/spend; remote hosts, deployment, R2 and GitHub mutations. No commit, push, merge or host execution by builder. Do not revert another contributor's work.

## Invariants

- Trusted image owns fixed argv, stage order, time/output/resource limits and pass criteria. Never run npm scripts, npx, install lifecycle scripts, worker commands or arbitrary operator command strings.
- Admit an exact operator-reviewed package.json/package-lock byte digest pair. Build a read-only dependency tree from those exact bytes with lock integrity and ignore lifecycle scripts. Do not copy credentials or a mutable desktop cache. Candidate package/lock mismatch, node_modules or dependency/config overrides fail closed. Runtime has no network.
- Run direct TypeScript typecheck, clean build, Node tests, foundation validation and a narrowly described offline security/integrity policy. Require nonempty tests and every stage. No live vulnerability-audit claim without an actual pinned advisory dataset.
- Preserve runsc, nonroot, read-only root, no credentials/network/host source mounts, host-wide flock, durable creation intent and exact-ID reconciliation. Candidate code/output is untrusted and cannot emit the trusted parent verdict or alter policy.
- Existing coordinator deadline is 60 seconds. Keep suite total budget within it; no silent extension of Governor deadlines. Proposed profile is at most one verifier, 1 CPU, 1 GiB memory and bounded /work tmpfs, subject to root measured host acceptance. Timeout, missing/truncated stage, ambiguous process result or cleanup failure is UNKNOWN. Ordinary completed stage failure is FAIL.
- Bind policy, stage/tool/dependency manifest, resource profile and image identity to evidence. A changed commit/ref/policy/image cannot reuse certification. No reserved budgets/scopes or dependencies released and no lesson promoted.

## Validation and handoff

Develop focused behavioral tests for selection authority, lock/config admission, trusted argv, nonempty test selection, stage failure/timeout/truncation, exact input and stale binding behavior. Mocks prove deterministic boundary behavior only. Use controlled real local fixtures for stage execution where feasible; never label local execution cloud proof.

Builder runs installation with scripts disabled, typecheck, build, repository tests, validate and diff checks once on frozen implementation plus explanatory docs. Preserve failures and use at most two materially different local repairs; then return the specific constraint. Root reruns required gates, freezes exact candidate, obtains independent review, and separately performs real existing-host runsc/PostgreSQL positive and negative proof. No image/host action before root script review.

Completion artifact: changed files, exact base and candidate tree, commands/exits and raw log path, unresolved risks, no-source-readiness overclaim, UTC start/finish, measured durations or UNKNOWN, repair count, model/config identity and tokens UNKNOWN unless measured. Follow skill agent-harness. No nested agents. Stop only at bounded handoff or a real dependency requiring replan, not after interfaces or a plan.
