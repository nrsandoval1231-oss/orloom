# Trusted local verification (ORL-C3)

The control plane starts this lane only when the complete trusted runner configuration is present and a PostgreSQL mission store is active. Otherwise certification stays disabled. This produces Orloom-local evidence for one exact commit; it does not publish GitHub Checks, prove remote freshness, or verify integration.

## Operator setup

Set these values in the protected control-plane environment. `.env.example` contains blank names only.

- `ORLOOM_VERIFIER_IMAGE`: immutable `repository/name@sha256:<64 lowercase hex>` or an inspected local Docker image ID `sha256:<64 lowercase hex>`. Tags are rejected. The launcher inspects the local image immediately before creating a sandbox and confirms the configured digest.
- `ORLOOM_VERIFIER_ID`: stable operator-assigned verifier identity.
- `ORLOOM_VERIFIER_ARTIFACT_ROOT`: persistent directory outside the source worktree and temporary directories. The artifact store uses content-addressed `sha256/<digest>` keys and refuses unsafe paths.
- `ORLOOM_VERIFIER_REPOSITORIES`: JSON object mapping canonical `owner/repo` to `{ "objectStore": "/absolute/path/to/repo.git", "approvedRef": "refs/heads/main" }`. The object store and ref are operator-controlled; mission text cannot select paths or commands.
- `ORLOOM_VERIFIER_LAUNCHER`: optional absolute path to the fixed host launcher. The default is `/opt/orloom/infra/verifier-isolation/launch-verifier.sh`.
- `ORLOOM_TRUSTED_CHECK_POLICY_JSON`: must include `node-validate-syntax` to enable the initial check. Its configured digest fences the lease; the finite check policy adds its own digest and pinned image identity.

The launcher requires the protected Linux host service to run as root, Docker at `/usr/bin/docker`, `flock`, and the `runsc` runtime. Preload and inspect the verifier image on that host. The launcher has no network, mounts no host source tree or credentials, runs as UID/GID 65532 with a read-only root, dropped capabilities, no-new-privileges, 0.5 CPU, 256 MiB memory, 64 PIDs, and bounded tmpfs. It serializes all processes with a protected host-wide lock in `/run/orloom-verifier-lock` and stores durable intent/container identity under `/var/lib/orloom/verifier/state`. The shared `/var/lib/orloom` parent must already be root-owned and not group/world writable; the launcher validates but never changes its permissions. It creates a dedicated mode-0700 verifier directory for slot state. After restart it only removes a previously recorded exact container after the ID, ORL-C3 label, invocation name, and image all match. Unknown creation effects and identity/daemon inspection failures leave the slot quarantined for operator reconciliation; no unrelated container is enumerated or removed. Keep `/var/lib/orloom` persistent. Artifacts and uncertain slot state must remain durable across process restarts.

## Execution and evidence

The initial catalog contains only `node-validate-syntax`: `node --check scripts/validate.mjs`, one concurrent check, a 60-second execution deadline, up to 16 MiB input and 64 KiB per log. Changing a check, image, or limit changes the bound policy digest. The repository extractor verifies the candidate commit and base ancestry against the approved local ref, rejects unsafe tree entries, and stages regular files only.

The control plane polls PostgreSQL every five seconds and dispatches at most one awaiting check at a time. A unique mission/slice/epoch/check attempt key prevents concurrent or restart-driven redispatch. The verifier capability is kept in the control-plane process; there is no worker or owner receipt-submission route. It expires 120 seconds after the check deadline. Late PASS/FAIL is rejected; a late UNKNOWN can be recorded during grace. The expiry reconciler records UNKNOWN after grace, including attempts interrupted by restart. Normal SIGTERM/SIGINT shutdown stops polling and awaits the active reconcile/verification before closing PostgreSQL. Failures to read the candidate or authoritative ref are retained as UNKNOWN dispatch events without manufacturing a request or artifact.

PASS creates one immutable certificate and one `check.certified` event in a PostgreSQL transaction after artifact read-back, receipt digest, approved plan, candidate SHA, lease epoch, selected policy, and current local head all match. The owner view checks those bindings again and hides a certificate if the local ref has moved. Certification never changes slice status, integrates code, releases budgets, or promotes lessons.

`tests/verification-certification.test.ts` uses PostgreSQL-compatible PGlite and explicitly injected fixture runner boundaries for deterministic behavior tests. It is not a real runsc host proof. A genuine runner-to-PostgreSQL proof still requires the configured protected host, pinned preloaded image, operator repository map, and durable artifact path.
