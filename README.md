# Orloom

Orloom is a single-operator engineering harness being developed into the platform defined by [the canonical harness specification](docs/architecture/CANONICAL_HARNESS.md). It is not yet a working end-to-end autonomous engineering platform.

## Current consolidation checkpoint: 2026-10-14

The repair candidate is based on PR #17 at `410882d4afff33e028be50b816ad69eb387eae6d`. It combines the existing judgment/recovery, evidence-governed learning, scheduling, verification, local integration, remote-delivery and real-event Living Loom source with repairs for seven audited correctness defects. Independent review accepted the bounded repair source: 167/167 tests passed with zero failures/skips, and typecheck, build and structure validation passed. A separate clean locked-install rerun also passed all 167 tests and validation gates. The reviewed source is bound by a retained 89-file SHA-256 manifest. Publication identity is the containing Git commit and its associated PR; no merge or deployment is claimed. See [the consolidation validation record](docs/validation/2026-10-14-consolidation.md).

PR #1 was merged at `6110c692f47202978b2d22d22f6522aa4aa59277`; this is the historical main baseline observed for this consolidation, not a claim about a later branch tip. Its [bounded PostgreSQL evidence](docs/evidence/pr1-revalidation/EVIDENCE.md) remains valid only within that retained scope. The owner's latest direction authorizes cleanup of the open PRs and advancing reviewed, ready work. Earlier frozen-head/no-further-merge instructions are historical. PR #2 worker-broker composition is being evaluated separately and is not claimed as included or accepted here.

The latest retained actual full cloud-suite attempt identified by the audit was **FAIL**, with zero certificates, on `f6023acade03091a494644409e9bc65d28d59ad4`: Unix symlink teardown failed with ENOTDIR after 271438 ms. Its PR #14 evidence is preserved as exact original blobs in this consolidation; those records remain bound to the failed historical source, not the repaired candidate. PR #15's fixture repair and PR #17's throughput changes are present in this candidate's base, but neither substitutes for a successful new exact-source isolated cloud run. The earlier [suite failure](docs/evidence/c3-suite-duration/EVIDENCE.md) remains historical evidence, not the latest result.

Historical [integration replay evidence](docs/evidence/c4-replay-success/EVIDENCE.md) and [controlled Loom evidence](docs/evidence/c5-source-browser/EVIDENCE.md) establish bounded behavior at their original revisions. They do not certify the consolidated code. The [work graph](.agent/WORK_GRAPH.md) distinguishes implemented source from open operational acceptance.

Learning promotion requires independently challenged evidence, explicit controller-owned activation and relevant comparable outcomes. The source implements a reserved-branch Git-object upload transport with scoped App authority and fresh remote SHA/tree readback before publication; credentialed real publication remains unproven. No live Jev execution, measured learning gain, six active DeepSeek builders, operational GitHub App/R2 publication, or production rollout is claimed. Missing authority keeps those paths closed.

## Run locally

