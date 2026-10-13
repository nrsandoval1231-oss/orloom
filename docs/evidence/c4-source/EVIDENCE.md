# C4 local integration source evidence

Exact source `078ed12c8b2cbaf102e8f788e37980b017fc061a` passed the retained controller gates (98 tests, no failures/skips, typecheck, clean build, validation, verifier syntax and diff checks) and independent source rereview. Source manifest SHA256 is `6b73ecf08a641d6c2adf00f5599ca66d0d9554eff02ed893bf597254be38dbec` (126 staged Git blobs).

Earlier candidate f669e5a passed tests but independent review required fixes for full receipt/request parity and Git object-store revalidation. Both findings, the failed acceptance, repair and exact successor are retained. Review PASS is bounded source acceptance only.

The implementation uses a fixed controller-owned repository/ref, direct-child scoped commit, mandatory final full-suite certificates, retained independent review, durable SQL intent, CAS and final fenced state transition. Default production integration is closed. Tests use PGlite, actual temporary bare Git, and explicitly controlled runner/review fixtures. Real PostgreSQL multi-connection recovery, authentic cloud certification, operational activation, remote PR delivery and product completion remain open. Prior8f cloud attempt remains FAIL with zero certificates. An evidence-only successor is not certified by source078's gates or review.
