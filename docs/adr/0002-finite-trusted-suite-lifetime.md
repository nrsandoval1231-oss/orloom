# ADR0002: finite trusted suite lifetime

Status: accepted architecture plan; implementation and live qualification are separate gates. Date: 2026-10-16.

The complete fixed suite cannot fit the original ten-minute request ceiling on the intended runsc host. Separate same-profile diagnostics measured an assembled 1,132,996 ms estimate for all test files and initial setup. This estimate is not a certificate. The failed v9 full run and all UNKNOWN evidence remain unchanged.

Keep the V1 request, receipt and certificate shapes and digest algorithms. Explicitly extend the absolute request range to 2,100,000 ms. Suite policy `orloom.node-repo-suite.v10` binds the image suite to 1,800,000 ms, Docker attach to 1,830,000 ms, host launcher to 1,845,000 ms and trusted attempt to 1,860,000 ms. The unchanged 120,000 ms reporting grace ends below the absolute ceiling. These catalog values cannot be selected by mission text, worker output or request payload. Coordinator and runner admission must enforce the exact selected policy lifetime, including rejection of forged extended syntax requests.

Preserve every stage, discovered test, serial execution, one concurrent verifier, 1 CPU, 2 GiB memory/swap, 128 PIDs, runsc, nonroot, no network, read-only root, filesystem/input/log bounds and immutable image binding. Syntax behavior stays at 60 seconds; its digest stays identical for identical image inputs and changes when rebound to a different image. Never strip the image binding or reuse certification across policy/image changes.

Old bounded V1 records remain historically valid. Older readers reject longer requests, so rollout must be coordinated with no in-flight policy upgrade or mixed-version execution. Certificate eligibility still binds exact policy version/digest/image/candidate/epoch/head. No old UNKNOWN is retried, settled or refunded by this decision. Late PASS/FAIL remains rejected; only truthful UNKNOWN can be reported during authenticated grace. Task and capacity authority must independently cover the whole sequence; worker lease limits remain unchanged.

The longer ceiling increases bounded single-lane occupancy, not execution authority. Preserve the owner-approved provider and infrastructure caps. Qualification requires frozen-source Linux gates, independent source review, rebuilt image binding and one genuine full runsc suite. A further timeout remains UNKNOWN and requires a new evidence-based replan.

Independent plan audit: Astra `ACCEPT`, frozen private ADR SHA256 `eebab2ae6b644ea9562ba6700a0ce0629db7dcd2d8771ab5ce0d398f215b467a`, packet SHA256 `8fe5cc62fb08373d2d1193d414b7128aa75fe00c69b4449e3a653206b5c4f32c`. The earlier `CORRECT` audit and superseded drafts are retained. This source ADR summarizes that accepted plan; final implementation review must include this exact source text.
