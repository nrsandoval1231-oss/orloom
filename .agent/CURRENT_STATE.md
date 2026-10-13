# Orloom current state

Canonical authority: docs/architecture/CANONICAL_HARNESS.md and the revised owner directive. Main6110c692 remains accepted PR1. PR2 owner-frozen8bbcfffb is untouched; external remote639bff is excluded. V1–V4 prototypes are preserved. No further main merge is authorized.

The composed feature branch includes governed judgment/recovery, learning, adaptive scheduling, independent verification, local integration, the circular event-driven Loom and a closed-by-default delivery endpoint. Source and runtime acceptance are separate.

C4 source078ed12 passed98 local tests but real PostgreSQL found a concurrent post-CAS replay defect. Successor2a02606 passed99 controller tests, independent source review and actual fresh PostgreSQL18.6/bare Git proof: two-pool duplicate replay yielded one CAS/event/dependent release; moved refs and mutated evidence failed closed. Independent runtime review passed bounded. Evidence5c71c6b and docs/evidence/c4-replay-success preserve results and failed predecessors. Controlled verifier/review inputs do not prove authentic CI.

C5 sourcebd2bb5e passed110 controller tests, controlled browser checks and independent source/browser review. PR11 evidence0e5daef retains screenshots and all prior findings. Real PostgreSQL-backed browser proof remains OPEN.

Latest actual cloud full-suite attempt remains FAIL on source8f271de: 297978ms, zero certificates, non-root scratch lock EACCES. The composed source includes fixture repair6406393; real Linux regression remains OPEN. Disposable cleanup/protected-host checks passed; docs/evidence/c3-suite-duration retains evidence.

Delivery sourcebdd8dc independent FIX identified rejection of legitimate integration/review metadata. C4-DELIVERY-COMPOSITION-02 repaired the typed boundary and added a supported integration-to-delivery path. Combined21a90df passed133/134 tests; independent review found only a stale scoped-token test, now repaired under C4-DELIVERY-BOUNDARY-03. Final gates/review remain pending for this successor. Per-effect durable claims, exact Check/PR readbacks and owner-only route are implemented; production startup still injects no delivery authority, and remote branch upload is a prerequisite.

Next: finalize this source composition, run combined gates and independent review, execute the prepared real-PG delivery proof, then bind a new isolated cloud suite. Operational startup wiring, live Jev, genuine learning activation/benefits, App/R2 credentials and remote publication, PostgreSQL browser proof, deployment and full commercial acceptance remain OPEN. Provider calls0; no unsupported performance claims.
