# Orloom

Orloom is a single-operator engineering harness. This checkout adds an authenticated mission API and durable PostgreSQL mission scheduler beside the original queue API. The worker branch contains a broker, bounded DeepSeek tool protocol, exact-SHA checkout, and stdin-only credential-free `runsc` runtime path. A bounded remote fixture run exercised production broker/runtime code on the existing DO host and stopped at `awaiting_verification`; it did not call DeepSeek or prove trusted CI acceptance or a deployed verifier. See [the retained runtime checkpoint](work/worker-runtime-proof/RUNTIME-PROOF-RESULT.md).

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

There is no public run/shell endpoint. The worker entrypoint is a separate broker process (`npm run start:worker`) and requires operator-supplied secrets and reviewed pinned sandbox configuration. It fails closed when those settings are absent. Interrupted work that had entered `running` becomes `unknown`; an expired lease that had not started may return to `queued`. The lease token fences stale starts and completions. No external side effect is automatically replayed.

## Mission API

The owner UI creates a mission with repository, full immutable base SHA, objective, acceptance criteria, and budget. An owner-authored plan recommendation lists slice dependencies, scope paths, trusted check identifiers, and slice budgets. Approval is a separate authenticated action. `GET /api/missions/{id}` and `/events?after={cursor}` read durable mission state and ordered event history. Existing `/api/jobs` routes remain available.

Worker claims use `POST /api/worker/claim` with the separately configured `ORLOOM_WORKER_TOKEN`. A claim is disabled by default. Enabling a slot requires an operator-marked, unexpired isolation evidence SHA-256 binding, trusted check policy, exact provider and model allowlists, and positive call/token/time ceilings. Up to six attested slots are stored in PostgreSQL. A claim carries immutable mission/slice data, base SHA, ownership scopes, fencing epoch, lease and capability tokens, plan and trusted-policy digests, reserved slice budget, and execution ceilings. Heartbeat, candidate, and `BLOCKED`/`UNKNOWN` callbacks require the mission ID, slice ID, epoch, lease token, and lease capability. Candidate results remain `awaiting_verification`; the worker cannot certify or integrate them.

There is no verifier or integration endpoint in this slice. Builder results remain `awaiting_verification`, and dependent slices remain `waiting_dependency` until a later independently reviewed verifier implementation supplies trusted evidence. Arbitrary evidence references cannot advance the gate.

Running lease expiry becomes `unknown`, retains the mission budget reservation, and quarantines its capacity slot and overlapping repository scope. There is no automatic retry or automatic budget refund. The bounded B broker/runtime fixture was exercised on the DO worker, but the production worker service is not deployed, and the path has not been exercised with real PostgreSQL or DeepSeek or accepted by an independent verifier.

## ORL-005B worker prerequisites

The broker reads `ORLOOM_DEEPSEEK_API_KEY` (prefer `ORLOOM_DEEPSEEK_API_KEY_FILE`), the narrow GitHub App installation token settings, private R2 credentials, and the existing worker bootstrap/control-plane settings. `ORLOOM_WORKER_CONCURRENCY` bounds simultaneous claim loops from one process; it defaults to one and accepts at most six. Set it no higher than enabled A capacity slots or independently measured host capacity. A remains the global atomic lease arbiter, and every claimed lease gets a separate workspace/container identity. The configured ceiling is not evidence that the host can safely sustain that many builds. Secrets stay in the broker process; the sandbox receives no provider, GitHub, R2, Codex, or owner-session credential. Protected secret files must be private to the service account. Never enter secrets in chat or commit a `.env` file.

Before starting the worker, an operator must provide an exact allowed model, a fresh model-specific pricing snapshot (`ORLOOM_WORKER_PRICING_SNAPSHOT_FILE`) with source/version/capture/expiry and input/output/reasoning rates, and trusted check IDs mapped to fixed argv in `ORLOOM_WORKER_CHECK_COMMANDS_FILE`. The complete worst-case price at the configured call/token ceilings must fit the slice reservation with the required safety margin. A missing/stale/unpriced policy disables execution. `/models` proves model identity only; the worker separately performs a bounded forced function-call probe and checks the exact model in responses. Reasoning is explicitly disabled and excluded from model context.

Build the sandbox image only from an operator-verified digest-pinned Node base using `apps/worker/Dockerfile.sandbox`, then configure its exact local Docker image ID (`sha256:<digest>`) or pinned GHCR image digest in `ORLOOM_WORKER_SANDBOX_IMAGE_REF`. The broker starts only that immutable reference with fixed `runsc`, no network, nonroot UID, read-only rootfs, dropped capabilities, and separate bounded tmpfs. It transfers a bounded regular-file snapshot through stdin; it does not use `docker cp` or mount the checkout. Repository symlinks and secret-like inputs fail closed. Representative build capacity and six sustained slots remain UNKNOWN; the existing two-container smoke does not establish either.

