# C3 suite timeout diagnosis — source `06a74ac`

## Preserved original result

The archived `initial-suite-failure.tar.gz` records the first full-suite attempt as `UNKNOWN`, with no certificate. Its request binds candidate `06a74acfb456b5835cb19dcf71c73fa11f278d0f`, policy digest `c9e58cefd35e4ed09ec8440e35d9377a16b8e9b28cba4b92f11d9c985e01312c`, and image digest `4a8053965426e875897b1435b523e1500f2603e9c7f40603187643702d851d0b`.

The receipt started at `2026-10-13T10:00:04.546Z` and finished at `2026-10-13T10:01:05.460Z`: **60,914 ms**. It has `outcome: "unknown"`, `exitCode: null`, and the empty SHA-256 artifact for both stdout and stderr. `proof-failure.json` reports `UNKNOWN` at the proof assertion; it does not identify an inner suite stage. This attempt must remain immutable evidence; neither a later diagnostic nor a new run reclassifies it.

The archived inspected container confirms the intended profile was applied: `runsc`, no network, no mounts, read-only root, UID/GID 65532, all capabilities dropped, `no-new-privileges`, 1 CPU, 1 GiB memory/swap, 128 PIDs, 512 MiB `/work`, and 16 MiB `/tmp`. Peak CPU and memory are `null`, so they cannot explain the timeout.

## What is known and unknown

`run-repo-suite.js` runs these fixed stages serially: dependency/lock admission, TypeScript typecheck, clean build, test discovery, Node tests, foundation validation, and offline path policy. The archive proves that the complete run did not produce an accepted final result before the fixed deadline. It does **not** prove which of those stages was active.

There are two deadline boundaries at approximately 60 seconds:

1. `launch-verifier.sh` wraps attached `docker start` with `timeout ... 60s`.
2. `LocalRunscLauncher` runs that launcher through Node `execFile` with the policy's 60-second timeout.

The suite buffers every stage's stdout/stderr internally and emits one `ORLOOM-RESULT` marker only after the final stage. `run-check.js` inherits that child output. If the outer process is killed or otherwise ambiguous, `classifyLauncherOutput()` returns an UNKNOWN result with empty buffers even if a partial trusted frame had reached the parent. Therefore the empty receipt is expected from the current ambiguity rule; it is not evidence that no stage began.

Plausible but unproven causes include TypeScript compile/test work taking longer under runsc and the one-CPU limit, test setup with PGlite, container startup/extraction/freeze overhead consuming part of the same 60 seconds, or the closely aligned outer and inner timeouts racing. Do not change limits based on any of these hypotheses.

## Smallest safe next path

Implement a bounded **diagnostic-only protocol change** before any capacity change. Keep the existing suite's 60-second deadline, resource profile, fixed argv, source admission, no-network isolation, and certificate rules unchanged.

1. In the image-owned suite runner, emit a small trusted `ORLOOM-PROGRESS` frame immediately before each fixed stage starts and after it ends. The frame schema is finite: suite version, one catalogued stage name, and `start` or `end`. It contains no candidate stdout/stderr, paths, command arguments, environment values, or operator text. Cap frames and total bytes.
2. In the trusted host classifier, on an otherwise ambiguous result, validate and retain only those bounded frames in the UNKNOWN stdout artifact. Keep `outcome: unknown`, `exitCode: null`, no certificate submission, and no PASS/FAIL derivation. Discard all other output exactly as today. Normal determinate runs still require exactly one valid final result marker and matching clean launcher exit.
3. Add deterministic tests for a timeout after each accepted progress frame, malformed/duplicate/excess frames, candidate-like raw output, and normal final-marker behavior. Tests must prove progress cannot turn UNKNOWN into PASS or FAIL and cannot mint a certificate.
4. Rebuild and bind a new image/policy digest because trusted image bytes and evidence protocol changed. Preserve the old image/policy/receipt unchanged. Run one separately authorized diagnostic attempt against the exact archived candidate and the same 60-second/1-CPU/1-GiB profile. Its only success criterion is a bounded last trusted stage frame in an UNKNOWN receipt; it is not a certification attempt and must not be automatically retried.

This is smaller and more reliable than raising the deadline first: it preserves the exact original boundary while providing the missing fact needed to choose a later fix. It needs a bounded implementation packet covering the suite runner, host classifier, policy/image binding, and focused tests; it is not a host action in this diagnosis.

## Alternative with no product-source change

If the controller does not want to change the trusted protocol before diagnosis, use a separately authorized, same-image `runsc` diagnostic harness outside the coordinator and database. It must admit the archived manifest bytes, use the exact image digest and the same isolation/resource profile, and run only a finite hard-coded sequence of the image's existing setup plus one fixed stage per container. It records elapsed time and exit classification in a separate diagnostic evidence directory and has no capability, certificate route, or access to production artifacts.

This can locate a slow stage without reusing the original attempt, but it is less faithful to cumulative in-container timing and repeats startup/setup for each stage. It should be chosen only if the controller wants zero product-source changes before the next host-proof window.

## Decision

Do not raise the 60-second limit or alter resource caps now. Prefer the bounded trusted progress-frame repair, then run one separately authorized diagnostic attempt with the same profile. If that is deferred, use the isolated same-image stage harness and record its limitation. In both paths, the original attempt remains `UNKNOWN`, and no certificate or completion claim follows from diagnosis alone.
