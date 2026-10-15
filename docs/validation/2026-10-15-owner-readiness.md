# Owner readiness and durable recovery inspector

Bounded source successor to independently accepted PR26 `9347c1701c8f18ea7e5b037695b88f584a747473`, stacked on its branch. PR25 and PR26 remain frozen and unmerged. Owner authorization: truthful readiness, cancellation state and durable recovery events in the existing canonical UI, synthetic browser and backend validation. No live site, runtime, credential, provider, host/security, deployment or merge changes.

The existing Loom inspector gains configuration/evidence readiness and current-epoch cancellation details. The connection badge describes an evidence connection. A ready result means only the stated control-plane prerequisites; live worker, runtime, provider and image acceptance remain unverified. Readiness reads actual configuration and configured authorities without secret reads, probes, claims or execution. Cancellation comes from existing durable state/events and never grants release, refund or retry authority. Recovery/delivery references remain in the existing event record. Stale or inconsistent evidence cannot establish readiness or completion.

## Acceptance ledger

| Gate | Evidence / scope |
|---|---|
| Existing layout and aesthetic | Same weave, camera, fallback, responsive inspector and typography; only inspector content and truthful connection wording change. |
| Owner access | Existing cookie/session boundary; focused HTTP/browser authentication tests pass; reads append no events. |
| Durable reconstruction | Memory and PGlite tests pass. Actual isolated PostgreSQL with two connections and two HTTP restarts passes expired UNKNOWN and leased no-runtime cancellation reconstruction, preserving the 100-cent reservation. Epoch-zero SQL unit case separately proves direct cancellation tombstone reconstruction. |
| Browser | Final synthetic real loopback HTTP/store/browser proof PASS. Default unverified, synthetic prerequisites ready with live execution unverified, unauthenticated/offline unavailable, owner cancellation, pre-runtime settlement, bound UNKNOWN, fresh server/context, reconnect consistency, desktop/mobile and zero horizontal overflow. Screenshots and result JSON retained. No live worker/provider/verification/delivery. |
| Source gates | Build/typecheck/validate PASS; focused Linux 24/24 PASS. Final serial Linux suite and post-run hash reconciliation pending. |
| Independent review | Bounded source review PASS, no confirmed findings, binds all 146 entries to manifest SHA-256 `1bee384d39ef0ec8aad3df3b42a24060557b9b2046ebb801252128a3ffdcae15`. External exact-publication-head review remains pending. |
| Live operation | OPEN; this source slice proves no live runtime or delivery acceptance. |

Evidence lives under `docs/evidence/validation/2026-10-15-owner-readiness/`. Failed attempts are retained and distinguished from final checks. Builder test-first sequencing and any deviations are recorded honestly. Exact head/tree are recorded in PR publication metadata after commit.

Behavioral fail-before uses exact accepted baseline server/projection/page bytes: the authenticated HTTP assertion reports missing readiness and the browser times out on the absent readiness selector. Baseline TypeScript also reports absent new presentation exports but emits the exercised baseline JavaScript; that build failure is not counted as behavioral RED. Initial missing-module and edited-page helper errors are historical integration failures, not RED acceptance. A separate cancelling/UNKNOWN mission regression fails ready-versus-unverified before the mission-state guard.

Tests were written before implementation, but builders edited production before executing a meaningful RED. The controller subsequently established baseline behavior and retained the deviation; this was not a clean test-first sequence. Initial Windows HTTP runs hung without complete diagnostics; Linux focused/final checks are authoritative. Browser harness repairs corrected asynchronous offline waiting, existing CSS uppercase assertions and the synthetic authority argument position. The final browser run has zero page errors and only read-only UI API requests; harness setup uses the real owner cancellation API explicitly.

The first complete Linux suite recorded 343 total / 340 pass / one startup readiness timeout / two existing skips (169314.51963 ms). The unchanged two-second startup test failed independently; a valid-port diagnostic observed successful listening after 2193 ms. The test-only repair uses a finite 15-second condition deadline, detects child exit, and avoids waiting for an already-exited child during teardown. It retains health/session assertions; product startup and default-off behavior are unchanged. Focused startup GREEN passes. Final manifest changes only tests/startup.test.ts from the prior reviewed manifest, and the reviewer independently accepted that delta. Final full-suite rerun follows.

Final Linux rerun: **343 total, 341 pass, zero failures/cancelled, two existing skips**, 159638.477937 ms. UI source is locally complete but publication/rebase is HOLD: PR26 lifecycle correction review5538203597 supersedes its base acceptance. Preserve this branch while repairing PR26 in a separate checkout; rerun/review the eventual rebased candidate. No new UI PR or merge is implied by these local gates.

Rebase override (2026-10-15): the UI successor is locally rebased onto repaired PR26 `2dc187651b2616f8274eba31b07862ffaffafbc6`. Historical UI gates/manifests below apply to pre-rebase `c6a6b264a84a374b82b198ff3129216c25092e09` only. Current combined candidate remains HOLD for fresh source/build/browser/PostgreSQL/full-suite verification and independent review. No UI branch push or PR publication occurred. PR26 exact-head external review remains OPEN.