A candidate handoff includes a verified Git bundle containing the candidate commit relative to its immutable base, plus a bounded diff and usage/evidence references. The bundle is stored immutably before the worker submits the candidate SHA; checkout cleanup therefore does not destroy the candidate object needed by a later trusted verifier. This still does not integrate or certify the candidate.

The current durable worker progress sink stores digest-addressed R2 records and checks readback. It does not yet consult a mission-bound active recovery/policy continuation service; the dependent C packet must add that control-plane decision before claiming active recovery. Candidate callbacks carry only candidate SHA and evidence references to `awaiting_verification`; no worker or owner route can integrate/certify them.

## Storage and adapters

`db/migrations/001_initial.sql` defines PostgreSQL state and constraints. `SqlJobStore` uses a small query interface and is exercised on embedded PGlite, which runs PostgreSQL-compatible SQL in-process. Cloud mode deliberately refuses startup until a persistent PostgreSQL adapter is wired; it must never silently fall back to memory.

The adapters implement narrow repository-only GitHub checkout tokens separately from check-write installation tokens, webhook HMAC verification, and conditional hash-addressed R2 operations. A typed Codex SDK constructor remains isolated from the DeepSeek worker path. The worker never reads the owner desktop OAuth cache. No actual provider/GitHub/R2 call, sustained build, or live acceptance has been performed; only the bounded remote fixture sandbox/broker path is proven. See [deployment prerequisites](docs/deployment.md) before any dedicated-worker setup.

## Intended deployment topology

The intended topology is a frontend served with the control-plane service, managed PostgreSQL for durable state, a separate isolated DigitalOcean broker/worker, R2 for evidence objects, and a trusted verifier/Forge service that validates candidates and publishes GitHub checks. The browser never holds provider credentials. GitHub Actions workflows are intentionally absent; GitHub installation permissions and external runtime secrets stay in broker/verifier boundaries. The B runtime source is implemented, but image build/pinning, remote job proof, representative capacity, verifier, and deployment remain open.

## Trust boundaries

Browser code never receives a GitHub, R2, database, or Codex credential. The session token is entered into the dashboard and retained only in a strict HttpOnly cookie; use TLS and a managed session design before remote hosting. Tokens and private keys should be entered later through the provider dashboard or dedicated secret manager, not chat, source, build arguments, or repository variables.

Forge must own trusted validation commands outside the untrusted target checkout. Do not add GitHub Actions workflows to Orloom. A target repository must not be allowed to replace the validation policy used to grade its own changes. The current local `scripts/validate.mjs` only checks this foundation's structure and is not a secure hostile-code sandbox.

## Read next

- [Security and credential handling](docs/security.md)
- [Architecture decision](docs/adr/0001-foundation-boundaries.md)
- [Foundation finish contract](docs/FINISH_CONTRACT.md)
- [Forge CI contract](forge/CI_CONTRACT.md)
- [Deployment prerequisites](docs/deployment.md)

## Canonical product vision and Living Loom

The initial ORL-001 foundation above is intentionally **queue-only and non-live**. The product's longer-term identity and visual direction are preserved separately:

- [Orloom product vision](docs/VISION_ORLOOM.md)
- [Living Loom canonical visualization and interactions](docs/LIVING_LOOM_CANONICAL.md)
- [Purpose Graph, Athena learning, and bounded Jev decisions](docs/PURPOSE_GRAPH_AND_ATHENA.md)
- [Implementation roadmap and V5 live telemetry acceptance](docs/ROADMAP_LIVING_LOOM.md)
- [V1–V4 prototype provenance](docs/PROTOTYPE_HISTORY.md)

Historical standalone visual experiments are archived in [prototypes/v1](prototypes/v1/index.html), [v2](prototypes/v2/index.html), [v3](prototypes/v3/index.html), and [v4](prototypes/v4/index.html). Their activity is synthetic and they are **not connected** to the Orloom execution harness. V4 includes source inspection, not production telemetry.

**Visual north star:** The owner begins with an idea; specialist agents visibly weave a five-sector 3D torus around a central mission. The ring closes only when versioned requirements are independently verified. Source bundles, dependency links, drift, and decisions must be inspectable and evidence-backed.

**Execution north star:** GitHub is source control, **not GitHub Actions CI**. Orloom-owned isolated workers and trusted Forge validation enforce acceptance. Athena and Jev may advise or select bounded strategies, but deterministic host policy owns authorization and irreversible actions.
