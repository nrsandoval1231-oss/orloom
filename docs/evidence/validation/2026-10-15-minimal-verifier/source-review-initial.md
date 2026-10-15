# Independent minimal verifier source review

Disposition: CHANGES REQUIRED for the reviewed frozen candidate. Source-only review; no Docker, host execution, runtime acceptance, or runsc certification is claimed.

Baseline: main 9457b1bcb10b085602f337b253580d23ad0b1d93. Candidate: uncommitted working tree in orloom-minimal-verifier, inspected 2026-10-15 UTC. Read .agent/MINIMAL_VERIFIER_PACKET.md and docs/architecture/CANONICAL_HARNESS.md; inspected complete tracked diff, completion/current-state claims, relevant policy admission and runner code, and private Dockerfile.slim. No source edits made.

## Material finding

P1 — Actual stage HOME diverges from the digest-bound policy and approved scope. infra/verifier-isolation/run-repo-suite.js:20 sets HOME to /work, whereas packages/verification/src/policy.ts:20 binds HOME=/nonexistent and TMPDIR=/work. The packet authorizes only the executable temp selection repair, and README, completion JSON, current state and work graph explicitly say HOME remains /nonexistent. Consequently an image built from this candidate runs stages under a different environment from the one represented by policy v7/digest 4b6cbe6f69a24b44abd42a970d56b08dbee4f424f5e2d094c7471475de2d1491. tests/verification-runner.test.ts:120 also requires the literal HOME=/nonexistent pair and cannot match this runner. Restore actual HOME=/nonexistent, then rebuild/refreeze and run the controller checks for that exact repaired source. Any result from the current image cannot accept the intended environment.

Reviewed identity anchors (SHA-256):
- run-repo-suite.js: 8b3341ad1e15e32f355516f586efa0c897f2848b36a1e1fdf25a2a0575b12b55
- Dockerfile: d8317899ef19bc6cfbf34edb3f91176d496a1d4218feabefa8e81a2909a713f4
- policy.ts: 171e584944c9776df3036e24116da3452b702a6818a5b23f2a2c152fbdbccb9c

## Other source conclusions

No additional material finding in the remaining diff. Production changes are the image recipe and trusted stage environment/policy identity. The startup fixture parent and packaging cleanup changes are test-only. They do not change production path/private-mode validation or manifested-input verification.

Dockerfile uses the exact private measured node base digest, checks the existing exact Node binary SHA-256, retains checks for both package/lock hashes, installs the full lock via npm ci --include=dev --ignore-scripts in env -i with separate empty config files, removes install cache, retains all six image helper files, and verifies git/prlimit/tar/sh/bash presence. Debian package versions are recorded; snapshot configuration retains normal apt signature checks (no trusted=yes or allow-unauthenticated). Package and lock bytes independently hash to their unchanged admitted values. Availability, image digest and actual installed tool versions remain controller runtime/build gates.

The policy advances v6 to v7 and adds tmpdir-work to its manifest identity. The finite request runner still rejects any policy version, digest, or configured image binding mismatch. Seven fixed stages, deadlines, resource settings, isolation launcher, source admission, askpass eligibility and post-execution manifested-input verification are unchanged by the diff. No worker/UI/dependency/activation change is present.

Packaging cleanup uses lstat, returns immediately for symbolic links, chmods a copied directory before descending, and operates only below the fixture stage in the inspected call tree. This addresses copied read-only directory traversal without following static symlinks into original inputs. There is no newly introduced production cleanup path. No new adversarial concurrent-symlink race guarantee is inferred for this test helper.

Startup fixture now selects trusted TMPDIR or the repository parent on Linux instead of os.homedir(); under the intended stage env this resolves to /work, outside /work/source. Its private policy mode assertions are retained.

Validation performed here: read-only source/diff/hash inspection and git diff --check (pass). No tests executed; no accepted runtime claim. Controller independently owns Linux nonroot/read-only-source behavior, exact rebuilt minimal image full suite, immutable input/source/image identities and any PR publication. Parent has been notified of the blocking HOME mismatch and reports that the mismatching image/input will be retained as failed candidate evidence.