Requires Node.js 24. Copy `.env.example` to `.env` only in a private local working directory and set a long random `ORLOOM_SESSION_TOKEN`; the checked-in template is intentionally blank. Install and run:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run validate
npm start
```

`npm start` loads `.env` with Node's `--env-file-if-exists` option. The local server binds to loopback, reports `liveExecution: false`, and uses in-memory storage. Job submissions require the configured session token, which the dashboard exchanges for a same-origin HttpOnly cookie. Do not expose the local service to a network.

## Job API

- `GET /health` is unauthenticated and returns mode plus `liveExecution: false`.
- `POST /session` accepts `{"token":"..."}` and sets a strict same-site HttpOnly cookie. It never echoes or logs the supplied token.
- `POST /api/jobs` requires that cookie and accepts `{"repository":"owner/name","task":"..."}`. Repository is limited to 256 characters and task to 20,000 characters. A created job is queued only.
- `GET /api/jobs/{id}` requires the same cookie.

There is no run/shell endpoint. The worker entrypoint exits because no isolated execution provider is configured. Interrupted work that had entered `running` becomes `unknown`; an expired lease that had not started may return to `queued`. The lease token fences stale starts and completions. No external side effect is automatically replayed.

## Mission API

The owner UI creates a mission with repository, full immutable base SHA, objective, acceptance criteria, and budget. An owner-authored plan recommendation lists slice dependencies, scope paths, trusted check identifiers, and slice budgets. Approval is a separate authenticated action. `GET /api/missions/{id}` and `/events?after={cursor}` read durable mission state and ordered event history. Existing `/api/jobs` routes remain available.

Worker claims use `POST /api/worker/claim` with the separately configured `ORLOOM_WORKER_TOKEN`. A claim is disabled by default. Enabling a slot requires an operator-marked, unexpired isolation evidence SHA-256 binding, trusted check policy, exact provider and model allowlists, and positive call/token/time ceilings. Up to six attested slots are stored in PostgreSQL. A claim carries immutable mission/slice data, base SHA, ownership scopes, fencing epoch, lease and capability tokens, plan and trusted-policy digests, reserved slice budget, and execution ceilings. Heartbeat, candidate, and `BLOCKED`/`UNKNOWN` callbacks require the mission ID, slice ID, epoch, lease token, and lease capability. Candidate results remain `awaiting_verification`; the worker cannot certify or integrate them.

The composed source includes a disabled-by-default trusted local verifier with the default finite `node-validate-syntax` check and optional `node-repo-suite-v1` repository suite. With explicit Linux runner and PostgreSQL configuration, the control plane selects eligible candidates, extracts their exact Git objects, runs the check in a credential-free runsc container, retains hashed artifacts, and submits evidence through a private in-process capability boundary. Owner certificate reads recheck candidate, policy and local head. See [verification configuration and limits](docs/verification.md). Source `765943e` passed independent source and bounded runtime review, including a real syntax-check certificate, slot contention and separate recovery from an interrupted launch. [Retained evidence](docs/evidence/c3-runtime/EVIDENCE.md) preserves the failed initial interruption harness, its UNKNOWN attempt and successful continuation. This later evidence checkpoint does not receive a new certificate automatically.

These local certificates do not establish full CI, remote GitHub freshness, or integration approval. Builder callbacks stop at `awaiting_verification`; only the trusted verification and Governor integration path may advance a successfully certified slice and unblock eligible dependents. Arbitrary evidence references, worker callbacks and owner sessions cannot certify or bypass that gate. Normal executable startup leaves learning activation and live judgment/scheduling adapters unconfigured.

Running lease expiry becomes `unknown`, retains the mission budget reservation, and quarantines its capacity slot and overlapping repository scope. There is no automatic retry or automatic budget refund. PR #1 passed an independently repeated disposable PostgreSQL proof with eight connections, six concurrent claims, rollback, restart durability, and expiry quarantine. It has not been deployed to production or exercised with a live builder/verifier.

The read-only [Living Loom](docs/living-loom.md) is available at `/loom?mission=<mission-id>` after owner sign-in. It displays recorded mission, slice, decision, recovery, learning and verification events, with bounded cursor catch-up and conservative completion checks. Source and controlled browser evidence do not establish live builders or cloud deployment.

## Storage and adapters

The migrations under `db/migrations/` define queue, mission, and subsequent additive state. Local tests use embedded PGlite; cloud mode uses `PostgresJobStore` and `SqlMissionStore` with a real PostgreSQL pool and fails startup if initialization or readiness checks fail. It never silently falls back to memory.

The adapters implement GitHub App installation token/check requests, webhook HMAC verification, conditional hash-addressed R2 object operations, and a typed Codex SDK constructor using an explicit environment, dedicated `CODEX_HOME`, ChatGPT subscription authentication, and working directory. The Codex adapter configuration rejects API-key billing. OAuth cache presence is not proof of an operational product integration. The control plane exposes fenced worker leases, but this branch does not provide a live worker consuming them. See [deployment prerequisites](docs/deployment.md) before any dedicated-worker login.

## Intended deployment topology

The target topology uses Cloudflare web delivery and protection, a cloud control plane, PostgreSQL, isolated DigitalOcean execution workers, R2 evidence, and a scoped GitHub App. Orloom-owned trusted CI executes checks; GitHub Actions is not an execution dependency. Hostinger currently hosts the earlier queue-only baseline. A separate DigitalOcean host has bounded isolation smoke evidence, which does not prove six live builders, production verification, or full cloud recovery. The browser never holds provider credentials.

## Trust boundaries

Browser code never receives a GitHub, R2, database, or Codex credential. The session token is entered into the dashboard and retained only in a strict HttpOnly cookie; use TLS and a managed session design before remote hosting. Tokens and private keys should be entered later through the provider dashboard or dedicated secret manager, not chat, source, build arguments, or repository variables.

Orloom-owned CI must keep trusted validation commands outside the untrusted target checkout. Do not add GitHub Actions workflows to Orloom. A target repository must not be allowed to replace the validation policy used to grade its own changes. The current local `scripts/validate.mjs` only checks this foundation's structure and is not a secure hostile-code sandbox.

## Read next

- [Security and credential handling](docs/security.md)
- [Architecture decision](docs/adr/0001-foundation-boundaries.md)
- [Foundation finish contract](docs/FINISH_CONTRACT.md)
- [Forge CI contract](forge/CI_CONTRACT.md)
- [Deployment prerequisites](docs/deployment.md)

## Canonical product vision and Living Loom

The historical ORL-001 foundation was intentionally **queue-only and non-live**. The composed source now extends that foundation, while operational acceptance remains open. The product's longer-term identity and visual direction are preserved separately:

- [Orloom product vision](docs/VISION_ORLOOM.md)
- [Living Loom canonical visualization and interactions](docs/LIVING_LOOM_CANONICAL.md)
- [Purpose Graph, Athena learning, and bounded Jev decisions](docs/PURPOSE_GRAPH_AND_ATHENA.md)
- [Implementation roadmap and V5 live telemetry acceptance](docs/ROADMAP_LIVING_LOOM.md)
- [V1–V4 prototype provenance](docs/PROTOTYPE_HISTORY.md)

Historical standalone visual experiments are archived in [prototypes/v1](prototypes/v1/index.html), [v2](prototypes/v2/index.html), [v3](prototypes/v3/index.html), and [v4](prototypes/v4/index.html). Their activity is synthetic and they are **not connected** to the Orloom execution harness. V4 includes source inspection, not production telemetry.

**Visual north star:** The owner begins with an idea; specialist agents visibly weave a five-sector 3D torus around a central mission. The ring closes only when versioned requirements are independently verified. Source bundles, dependency links, drift, and decisions must be inspectable and evidence-backed.

**Execution north star:** GitHub is source control, **not GitHub Actions CI**. Orloom-owned isolated workers and trusted Orloom verification policies enforce acceptance. Athena and Jev may advise or select bounded strategies, but deterministic host policy owns authorization and irreversible actions.

