# ORL-C3 approved build packet — Orloom local trusted verification

**Decision: PROCEED, conditional on C1a's accepted base being recorded.** Build one local exact-commit check path, durable evidence, and a PostgreSQL certificate. This is Orloom-owned CI evidence, not a GitHub Check or remote-head assertion. Worktree `work/orloom-ci`, branch `feat/trusted-verification`, starts at `545279c7b53fef8453c8e50ae0bc7f0d790959af`; dispatch records the independently accepted C1a source SHA and any proof-only metadata integration. Main `6110c692f47202978b2d22d22f6522aa4aa59277`; frozen PR2 `8bbcfffbf631e5ad2972e34b41284198afc566e2` stays untouched. No deployment, provider call, new paid resource, broker change, or lesson promotion.

## Shared contract: bootstrap before parallel work

Contract owner adds only `packages/contracts/src/verification.ts` and its deterministic contract tests, then freezes its exported signatures. Use a **single Luna** for this prerequisite. Two disjoint builders may start only after the controller accepts that exact contract. Names below are the agreed API; changing them needs controller reconciliation before integration.

```ts
type Sha256 = string; // exactly 64 lowercase hex characters
type CommitSha = string; // exactly 40 lowercase hex characters (repository is SHA-1)
type ArtifactRef = `sha256/${string}`;
type CheckOutcome = "pass" | "fail" | "unknown";

interface TrustedCheckRequestV1 {
  version: "orloom.trusted-check-request.v1";
  attemptId: string; // UUID, allocated by trusted control plane
  missionId: string; sliceId: string; leaseEpoch: number;
  repository: string; candidateSha: CommitSha; expectedLocalHeadSha: CommitSha;
  planDigest: Sha256; checkId: string;
  policyVersion: string; policyDigest: Sha256;
  verifierImageDigest: Sha256; inputBundleDigest: Sha256;
  requestedAt: string; expiresAt: string; // UTC ISO-8601
}
interface TrustedCheckReceiptV1 {
  version: "orloom.trusted-check-receipt.v1";
  request: TrustedCheckRequestV1;
  verifierId: string; runtime: "runsc"; sandboxId: string;
  outcome: CheckOutcome; exitCode: number | null;
  startedAt: string; finishedAt: string;
  stdout: { key: ArtifactRef; sha256: Sha256; bytes: number };
  stderr: { key: ArtifactRef; sha256: Sha256; bytes: number };
  inputManifest: { key: ArtifactRef; sha256: Sha256; bytes: number };
  receiptDigest: Sha256; // sha256(canonicalJson(all receipt fields except receiptDigest))
}
interface TrustedVerifierCapabilityV1 {
  attemptId: string; verifierId: string; expiresAt: string;
  // secret itself is never serialized to request, receipt, event, or log
}
interface CheckCertificateV1 {
  version: "orloom.check-certificate.v1";
  certificateId: string; attemptId: string; missionId: string; sliceId: string;
  leaseEpoch: number; repository: string; candidateSha: CommitSha;
  localHeadSha: CommitSha; checkId: string; planDigest: Sha256;
  policyVersion: string; policyDigest: Sha256;
  receiptDigest: Sha256; certifiedAt: string;
  scope: "local-exact-commit";
}
interface TrustedCheckService {
  prepare(missionId: string, sliceId: string, checkId: string): Promise<TrustedCheckRequestV1>;
  run(request: TrustedCheckRequestV1): Promise<TrustedCheckReceiptV1>;
  submit(receipt: TrustedCheckReceiptV1, capability: string): Promise<CheckCertificateV1 | null>;
  getCertificate(missionId: string, sliceId: string, checkId: string): Promise<CheckCertificateV1 | null>;
}
```

Canonical JSON follows existing `packages/judgment/src/canonical.ts`; exact-field validation rejects additions, omission, noncanonical SHA, malformed times, oversized values, and nonfinite numbers. The request and receipt contain no worker credentials or operator-provided artifact URLs. `inputBundleDigest` is computed after trusted local Git extraction; prepare may reserve an attempt, but the **runner**, not the worker, supplies the bundle digest to the finalized request before execution. If that requires a two-step implementation, keep `prepare` internal and return only a finalized request from the public method. Receipt digest proves byte identity, not origin; origin comes from the verifier's private capability and control-plane-issued attempt binding.

