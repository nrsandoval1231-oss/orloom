# ORL-C3 suite runtime proof packet

These helpers are prepared only; none has run against DigitalOcean or PostgreSQL. The accepted source candidate is `06a74acfb456b5835cb19dcf71c73fa11f278d0f` on `feat/trusted-verification-suite`, based on `226e4d9ac26f2b83b05b82f678dc07966a1b6bdb`, with suite-manifest SHA-256 `15a0d1330ed53cad8d0560568f25bf4569f93b1e530d1b8b709e154a979ce8a2`. Its complete bundle, runtime payload, and direct-child fixture commits are staged under `candidate-06a74ac/`. No fixture commit is written to the source repository.

## Proof path

1. Run `setup-disposable-postgres.sh prepare <root-owned-preflight.json>` once. It creates the fresh proof root and only resources named `orloom-c3-suite-proof-20261013-*`, labeled `ORL-C3-SUITE-PROOF`, without host ports or bind mounts. It stores the DSN in a mode-0400 file and never prints it. Keep the cleanup helper available if later staging fails.

2. On the clean final `work/orloom-suite` checkout, set the candidate, base, suite-manifest digest, and output directory inputs, then run `prepare-runtime-files.mjs` followed by `prepare-transfer.mjs`. The latter writes a complete-history candidate bundle, exact candidate identity, and verified runtime payload into a new transfer directory. Transfer `candidate.bundle`, `candidate-identity.json`, and `runtime-files/` into the fresh host root's `incoming/`. Then run `stage-runtime.sh prepare <base-sha> <candidate-sha> <suite-manifest-sha256>`. It verifies the bundle ref and digests, checks all 116 suite-manifest file hashes, creates the exact clean checkout, stages only ignored compiled/runtime paths, and copies pinned Node from a dedicated labeled cached-base container that it never starts. It removes that exact container ID after verifying its image/config identity.

3. Prepare independent fixture commits in a new dedicated fixture store on the Linux proof host so `fixtures.json` records the host's absolute object-store path:

   ```sh
   cd /var/lib/orloom/c3-suite-proof-20261013
   ORLOOM_PROOF_SOURCE_REPO=/var/lib/orloom/c3-suite-proof-20261013/source \
   ORLOOM_PROOF_BASE_SHA=<accepted-base-sha> \
   ORLOOM_PROOF_CANDIDATE_SHA=<frozen-candidate-sha> \
   ORLOOM_PROOF_SOURCE_REF=refs/heads/feat/trusted-verification-suite \
   ORLOOM_PROOF_FIXTURE_ROOT=/var/lib/orloom/c3-suite-proof-20261013/fixtures \
   /var/lib/orloom/c3-suite-proof-20261013/staging/node \
   /var/lib/orloom/c3-suite-proof-20261013/incoming/prepare-fixtures.mjs
   ```

   The helper verifies a clean source HEAD/ref and base ancestry, then writes three one-file commits parented directly to the frozen candidate: a real Node test failure, an appended lockfile byte, and a real infinite-loop test. All refs and generated objects stay in `fixtures/objects.git`.

4. After inspecting the exact candidate and Dockerfile, run `build-suite-image.sh prepare <base-sha> <candidate-sha> <suite-manifest-sha256>`. It verifies the clean candidate and ancestry, pins the existing base image, and builds with the repository root as context. The Dockerfile's locked package install is the only package-fetch step; lifecycle scripts are disabled there.

5. Place `runtime-proof.mjs`, `runtime-proof-entry.mjs`, and `prepare-fixtures.mjs` under the root's `incoming/`. The runtime packager includes contracts, judgment, governor, verification, learning, stuck-resolver, verifier app modules, and the locked `pg` dependency tree. Do not run npm or fetch packages on the host as part of the proof.

6. Run `run-proof.sh <base-sha> <candidate-sha> <source-manifest-sha256> <runtime-proof-sha256> <runtime-proof-entry-sha256>`. It invokes the real coordinator path with one exact trusted policy, persists each attempt's request, receipt, input manifest, stdout/stderr, and per-stage stdout as soon as the attempt completes, then checks certificate reconnect persistence and stale-ref hiding. After the actual 60-second hanging attempt returns UNKNOWN, it performs a read-only nonblocking flock probe for up to 10 seconds and records the result before starting another candidate; if the old launcher still owns the host slot, the proof stops and retains UNKNOWN. A failing test and lock mismatch must yield `fail` without certificates. The hanging test must run until the fixed suite timeout and yield `unknown`, with no certificate or automatic redispatch. Its scopes are distinct and remain reserved by the terminal verification attempts.

7. The following guarded launch reconciles any exact timeout CID still recorded in `/var/lib/orloom/verifier/state`; its state is retained under the hanging attempt before that launch. If the launcher leaves a nonempty state record afterward, the proof stops for exact operator reconciliation. Once evidence is retained and the verifier slot is clear, `cleanup-disposable-postgres.sh cleanup <candidate-sha>` removes only recorded IDs whose live identity still matches this packet, then removes the mode-0400 DSN. It keeps source, fixture objects, image, and evidence for review.

## Inputs still required

- Final source checkout copied to the dedicated host proof root; compiled source image and runtime payload generated from the frozen candidate; Node staged from the exact cached base image.
- Root-owned, current capacity preflight JSON; pinned verifier image build and its resulting local image ID; PostgreSQL setup IDs; and the host path for the root-only DSN file.
- The actual observed runtime evidence. A suite taking longer than its fixed 60-second budget or exceeding 1 GiB remains `UNKNOWN`; this helper does not retry or widen limits.

Per-stage stdout is recovered from the trusted runner result when it emits a complete result marker. The runner exposes stderr only at attempt level, so it is retained once in `stderr.bin` and its stage attribution remains unknown. The current trusted adapter intentionally discards incomplete launcher output when the 60-second timeout makes process state ambiguous; in that timeout case the durable attempt still has its receipt, input manifest, and bounded (possibly empty) stdout/stderr artifacts, plus the redacted stage/error frame. Do not represent those missing stage logs as captured output.

The setup helper rechecks current available memory (at least 2 GiB) and `/var/lib` free space (at least 4 GiB) before creating any resources. These thresholds are admission checks; observed peak verifier CPU or memory remains unmeasured unless separately provided by the runtime.
