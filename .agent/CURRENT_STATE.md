# Orloom current state

Canonical authority: docs/architecture/CANONICAL_HARNESS.md and the revised owner directive. Main6110c692 remains accepted PR1. PR2 owner-frozen8bbcfffb is untouched; external remote639bff is excluded. V1–V4 prototypes are preserved. No further main merge is authorized.

The composed feature branch includes governed judgment/recovery, learning, adaptive scheduling, independent verification, local integration, the circular event-driven Loom and a closed-by-default delivery endpoint. Source and runtime acceptance are separate.

C4 source078ed12 passed98 local tests but real PostgreSQL found a concurrent post-CAS replay defect. Successor2a02606 passed99 controller tests, independent source review and actual fresh PostgreSQL18.6/bare Git proof: two-pool duplicate replay yielded one CAS/event/dependent release; moved refs and mutated evidence failed closed. Independent runtime review passed bounded. Evidence5c71c6b and docs/evidence/c4-replay-success preserve results and failed predecessors. Controlled verifier/review inputs do not prove authentic CI.

C5 sourcebd2bb5e passed110 controller tests, controlled browser checks and independent source/browser review. PR11 evidence0e5daef retains screenshots and all prior findings. Real PostgreSQL-backed browser proof remains OPEN.

Latest actual cloud full-suite attempt remains FAIL on source8f271de: 297978ms, zero certificates, non-root scratch lock EACCES. The composed source includes fixture repair6406393; real Linux regression remains OPEN. Disposable cleanup/protected-host checks passed; docs/evidence/c3-suite-duration retains evidence.

Base `f6023acade03091a494644409e9bc65d28d59ad4` has accepted 134-test source review and bounded real-PostgreSQL delivery behavior (`work/delivery-pg-runtime-review-f6023ac.json`). The uncommitted C4-COMPOSE-01 working-tree successor on that base adds startup composition; root's gate log for that working-tree candidate records 138/138 tests passing, while validation first failed on the two explicit false example flags. The bounded validator exception now permits only those two exact `false` values and preserves blank-credential checks; `npm run validate` passes. Root must freeze and independently review the exact successor candidate. No cloud startup, credentialed App/R2, remote upload or publication proof is claimed.

Next: freeze and independently review C4-COMPOSE-01, then run root-selected combined gates. Live Jev remains closed under `work/controller-composition-jev-amendment.md` until a separately approved durable spend-reservation/reconciliation contract exists. Genuine learning activation/benefits, actual App/R2 credential use, remote upload/publication, PostgreSQL browser proof, deployment and full commercial acceptance remain OPEN. Provider calls0; no unsupported performance claims.
