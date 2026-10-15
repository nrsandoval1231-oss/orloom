# PR26 lifecycle boundary correction

Formal review [5538203597](https://github.com/nrsandoval1231-oss/orloom/pull/26#pullrequestreview-5538203597) supersedes the earlier PASS at `9347c1701c8f18ea7e5b037695b88f584a747473`. Aborting during verification still reached preparation, integration and draft delivery; a valid 30-day task deadline overflowed Node's timer into an immediate expiry.

The repair threads a trusted optional lifecycle callback through the existing service, candidate preparation, verification coordinator, integration and delivery authorities. It rechecks the signal, absolute deadline and durable owner-cancellation state at awaited boundaries and immediately before new effects. It does not serialize authority into worker messages, retry ambiguous writes or infer a refund. Already claimed delivery effects and uncertain integration remain fenced by existing UNKNOWN/idempotency rules. The timer uses bounded chunks and re-evaluates the absolute deadline, including clock changes and cleanup.

Independent source audit found two additional gaps during this repair: the admitting runner could resume into verifier execution after its asynchronous readback; integration/replay and delivery could finalize success after asynchronous final readbacks. Those findings are part of this correction and require final green tests and independent review. Earlier intermediate gates do not certify the final candidate.

Evidence: [exact transcripts](../evidence/validation/2026-10-15-pr26-lifecycle/). Actual baseline failures include `expiry-red.actual.txt`, `service-red.txt`, `verification-baseline-red.txt` and `provider-entry-red.txt`. The verification baseline build intentionally used the unchanged method signatures and emitted extra-argument diagnostics before the actual behavioral failures; it is not clean-build proof. Initial fixture/build failures are retained: missing test signals, an arbitrary plan digest, an obsolete no-claimed-effect assertion, and an adapter test that stopped before its intended token boundary. Final tests retain the actual delivery upload claim as uncertain and forbid subsequent dispatch.

The startup test now allows up to 15 seconds for the real child process to listen and detects early exit; the previous fixed ~2-second poll was already reproduced as insufficient on the mounted Linux checkout. This changes only the test deadline and safe teardown.

Acceptance ledger (updated after final gates):

| Gate | State |
| --- | --- |
| Build/typecheck/validate | PASS on frozen product/test source |
| Complete serialized Linux suite | PASS: 363 total, 361 pass, zero failures/cancelled, two existing skips; 143832.595054 ms |
| Actual PostgreSQL lifecycle and restart | PASS; two fresh isolated databases, conservative 100-cent reservations |
| Independent bounded source review | PASS; all 186 source hashes verified, final manifest 74296e9136bc5f05a2a6426cabb4d0bb7cfa09624ab47592cf6b128045aa0e0b |
| Exact publication-head external review | OPEN |
| Real provider, independent verifier/runsc, GitHub Check/PR demonstration | OPEN; fixtures do not satisfy it |

PostgreSQL validation uses two real connections to isolated databases. The new lifecycle script uses explicit synthetic verifier callbacks/certificate-presence results, exercises actual durable lease/cancellation state and preserves 100-cent reservations. It retains awaiting-verification/cancelling state because no runtime absence proof exists. No forced settlement or refund is used. Existing restart validation exercises real journals and SQL fences, with explicit synthetic verified-state fixtures.

PR25 was merged separately by the authorized reviewer; PR26 targets main. This correction does not merge, deploy, activate paid providers, create credentials, change host/security/network configuration or alter the canonical UI. Host preparation is separately authorized but paused for correctness. The locally saved readiness/cancellation UI successor remains held until this correction is published for independent review. Live completion remains OPEN pending approved target/base/scopes/checks, secure existing credentials, explicit bounded activation/spend authority, accepted runtime/images and authentic exact-candidate verification/delivery.

Final audit also covered pre-existing pending intent reads and interruption during a fresh SQL intent insert. A clean-build regression reproduced pending instead of UNKNOWN; one shared known-pending checkpoint now handles both. No existing integrated replay is converted to UNKNOWN. The intermediate Linux run had two environment failures (Windows worktree Git pointer and missing Linux Node on PATH); the final private Linux snapshot verifies all source, staged and compiled bytes first. Its first preflight rejected only a .gitattributes CRLF/LF mismatch; that rejection is retained and normalization was independently reviewed. A zero-selected-test filter attempt is retained and is not RED proof. Raw diff checking reports one harmless final blank line in the frozen timer test; the remaining whitespace checks pass with blank-at-EOF ignored, preserving the exact executed source bytes.

The service can propagate a lifecycle exception from executeLane to the main process failure report; it does not claim durable failure/cancellation/delivery, advance stages or release reservations. This reporting limit was explicitly accepted by the bounded source reviewer.

Final acceptance evidence: persistent Linux snapshot smoke 19/20 pass, zero failures, one existing skip; full serial suite 363 total/361 pass/zero failures/two existing skips (143832.595054 ms). All 186 source entries, 123 compiled artifacts and staged source blobs match before and after execution. Source manifest SHA256 74296e9136bc5f05a2a6426cabb4d0bb7cfa09624ab47592cf6b128045aa0e0b. Both fresh actual PostgreSQL validations PASS; isolated cluster stopped afterward. The temporary snapshot's five setup failures are retained separately and do not count as passing gates. Exact publication SHA/tree are recorded in PR26 and the external handoff; external review remains OPEN.
