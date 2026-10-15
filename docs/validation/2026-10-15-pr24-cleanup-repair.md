# PR24 cleanup identity and portable-test repair

Bounded repair parent: `661ddecae7dc116336edc454f72933ed32607b67`.

The launch-error cleanup helper predates PR24. PR24 added image/name rejection but routed those failures through that weaker cleanup path. The repair shares one exact identity predicate between launch inspection, cleanup, and interrupted-worker reconciliation. All removal paths now require the retained immutable container ID, exact configured name, pinned image reference, and complete ownership-label digest. DockerRpc retains the expected image/name for ordinary close. Identity mismatch never authorizes removal; independent post-removal absence inspection remains required.

The eight portable reconciliation scenarios use `openPortableTestRoot` on non-Linux platforms and retain `openOperational` on Linux. Production's Linux ownership/mode validation is unchanged. This test API does not establish operational acceptance.

Regression coverage includes image/name/extra-label mismatches in direct cleanup and simulated Docker create-inspection, lost-create-reply, and invalid-create-ID paths. Each simulated path must retain the mismatched container, never start or remove it, and retain the durable intent as UNKNOWN. Existing positive exact-owner cleanup and post-removal uncertainty tests remain. The new regression file is `tests/worker-cleanup-identity.test.ts`; Docker CLI responses are synthetic, not real isolation proof.

The repair's full command results and commit/tree identity are returned to the independent parent reviewer. The original validation ledger and hashes remain historical evidence for the original PR head. No normal startup, controller settlement, capacity release, budget refund, live PostgreSQL/provider, Docker/runsc, deployment, or publication acceptance gate is closed by this repair. The parent retains independent review and merge authority.
