# Orloom

Orloom is a single-operator engineering harness being developed into the platform defined by [the canonical harness specification](docs/architecture/CANONICAL_HARNESS.md). PR #1's authenticated mission API and durable PostgreSQL scheduler are merged at `6110c692f47202978b2d22d22f6522aa4aa59277`. Its bounded verification evidence is retained [here](docs/evidence/pr1-revalidation/EVIDENCE.md). This does not establish a working end-to-end engineering platform.

PR #2 and its DeepSeek worker broker are frozen at `8bbcfffbf631e5ad2972e34b41284198afc566e2`. Development on this branch proceeds independently; it does not modify or depend on that broker. The [work graph](.agent/WORK_GRAPH.md) records current implementation and open acceptance gates.

Draft PR #3 adds the optional typed Jev gateway, fenced progress decisions, bounded recovery and durable lesson candidates. Source `545279c` passed 51 tests and a controlled real PostgreSQL recovery/reconnect proof; [retained evidence](docs/evidence/c1a-runtime/EVIDENCE.md) includes independent source review and prior failed attempts. Lesson promotion remains disabled until independent verification exists. No live Jev calls, learning improvement, or production rollout is claimed.

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

The C3 branch adds a disabled-by-default trusted local verifier for the finite `node-validate-syntax` check. With explicit Linux runner and PostgreSQL configuration, the control plane selects eligible candidates, extracts their exact Git objects, runs the check in a credential-free runsc container, retains hashed artifacts, and submits evidence through a private in-process capability boundary. Owner certificate reads recheck candidate, policy and local head. See [verification configuration and limits](docs/verification.md). Independent review and the real joined cloud proof are pending on this candidate.

This syntax-only certificate does not establish full CI, remote GitHub freshness, or integration approval. Builder results remain `awaiting_verification`; dependent slices remain `waiting_dependency`, and budgets and scopes stay reserved. Arbitrary evidence references, worker callbacks and owner sessions cannot certify or advance that gate. Lesson promotion remains closed.

Running lease expiry becomes `unknown`, retains the mission budget reservation, and quarantines its capacity slot and overlapping repository scope. There is no automatic retry or automatic budget refund. PR #1 passed an independently repeated disposable PostgreSQL proof with eight connections, six concurrent claims, rollback, restart durability, and expiry quarantine. It has not been deployed to production or exercised with a live builder/verifier.

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

The initial ORL-001 foundation above is intentionally **queue-only and non-live**. The product's longer-term identity and visual direction are preserved separately:

- [Orloom product vision](docs/VISION_ORLOOM.md)
- [Living Loom canonical visualization and interactions](docs/LIVING_LOOM_CANONICAL.md)
- [Purpose Graph, Athena learning, and bounded Jev decisions](docs/PURPOSE_GRAPH_AND_ATHENA.md)
- [Implementation roadmap and V5 live telemetry acceptance](docs/ROADMAP_LIVING_LOOM.md)
- [V1–V4 prototype provenance](docs/PROTOTYPE_HISTORY.md)

Historical standalone visual experiments are archived in [prototypes/v1](prototypes/v1/index.html), [v2](prototypes/v2/index.html), [v3](prototypes/v3/index.html), and [v4](prototypes/v4/index.html). Their activity is synthetic and they are **not connected** to the Orloom execution harness. V4 includes source inspection, not production telemetry.

**Visual north star:** The owner begins with an idea; specialist agents visibly weave a five-sector 3D torus around a central mission. The ring closes only when versioned requirements are independently verified. Source bundles, dependency links, drift, and decisions must be inspectable and evidence-backed.

**Execution north star:** GitHub is source control, **not GitHub Actions CI**. Orloom-owned isolated workers and trusted Orloom verification policies enforce acceptance. Athena and Jev may advise or select bounded strategies, but deterministic host policy owns authorization and irreversible actions.
