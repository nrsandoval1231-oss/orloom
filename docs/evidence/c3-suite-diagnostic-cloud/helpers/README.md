# C3 suite diagnostic harness

This harness is a one-shot, diagnostic-only wrapper around the compiled `extractCandidateBundle`, `getCheckPolicy`, and `LocalRunscLauncher` modules from an exact frozen source payload. It has no PostgreSQL client, Governor, capability, mission attempt, artifact store, certificate route, provider, or runtime secret.

It is prepared only. Root must review, hash, freeze, stage, and explicitly execute it. It does not change the original full-suite attempt: that attempt remains `UNKNOWN` with no certificate.

## Required frozen inputs

The root-owned host directory is fixed to `/var/lib/orloom/c3-suite-diagnostic-20261013`. It must be absent before `stage-diagnostic.sh` runs. Root supplies the following files under its sibling upload directory `/var/lib/orloom/c3-suite-diagnostic-20261013.incoming/` from the same frozen source candidate:

- `candidate.bundle`: complete-history bundle exposing exactly the approved source ref.
- `candidate-identity.json`: candidate SHA, base SHA, source ref, source-manifest digest, and bundle digest.
- `runtime-files/`: the hash-checked compiled runtime payload containing the real verification modules.
- `stage-bindings.json`: root-written source/payload identity with exactly `baseSha`, `candidateSha`, `approvedRef`, `sourceManifestSha256`, and `runtimePayloadSha256`.

After the local image build, root supplies `diagnostic-bindings.json` with the staged source/payload fields plus the measured image and protected-container identity. It must contain exactly:

```json
{
  "baseSha": "<40 lowercase hex>",
  "candidateSha": "<40 lowercase hex>",
  "approvedRef": "refs/heads/<frozen source ref>",
  "sourceManifestSha256": "<64 lowercase hex>",
  "runtimePayloadSha256": "<64 lowercase hex>",
  "image": "sha256:<64 lowercase hex>",
  "imageDigest": "<64 lowercase hex>",
  "protectedContainerId": "<64 lowercase hex>"
}
```

The image must be rebuilt from the frozen source and have a new measured digest after Luna's advisory progress change. The harness rejects an image/digest disagreement. It uses the fixed `node-repo-suite-v1` policy and therefore retains its 60-second, one-CPU, one-GiB limits. The policy result is recorded only as diagnostic evidence.

## Staging and execution

1. Root uploads the exact bundle, identity, runtime payload, bindings, and these reviewed helpers to the sibling upload directory. No credentials or database files belong there.
2. Run `stage-diagnostic.sh`. It validates the incoming hashes, creates a complete bare `source.git`, checks the base/candidate/ref relationship, and copies the previously hash-checked Node binary from `/var/lib/orloom/c3-suite-proof-20261013/staging/node`. It never runs npm, Docker, a provider, or a verifier.
3. Run `build-image.sh`. It requires the cached pinned base image, uses `docker build --pull=false`, and records the resulting local image ID. The only package installation is the source Dockerfile's lock-bound `npm ci --include=dev --ignore-scripts`; no credentials are passed to Docker. Root then uploads the final binding and runs `bind-image.sh` to bind the measured image to the staged candidate.
4. Run `run-diagnostic.sh`. It performs the fresh capacity/protected-container read-only gate, imports the compiled real extractor/policy/launcher, and makes one direct `LocalRunscLauncher` call through the frozen source's existing `infra/verifier-isolation/launch-verifier.sh`. The actual runtime remains canonical `ORL-C3`; the diagnostic image build label is evidence-only. The canonical verifier state must be empty before launch.

The result is written as a digest-bound `diagnostic-result.json` with elapsed time, pre/post resource observations, exact source/policy/image identities, exit ambiguity flags, and only validated advisory progress frames. Raw stdout/stderr are not retained by this harness. A PASS or FAIL is still **diagnostic only** and must not be submitted anywhere.

After an ambiguous outcome, the driver waits up to ten seconds for the existing host-wide lock and records canonical state. It does not remove a container itself: any nonempty canonical state requires the existing exact-CID reconciliation path and operator review.

## Deliberate limits

- No runtime network, mounts, database, provider, certificate, or mission side effect.
- No retry loop or change to the original `UNKNOWN` evidence.
- No deadline or resource-cap increase.
- The source worktree, old suite proof helpers, archived evidence, and frozen PR #2 are outside this harness.