## Trust and execution boundary

Map canonical `owner/repo` to one operator-configured, immutable local bare Git object store and an operator-controlled ref in trusted configuration. Never derive a filesystem path, Git remote, Docker option, or check command from mission or worker text. Disable hooks, attributes-based filters, external diff, submodules, alternates, and unsafe repository config. Verify `candidateSha` is a commit object reachable from the approved ref; `baseSha` ancestry and approved plan apply. Extract from the object database without checking out on the host. Enumerate tree entries before transfer: permit bounded regular files only, reject symlinks (`120000`), gitlinks (`160000`), traversal, case-colliding paths, specials, oversized file/count/aggregate. Stage a bounded deterministic manifest plus regular bytes into the sandbox; verify every hash inside. No host source mount.

The existing `infra/worker-isolation/launch-worker-sandbox.sh` is immutable and cannot host this runtime: it has a fixed worker image, 32 MiB `/work`, and UID 65532 (Node under `/root` is inaccessible). Implement a separate narrowly configured verifier launcher, borrowing its security invariants: digest-pinned image preloaded locally, `runsc`, no network, read-only root, nonroot, dropped capabilities, no new privileges, fixed CPU/memory/PID/time limits, bounded per-container tmpfs, no Docker socket or credentials inside. Build/pin a verifier image with an executable Node path accessible to UID 65532 and pinned dependencies. The control plane calls a privileged local launcher/runner, never exposes Docker arguments. Establish measured caps from the existing DO `runsc` host before enabling; initial policy is **one concurrent check, at most 60 seconds, at most 16 MiB input, at most 64 KiB each stdout/stderr**. Raise only with measured evidence and a policy digest change. First check ID is a fixed `node --check scripts/validate.mjs` over the candidate's actual bytes; use a trusted fixed argv/cwd/env in the pinned image. Additional catalogued checks, including typecheck, require separate capacity proof and policy version. Timeout, signal, truncated logs, missing output, or lost process makes outcome `unknown` and cannot certify.

Artifacts live under a configured persistent local directory outside temp and source worktrees, with mode-0700 parents, same-filesystem atomic write/rename, `O_NOFOLLOW`/regular-file checks, no replace, file+directory fsync, and read-back hash verification. Keys are strictly `sha256/<hex>`; reject symlinks at every path component and hash mismatch on every read. The existing `LocalArtifactStore` is memory-backed and is **not** an acceptance store. Persist input manifest, bounded logs (including empty logs), and receipt. PostgreSQL holds only immutable keys/hashes and attempt/certificate metadata. A crash between artifact write and DB commit leaves an orphan for explicit reconciliation, never a certificate.

## Certification join

Add an internal verifier submission route or equivalent process boundary, isolated from `/api/worker/*` and owner session auth. The control plane mints a random, single-attempt, short-lived verifier capability; store only its hash in PostgreSQL and deliver it only to the trusted runner over the local protected channel. No worker/owner token can invoke submission. On submission, validate exact receipt schema and digest, capability, attempt identity, pinned image/policy, artifact read-back hashes and byte limits. In one transaction lock the attempt, mission/slice, and certificate key; require approved plan, `awaiting_verification`, matching mission repository, exact candidate SHA, lease epoch, plan/check/policy binding, and local authoritative head observed **during submission** from the trusted mapped repository/ref. `expectedLocalHeadSha`, observed local head, and candidate must agree under the selected fast-forward/ref policy; stale or unreadable local ref is `unknown`, not PASS. Pin the head observation timestamp/digest to the certificate. A duplicate identical submission returns the same certificate; conflicting or expired submission rejects. Record fail/unknown attempts without certificates. On PASS insert one certificate and one `check.certified` mission event in that transaction. Do not call `integrate`, change slice status to `verified`, release reservations or dependency blocks, or enable lessons. Expose read-only certificate status to the owner. A local ref observation says nothing about remote GitHub freshness.

## Two bounded build packets after contract freeze

