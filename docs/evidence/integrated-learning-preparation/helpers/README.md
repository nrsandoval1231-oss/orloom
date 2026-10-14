# C1b integrated runtime proof helper

This helper set is rebound to integrated source `8f271de796e643a3a0b9b47b80fc1de3e3646d9d`. It is preparation only: no host, provider, C3 database, PostgreSQL service, or live Jev run has been performed. The prior reviewed helper under `rootwork/c1b-runtime-proof` is unchanged. Do not run the integrated runtime proof until the controller has reviewed the exact payload/fixture and authorized the scheduled local runtime window.

`prepare-runtime-payload.mjs` creates a detached clean build, runs `npm ci`, `npm run clean`, `npm run build`, then packages compiled modules (including `CertifiedLearningActivation`), PostgreSQL driver dependencies, and all migrations. Its output manifest is `runtime-files.sha256`; rebind its SHA after any source or helper change. `prepare-fixture.mjs` creates a disposable Git object store rooted at the exact integrated SHA and five linear commits containing changes only to `scripts/validate.mjs`: two fail/pass episodes and one contradictory FAIL. The current fixture map and bundle SHA are fixed in `proof-guards.mjs` and checked again by `install-fixture.mjs`.

Before a later authorized run, the controller must separately provide:

| Inputs | Required contract |
| --- | --- |
| `ORLOOM_C1B_SOURCE_ROOT`, `ORLOOM_C1B_RUNTIME_ROOT`, `ORLOOM_C1B_RUNTIME_PAYLOAD_SHA256` | Exact clean integrated checkout, transferred clean-build payload, and independently recomputed manifest hash. The process working directory must be the source root. |
| `ORLOOM_C1B_FIXTURE_FILE`, `ORLOOM_C1B_FIXTURE_BUNDLE`, `ORLOOM_C1B_OBJECT_STORE` | Exact pinned fixture manifest and bytes; object-store path must be a new bare store created by `install-fixture.mjs`. |
| `ORLOOM_C1B_DATABASE_URL_FILE` | Root-owned regular non-symlink file, exact mode `0400`/`0600`; URL must target a fresh disposable `mission_proof_c1b` database as `mission_app` on private IPv4, port 5432, with 64-hex password. |
| `ORLOOM_C1B_C3_DATABASE_URL_FILE`, `ORLOOM_C1B_C3_DATABASE_NAME` | Separate root-owned regular non-symlink URL file with the same mode/credential checks, naming the retained C3 database. It is connected in PostgreSQL read-only mode and never passed through `PostgresJobStore.connect` (which applies migrations). |
| `ORLOOM_C1B_C3_OBJECT_STORE`, `ORLOOM_C1B_C3_VERIFIER_ARTIFACT_ROOT`, `ORLOOM_C1B_C3_APPROVED_REF`, `ORLOOM_C1B_C3_REPOSITORY` | Existing C3 approved-ref object store, separate retained C3 artifact root, exact allowed branch ref, and repository key for the C3 trusted runner. The artifact root must exist, be canonical, and not overlap C1b/source/object stores. This real runner's `observeHead` is part of certificate revalidation. |
| `ORLOOM_C1B_C3_MISSION_ID`, `ORLOOM_C1B_C3_SLICE_ID`, `ORLOOM_C1B_C3_CERTIFICATE_ID`, `ORLOOM_C1B_C3_POLICY_DIGEST` | Exact retained C3 certificate binding. Mission/slice/certificate/policy values must match the real `TrustedCheckCoordinator.getCertificate`; the runtime SHA is pinned to the integrated source SHA. Missing or stale certificate fails closed. |
| `ORLOOM_VERIFIER_IMAGE`, `ORLOOM_VERIFIER_ID`, `ORLOOM_VERIFIER_ARTIFACT_ROOT`, `ORLOOM_VERIFIER_LAUNCHER` | Existing controller-approved immutable runner configuration, artifact root, and launcher; no alternate launcher is added. |
| `ORLOOM_C1B_CAPACITY_EVIDENCE_SHA256`, `ORLOOM_C1B_EVIDENCE_DIR` | Controller-approved isolated capacity evidence digest and a private output directory separate from source, object stores, and artifact roots. |

The C1b control plane receives a real `CertifiedLearningActivation` instance backed by the actual C3 `TrustedCheckCoordinator`; it is not a copied certificate, issuer, or mock success. The C3 lookup uses the actual `SqlMissionStore` query path with a read-only pool and the existing trusted runner. Every lesson promotion rechecks mission, slice, exact integrated runtime SHA, certificate ID, policy digest, scope, and the observed C3 approved-ref head. C1b attempts and artifacts stay in their separate disposable database, fixture store, and artifact root.

Approved-ref recovery is opt-in only. Normally there is no ref mutation. If a prescribed controller negative changed the C3 fixture ref, the controller must explicitly provide `ORLOOM_C1B_C3_RESTORE_EXPECTED_NEGATIVE_SHA` and `ORLOOM_C1B_C3_RESTORE_CERTIFIED_SHA`; the latter must equal the certificate-bound integrated SHA. `restoreCertifiedApprovedRef` performs a compare-and-swap from the exact observed negative SHA, confirms the resulting head, then calls the real activation certificate check again. Any mismatch or failed requery is UNKNOWN. Ref restoration never grants activation by itself.

The preserved proof drives the two legitimate trusted FAIL -> Governor-approved strategy change -> PASS episodes, independent challenge from persisted receipts/artifacts, natural candidate promotion, later strategy choice and Governor action after reconnect, trusted contradictory FAIL and withdrawal, and a fresh decision without the lesson. Synthetic promotion contention stays separate. It uses bounded HTTP/cleanup windows and monotonic measured wall counters. Later selection uses the deterministic Governor fallback; this helper makes no live Jev claim. Its only positive output is `BEHAVIOR_PASS_PENDING_CONTROLLER_CLEANUP`. Final acceptance still requires controller-run PostgreSQL/runsc execution, retained evidence review, exact cleanup/postflight, and separate certification. This preparation does not establish runtime PASS, C3 suite CI acceptance, production activation, or deployment.

Run local-only validation after exact payload/fixture binding:

```powershell
node rootwork/c1b-integrated-proof/check-local-guards.mjs
```

That guard checks altered fixture/payload rejection, bounded HTTP and cleanup behavior, measured counters, and finite UNKNOWN handling. It does not access a database, host, provider, or external service.
