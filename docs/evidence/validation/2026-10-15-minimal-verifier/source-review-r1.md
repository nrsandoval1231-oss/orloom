# Independent minimal verifier source reinspection R1

Disposition: NO REMAINING MATERIAL SOURCE FINDINGS in the reinspected candidate. Original P1 HOME binding mismatch is resolved. This is source approval only, not runtime qualification or runsc certification.

Baseline remains main 9457b1bcb10b085602f337b253580d23ad0b1d93. Inspected actual uncommitted source bytes in orloom-minimal-verifier on 2026-10-15 UTC. Original MINIMAL_QUALIFICATION_SOURCE_REVIEW.md is retained unchanged (SHA-256 584a00585d564a8d6235398031c93fe4cb41547fa738828f10f09d7b828a4340).

The runner now supplies exactly PATH=/usr/local/bin:/usr/bin:/bin, HOME=/nonexistent, TMPDIR=/work, LANG=C, CI=1 and NODE_ENV=test, matching NODE_REPO_SUITE_BINDING.tools.stageEnvironment. The only runner change relative to baseline is addition of TMPDIR=/work. The added source parity assertion matches these repaired bytes. Policy manifest/version v7 and the existing pinned expected digest remain consistent with the intended environment; the repaired runner now implements that binding.

Reinspected complete production and fixture diff against baseline. Dockerfile, policy and parity-test hashes remain the original reviewed values; the pinned base/Node binary/lock checks, full dev dependency installation, all helper copies, and seven stages remain intact. Fixture-only parent selection and read-only cleanup remain as originally reviewed: private-mode assertions retained, lstat skips static symlinks, copied directories become searchable/writable before descent. No isolation, source immutability, stage, deadline, network, identity, mount, resource or activation weakening appears in the diff. Production/test classification and the original review's stated cleanup race limitation remain applicable.

Identity anchors (SHA-256):
- infra/verifier-isolation/run-repo-suite.js: 372456ff01674a646b7017c6934d62186fd61b11ceca3125c966f488375829ab
- infra/verifier-isolation/Dockerfile: d8317899ef19bc6cfbf34edb3f91176d496a1d4218feabefa8e81a2909a713f4
- packages/verification/src/policy.ts: 171e584944c9776df3036e24116da3452b702a6818a5b23f2a2c152fbdbccb9c
- tests/verification-runner.test.ts: f307ae296b7b3d461683dbcd0cd2ce2f23ae6363529e5509077d5fef91038c05

Validation here: actual source inspection, full relevant baseline diff reinspection and git diff --check (pass). No Docker, host execution, build, test or runtime commands were run by this reviewer. The old in-progress image/input containing HOME=/work is stale failed-candidate evidence and cannot certify this revision. Controller must rebuild from the corrected runner, freeze the exact source/input/image identities, and complete independent exact-image Linux nonroot/read-only-source affected checks and full suite. Those gates remain pending; no accepted runtime claim is made.
