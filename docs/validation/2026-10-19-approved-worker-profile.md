# Approved worker execution profile validation

At base `6d9ded07088079da88ed0b43dbc1249e26aac2cd`, the validated repository execution profile was passed to the reconciliation runtime but omitted from the runtime options used by `runApprovedDockerWorkerLane`. `main.ts` now builds one shallow-frozen options snapshot through `approvedRuntimeOptions` and supplies it to both runtime constructions. The focused test exercises that production composition seam for both configured and absent profiles and checks the snapshot preserves the image, installation ID, and injected adapter references. The adapters themselves are not deep-frozen.

The regression was run before the fix and failed as expected: configured profile was `undefined` instead of `orloom-execution-v1`; the absent-profile assertion passed. After the fix both tests passed.

Independent review then returned FIX because the initial helper-only test did not exercise the executing lane wiring. `main.ts` now consumes `createApprovedRuntimeComposition`, which constructs the reconciliation runtime and owns the production execute-lane closure. The focused test invokes that factory with an inert lane executor and captures the options passed by the actual closure. A deliberate omission in that closure reproduced the wiring failure (2/2 failed on reference identity, with the configured lane options missing the profile); restoring the shared snapshot made both configured and absent-profile tests pass (2/2).

Validation used Node `v24.15.0` from WSL and the TypeScript compiler/dependencies already present in the independent Linux inspection checkout, exposed temporarily through a symlink for module resolution. The symlink was removed afterward; that inspection checkout was not modified.

- TypeScript build/typecheck: `tsc --pretty false` — PASS.
- `node scripts/validate.mjs` — PASS.
- `node --test dist/tests/approved-worker-runtime-options.test.js` — PASS (2/2).
- Existing `approved-worker-startup.test.js` was also attempted on the Windows-mounted checkout and its private-file fixture failed platform path/ownership validation (7/8 tests passed); this environmental failure is outside this change and the controller's Linux baseline remains authoritative.
- `git diff --check` — PASS.

No runtime activation, Docker access, secret read, provider call, external write, or spend was performed. The composition repair awaits independent review; full Linux gates remain with the controller.

## Separate accepted profile source checkpoint

Controller-frozen a80f2e75cf1388bde232915d4d1a68c4e5b05dd4, tree988b11adda9a26f87c3b6b884bcd5a2e6a88164b, passed fresh detached Node24.15 locked install/typecheck/test/build/validate/diff gates:402tests,401pass,0fail,1operational host-ownership skip. Independent Sol review returned PASS for that bounded source and plan. The original controller receipt/log/review are retained in the19October inspection evidence package. This historical acceptance excludes every later combined source, runtime image, deployment and provider outcome.
