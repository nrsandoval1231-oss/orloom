# Single-lifecycle cloud result: UNKNOWN

Reviewed source 890209224cd042f5367085ffdf5591b3aa92d739 passed 76 local tests and independent source review. This is not cloud acceptance.

One canonical full-suite run on the existing DigitalOcean host ended UNKNOWN after 54,818ms. Attempt ff440387-899e-45c8-802d-fad73bb3ee51 has zero certificates. Five test files finished; jobs.test.js ordinal 6 started before exact-sandbox memory-limit termination. Exact-CID samples and Docker events show oom=1/oom_kill=1 under the 1GiB cap. They do not identify the allocating source line or prove a speed improvement. The single-PGlite-lifecycle change was insufficient.

The separate focused probe was independently rejected and never executed or uploaded. Its draft and review are retained as negative evidence. The actual run reused the reviewed canonical coordinator/runsc path, bound by helpers/helper-manifest.json (SHA256 90ac3fe4da41cd8cdfda802b47f420da7ce43c24b7deec778fbe5c2ed145e175).

Git-blob source manifest: cd6a3329d33c154619a194982bb5a312115e43020dc6e65964bf177336cac86b. Image: sha256:386f3393c2900a05cc95910ad441e6a139e928549248e537714e387c7a50807c. The retained after-cleanup archive SHA256 is 663a85de667b9a2ac7fe8c2636ff9def587a8744594fe3081fc8c63e1f01a723. It contains the actual receipt, artifacts, SQL snapshot and cleanup evidence; archive entries were inspected before extraction.

Postflight confirmed exact disposable resources and credentials removed, shared verifier state absent, lock free, and protected container identity/start/restart/runtime unchanged. No provider calls, additional paid resources, production deployment or PR2 action occurred.

Direction: one reviewed 2GiB suite-only trial, conditional on fresh measured host headroom after PostgreSQL starts, as specified in reviews/c3-resource-direction.md. Prior UNKNOWN attempts are never reclassified. Full CI acceptance, R2/GitHub App publication and deployment remain open.
