# Orloom

Orloom is a single-operator repository-job foundation. This checkout provides a local control plane and durable job-state contract. It does not run repository code or connect to live providers.

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

## Storage and adapters

`db/migrations/001_initial.sql` defines PostgreSQL state and constraints. `SqlJobStore` uses a small query interface and is exercised on embedded PGlite, which runs PostgreSQL-compatible SQL in-process. Cloud mode deliberately refuses startup until a persistent PostgreSQL adapter is wired; it must never silently fall back to memory.

The adapters implement GitHub App installation token/check requests, webhook HMAC verification, conditional hash-addressed R2 object operations, and a typed Codex SDK constructor using an explicit environment and working directory. Provider request boundaries are injectable and locally tested; no live call has been made or proven. Worker-to-control-plane lease protocol remains future work.

## Intended deployment topology

The eventual topology is a frontend served with the control-plane service, managed PostgreSQL for durable state, a separate isolated DigitalOcean worker, R2 for evidence objects, and an external Forge service that validates candidates and publishes GitHub checks. The browser never holds provider credentials. GitHub Actions workflows are intentionally absent; GitHub installation permissions and external runtime secrets belong to the server-side Forge/control-plane boundary. This topology is documented only; cloud deployment and worker isolation are not implemented.

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
