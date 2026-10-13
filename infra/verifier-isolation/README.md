# Trusted local verifier

The first catalog entry is exactly `/usr/local/bin/node --check scripts/validate.mjs`, with cwd `/work/source`. It syntax-checks the candidate's extracted `scripts/validate.mjs` bytes. It does not run the repository validation suite, install dependencies, call providers, or establish GitHub freshness. Its policy limits are one concurrent check, 60 seconds including sandbox startup, 16 MiB aggregate source, 4 MiB per file, 4,000 files, a 1 MiB manifest, and 64 KiB for each captured log. Expanding checks or limits requires a new policy digest and separate capacity proof.

The trusted host extracts raw blobs from an operator-mapped complete bare object store, verifies the candidate is reachable from the mapped ref and descends from the supplied base, then serializes a deterministic manifest and regular files. It rejects symlinks, gitlinks, traversal, case collisions, alternates, shallow stores, and partial/promisor stores. It stages under `/run/orloom-verifier-input` with a generated name, streams a tar archive over Docker stdin, and does not mount source or output paths into the container. The launcher requires a preloaded digest-pinned image, `runsc`, no network, read-only root, UID/GID 65532, dropped capabilities, no new privileges, fixed CPU/memory/PID limits, and bounded tmpfs. The container rehashes every listed source file before running the fixed argv; bounded stdout/stderr and status return as one base64 JSON marker on Docker stdout. Missing marker, truncation, signal, timeout, nonzero infrastructure exit, and late finish are UNKNOWN.

`ORLOOM_VERIFIER_IMAGE` must be the immutable image reference, `ORLOOM_VERIFIER_ID` the configured trusted verifier identity, `ORLOOM_VERIFIER_ARTIFACT_ROOT` a persistent directory outside temporary folders and source worktrees, and `ORLOOM_VERIFIER_REPOSITORIES` a JSON object mapping canonical `owner/repo` to `{ "objectStore": "/absolute/path/to/repo.git", "approvedRef": "refs/heads/main" }`. The application factory disables the runner when any required value is absent. The host image must be built and its final image digest measured before configuring the factory; this repository does not assert that the derived image has been built or preloaded.

## Host proof proposal (not run)

The packet prohibits host changes from this builder. The following commands are for controller inspection and an explicitly selected bounded host-proof window. Run the read-only preflight first. It only inspects the already cached base image, Docker runsc registration, and available disk/memory. Node is inside the cached image; the derived image build verifies its binary hash without changing the protected container:

```sh
docker image inspect ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304
docker info --format '{{json .Runtimes}}'
df -h /var/lib/docker
free -m
```

After review, build from the pinned cached base and record the resulting local image ID without pushing it. Docker's local image ID (`sha256:<64 hex>`) is accepted as the immutable verifier image binding; no repository digest or registry is required:

```sh
docker build --pull=false -f Dockerfile -t orloom-verifier:review infra/verifier-isolation
docker image inspect --format '{{.Id}} {{json .RepoDigests}}' orloom-verifier:review
```

Before running a real candidate, the operator must provision the fixed `/run` staging root and persistent artifact root, configure one canonical bare object-store map/ref, and pass an actual extracted bundle to `LocalRunscLauncher`. Record image digest, input manifest digest, exact runsc runtime, wall time/resource observations, stdout/stderr hashes, and timeout/negative evidence. No source directory may be bind-mounted. A source-only smoke, this syntax check, and host preflight do not constitute the integrated private-route/PostgreSQL certificate proof.
