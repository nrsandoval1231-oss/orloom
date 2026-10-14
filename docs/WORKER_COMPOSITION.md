# Worker broker composition, October 14, 2026

Worker PR #19 merged PR #2 source `639bff0759870d3522ae38d2887b75fe6c4297c7` onto the independently repaired PR #18 baseline. Its merge commit is `d99b26ec828495b7648179a144bc4e38f5c5f80c`, preserving reviewed tree `6f538b0690f673d49752fa90bb1b123762b97cfe`. The [worker validation ledger](validation/2026-10-14-worker-composition.md) records its separate 188-test source acceptance. It does not claim an operational autonomous product.

## Preserved components

The source manifest records Git blob identities for twelve unmodified broker/runtime/checkout/test files. The PR2 executable is preserved as `apps/worker/src/broker-main.ts`. PR17's delivery APIs, current dependencies, build packaging, verification authority and stores remain intact. Only PR2's contents-read-only checkout-token method is added to the existing GitHub adapter. The five original PR2 worker/checkout test files are retained.

PR #2 was closed as superseded only after source/evidence preservation was verified. Its original `work/worker-runtime-proof/` records, archival state and historical checkpoint documents remain preserved. Those records are not evidence for this successor. Do not copy their live-proof verdicts onto the containing candidate; no branch deletion is part of this composition.

## Executable boundary

`node dist/apps/worker/src/main.js` exits 1 before loading secrets or claiming work. There is no environment-variable acceptance bypass. The preserved broker-main file is historical executable source, not an approved runtime entrypoint. It must not be launched until the following integration gaps are implemented and reviewed.

1. The controller-owned candidate-admission source now connects a persisted, capability-fenced final candidate bundle to a private, independently inspected verifier object store. It validates artifact/index hashes, immutable mission/slice/epoch/base/candidate/scope bindings and source manifest, without moving the approved base ref. See [verification boundaries](verification.md#controller-owned-candidate-admission-source). It is dependency-injected only and is not wired into normal startup. This closes the bounded source-import gap only; an R2 artifact by itself is never a trusted pass, and live artifact transport and composed runtime proof remain open.
2. PR2's R2WorkerProgressSink records builder telemetry and returns CONTINUE. It does not authorize recovery. PR17's progress route accepts trusted-check evidence and rejects generic provider telemetry. The new HttpRecoveryControlPlane provides a separately typed real HTTP transport for recovery policy and progress; it is tested but not automatically connected to the broker loop. Builder-local run_check results never become trusted passes.
3. Interrupting a broker can leave unresolved provider effects and capacity quarantine. Owner cancellation, durable exact-container reconciliation, conservative spend accounting and safe capacity release are not implemented. Timeout or process exit must never silently refund budget/requeue work. The preserved poll loop checks shutdown before claim, so an in-flight claim resolving after shutdown still begins execution; SIGTERM drains active executeLease calls rather than propagating cancellation. Both require explicit interruption regressions before activation.
4. Normal controller startup still uses deterministic judgment/scheduling fallback. Independent adversarial review and a one-mission fully composed delivery proof remain separate acceptance requirements.

## Evidence interpretation

Existing broker tests use real loopback HTTP and local Git fixtures with synthetic provider/workspace implementations. They establish candidate submission to awaiting_verification, scoped checkout and bundle behavior, cleanup failure→UNKNOWN, bounded concurrency, and no blind retry. The new recovery test invokes the actual Governor over loopback HTTP and verifies nonterminal progress/replay and rejection of forged terminal progress. It does not claim trusted pass certification, an independent reviewer, Docker/runsc execution, live providers, real PostgreSQL deployment or successful GitHub delivery.

See `superpowers/plans/2026-10-14-worker-composition.md` for candidate-admission, recovery and cancellation acceptance tests. The seven independent audit repairs were merged through PR #18; their original validation ledger remains unchanged.

Package scripts and dependency admission pins are unchanged. Use the direct worker command above for the startup-refusal check; the historical broker entrypoint remains unaccepted.

