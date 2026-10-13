# ORL-C3-RESOURCE-001 - Suite resource profile trial

Status: implementation complete; pending controller freeze and independent source review.
Repository: `work/orloom-suite`; branch `feat/trusted-verification-suite`.
Base SHA: `890209224cd042f5367085ffdf5591b3aa92d739` (verified clean at dispatch).

## Objective

Version the repository-suite policy for a 2 GiB memory and equal memory-swap trial allocation, and bind that exact profile into the launcher and suite digest. Preserve the syntax-only policy at 256 MiB. This allocation is a trial, not evidence that the full suite fits or that C3 acceptance passes.

## Changed files owned by this packet

- `packages/verification/src/policy.ts`: suite memory 2,147,483,648 bytes; manifest and policy versions advanced to v4.
- `infra/verifier-isolation/launch-verifier.sh`: only the suite's memory and memory-swap branches changed to `2g`; syntax remains `256m`. Before start, the launcher inspects Docker HostConfig and refuses to run unless exact memory/swap, CPU, PID, network, readonly, user, runtime, capabilities, security, and tmpfs values match the fixed suite or syntax profile.
- `tests/verification-runner.test.ts`: verifies exact 2 GiB policy/version/digest, finite policy allowlist, suite/syntax launcher memory branches, exact inspected-profile expectations and mismatch rejection, plus CPU, PID, network, read-only, UID, capabilities, tmpfs, deadline, stages, and syntax digest constraints.
- `infra/verifier-isolation/README.md` and `docs/verification.md`: describe the trial cap and measurement requirement.
- This packet and `.agent/ORL-C3-RESOURCE-001-COMPLETION.json`.

No migration, package, dependency, test workload, stage, timeout, schema, verifier authority, host resource, or PR #2 changes. Root owns `docs/evidence/c3-suite-jobs/**` and `.agent/CURRENT_STATE.md`; those concurrent changes were preserved. Runtime-helper ownership and host proof remain with the controller/other assigned worker.

## Validation and handoff

Final focused checks passed: `npm run typecheck`; `npm run build`; `node --test dist/tests/verification-runner.test.js` (14 pass, 0 fail, 0 skipped); `bash -n infra/verifier-isolation/launch-verifier.sh`; `git diff --check`.

The old default suite policy digest `51403fa00e34ad51fba34ef8739b7ff09a34ef9a21946ddf40b2f217e9fcad8b` now changes to `12615bff098673e52b4c128d6c556598123d18f9e59ccd1700824d3d97f7c6e8`. Syntax policy digest stays `e94f014eafb1763402f210b4bd0218f3807aa9e6ca74ccaeda988661670c5cbe`. No source manifest or candidate SHA is claimed; the controller regenerates both from staged Git LF after freeze. No cloud, provider, host, runtime proof, or full-suite acceptance was attempted.

The initial focused rerun exposed an over-specific static test expecting `size=512m`; launcher uses a conditional `echo 512m`. The assertion was corrected to verify the actual fixed command branch, and the full focused suite passed afterward. See completion JSON for UTC limitations and exact command results.
