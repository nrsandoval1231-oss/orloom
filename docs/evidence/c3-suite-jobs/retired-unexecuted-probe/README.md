# C3 focused jobs probe — DRAFT, NON-CERTIFYING

This packet is only for frozen source candidate
890209224cd042f5367085ffdf5591b3aa92d739. It runs compiled
dist/tests/jobs.test.js after the same offline dependency admission, typecheck,
and clean build used by the suite image. It has no PostgreSQL, certificate,
trusted-check request, receipt, or normal-suite runner path.

The operator supplies a reviewed transfer at candidate-8902092/transfer and a
reviewed selected-transfer.json. The stage script refuses any other candidate,
base, source-manifest, image digest, or package layout. The run script is
one-shot: it preserves a marker and all evidence if it reaches dispatch, even
on failure.

PASS is diagnostic only: exit zero; both named behaviours in TAP output; and
observed exact-CID cgroup events max=0, oom=0, oom_kill=0. It cannot create a
C3 certificate or change any prior attempt.
