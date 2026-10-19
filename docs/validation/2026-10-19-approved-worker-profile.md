# Approved worker execution profile validation

At base `6d9ded07088079da88ed0b43dbc1249e26aac2cd`, the validated repository execution profile was passed to the reconciliation runtime but omitted from the runtime options used by `runApprovedDockerWorkerLane`. `main.ts` now builds one shallow-frozen options snapshot through `approvedRuntimeOptions` and supplies it to both runtime constructions. The focused test exercises that production composition seam for both configured and absent profiles and checks the snapshot preserves the image, installation ID, and injected adapter references. The adapters themselves are not deep-frozen.

The regression was run before the fix and failed as expected: configured profile was `undefined` instead of `orloom-execution-v1`; the absent-profile assertion passed. After the fix both tests passed.

Validation used Node `v24.15.0` from WSL and the TypeScript compiler/dependencies already present in the independent Linux inspection checkout, exposed temporarily through a symlink for module resolution. The symlink was removed afterward; that inspection checkout was not modified.

- TypeScript build/typecheck: `tsc --pretty false` — PASS.
- `node scripts/validate.mjs` — PASS.
- `node --test dist/tests/approved-worker-runtime-options.test.js` — PASS (2/2).
- Existing `approved-worker-startup.test.js` was also attempted on the Windows-mounted checkout and its private-file fixture failed platform path/ownership validation (7/8 tests passed); this environmental failure is outside this change and the controller's Linux baseline remains authoritative.
- `git diff --check` — PASS.

No runtime activation, Docker access, secret read, provider call, external write, or spend was performed. Full Linux gates and independent review remain with the controller.
