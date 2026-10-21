# ORL-20261019-V10 — combine accepted runtime profile and recovered v10

State: READY. Independent Sol packet review approved2026-10-19; one Luna, full lane.
Owner directly authorizes combining, validating and reviewing this exact successor,
then advancing the next safe step toward a real verified draft PR.

Repository: nrsandoval1231-oss/orloom. Local branch feat/combined-v10-profile.
Accepted starting commit a80f2e75cf1388bde232915d4d1a68c4e5b05dd4,
tree988b11adda9a26f87c3b6b884bcd5a2e6a88164b. Recovered merge input
dfc06fd09f76eb20b163f0d7aaff1e0b91182b31,
tree7676f873bb75f184fbf468ba4e3b183feca15343, ref recovered/v10-dfc06fd.
Shared ancestor6d9ded07088079da88ed0b43dbc1249e26aac2cd. Remote PR32 and main
remain6d9ded0 and8a910f0 as rechecked2026-10-19T16:42UTC.

## Objective, dependencies and invariants

Combine the existing changes, not a new timeout design. Preserve shared frozen
runtime composition and its production-lane regression from a80f2e7, plus all
v10 deadline guards, leased-local-check availability/intersection, owner-HTTP
cancellation regression and tests from dfc06fd. Canonical ADR0002 governs the finite
1800/1830/1845/1860-second chain and2100-second absolute ceiling. Syntax stays60s;
image binding, all stages/tests/resources/isolation, UNKNOWN quarantine and
owner-controlled side effects are unchanged. No broader source redesign.

## Exclusive builder ownership

Luna owns integration conflict resolution for precisely the files changed in
6d9ded0..dfc06fd, plus apps/worker/src/approved-runtime-options.ts and
tests/approved-worker-runtime-options.test.ts if needed to preserve the accepted
assembly. Existing source plan and source-repair validation doc must survive.
.agent/CURRENT_STATE.md and WORK_GRAPH.md may be reconciled to current source truth;
archive prior bytes unchanged before replacing. Add only this packet's
.agent/ORL_20261019_COMBINED_V10_COMPLETION.json and
docs/validation/2026-10-19-combined-v10.md for the new handoff.

You are not alone in the workspace. Do not revert other edits. Controller owns
operational scripts/evidence and final freeze. Preserve both branch histories.
Use git merge --no-commit --no-ff recovered/v10-dfc06fd; resolve to the smallest
combined result. Do not commit; return the staged/unstaged integration for controller
freeze. If merge cannot start due the new packet, stage that packet only first.

Independent merge constraint: main.ts retains createApprovedRuntimeComposition and
runtimeComposition.executeLane while applying v10 checkCommands subset validation
and checks:Object.fromEntries(Object.keys(checks)...). Do not restore v10's raw
runtimeOptions literal or require every trusted final check as a worker-local command.

Exclusions: no other repos, secret reads, credentials, new migration/schema,
policy beyond the preserved ADR, provider calls, Docker or host changes, external
writes, push, merge on GitHub, deployment, activation or spend.

## Acceptance and deterministic validation

1. Exact preserved v10 behavior and runtime profile assembly coexist; no original
source/evidence disappears and historical failures remain distinguishable.
2. Focused compilation/typecheck, structure validation, profile composition,
optional local checks, owner-HTTP cancellation, finite request/coordinator/runner
lifetimes and relevant startup/certification regressions pass on native Linux.
3. Source/doc status describes pending runtime proof; no old acceptance is
transferred to this combined candidate. Current state stays below500words.
4. Controller freezes one commit/tree and reruns npm ci, typecheck, npm test,
build, validate, shell/JS syntax and diff checks from a detached native Linux
clone. Full suite must have zero failures and no unexplained new skips.
5. After builder release, independent Sol review binds the exact combined commit,
ADR/invariants, all diff and gate output. Any FIX requires bounded repair,
fresh freeze/gates/review. Genuine runsc/image/deployment/provider gates stay OPEN.

Retry budget: two materially different repairs. Record exact merge conflicts,
resolution rationale, changed files, commands/exits, UTC start/finish, measured
durations versus UNKNOWN, repair count, role/config/token UNKNOWNs and explicit
runtime limits in completion JSON. Do not grade your work or promote graph state.

Available Linux tooling: WSL Ubuntu, Node24.15 at
/home/nrsan/.cache/orloom-flw-25533/node-v24.15.0-linux-x64/bin.
Use a separate native Linux focused-validation clone/staging under a new private
user cache path; do not mutate earlier exact-candidate clones or dependencies.