**Luna A, runner ownership:** new `packages/verification/src/*`, `apps/verifier/src/*`, verifier image and launcher under `infra/verifier-isolation/*`, `tests/verification-runner.test.ts`. Own exact-object extraction, policy catalog, isolated execution, persistent artifact store, receipt production, and existing-host `runsc` proof. Do not edit Governor, SQL store, control-plane server, C1a source, or PR2. Deliver exact image digest, manifest, artifact hashes, measured resource use, and failure/timeout evidence.

**Luna B, certification ownership:** `packages/contracts/src/{mission,sql-mission-store,memory-mission-store}.ts`, `packages/governor/src/governor.ts`, `apps/control-plane/src/{main,server}.ts`, `packages/config/src/config.ts`, one additive `db/migrations/004_verification.sql`, `tests/verification-certification.test.ts`. Own attempt/capability issuance, PostgreSQL transaction, owner read-only view, and negative authorization/concurrency tests. Import the frozen shared contract; do not implement a substitute receipt, fake runner, or alter C1a promotion guard. Memory store may explicitly reject certification; only PostgreSQL plus durable file artifacts is acceptance.

**Serialized join:** controller integrates A then B against the accepted base, runs a genuine runner-to-private-route-to-PostgreSQL check, restarts runner/control plane/PG connections, reads artifacts back, and sees one certificate. Negative proof changes candidate, local ref head, policy, plan, lease epoch, artifact bytes/key, capability, and verifier image, and exercises concurrent duplicate submission plus interrupted execution. Run focused tests, typecheck/build, affected suite, `npm run validate`, real multi-connection PG proof, exact diff/manifest check, then independent exact-candidate review. Preserve raw exits and hashes. No certificate is accepted from only mocked Docker, memory store, worker assertion, or owner-supplied receipt.

**Open boundary:** no GitHub App/R2 credentials means remote-head freshness, GitHub Check publication, cloud retention, and cloud CI remain UNKNOWN/BLOCKED. C3 certificates carry `scope: local-exact-commit`; C1b must separately join certified independent check attempts to C1a progress event IDs and evaluate lessons. C4 owns integration and PR delivery. No local certificate may be presented as full product completion.

## Controller dispatch boundary

Current source base is 545279c7b53fef8453c8e50ae0bc7f0d790959af, independently source-reviewed with 51 tests passing. C1a real PostgreSQL proof is in progress; C3 implementation dispatch remains pending its result. Full CI build/test/typecheck/lint/security policies, independent final engineering certification, R2 retention, and GitHub Checks remain parent requirements. The initial syntax-check certificate cannot satisfy those requirements by itself.

## Contract-only READY node

Controller selects the shared, pure contract prerequisite while C1a real-PG proof finishes. This node depends only on the independently reviewed canonical JSON/source contract at 545279c, not on cloud behavior; it cannot issue capabilities, execute checks, write database state, or certify outcomes. The runner/certification join remains dependent on bounded C1a runtime acceptance. Contract owner may edit only packages/contracts/src/verification.ts, tests/verification-contract.test.ts and .agent/ORL-C3-CONTRACT-COMPLETION.json. Define/export the exact packet types, strict parsers/validators, and canonical request/receipt digest helpers; finite sizes/time windows and malformed nested field rejection. Tests must exercise external untrusted JSON, unknown/extra fields, invalid digests/timestamps/outcome-exit relationships, deterministic key-order hashing, and absence of serialized secrets. Do not add dependencies or alter existing source, config, schema, policy, or PR2. No provider/host actions or claims of live verification. Run focused build/test/typecheck, then release signatures and files for disjoint runner and certification lanes. Two materially different local repairs maximum; preserve failures and report real constraint. No commit/push/merge/deploy by builder.

## Frozen temporal rule

The pure receipt parser permits truthful finishedAt after request.expiresAt only for UNKNOWN with null exitCode. PASS/FAIL must finish by the execution deadline. The trusted runner classifies late completion, timeout and interruption as UNKNOWN without trimming timestamps. Certification must enforce a separate 120-second capability/reporting grace; within grace authenticated UNKNOWN may terminalize the attempt without a certificate, and after grace the server watchdog terminalizes UNKNOWN and rejects late submission. No model or worker controls either deadline.
