# Final independent qualification evidence review

Disposition: NO MATERIAL OVERCLAIM OR REMAINING SOURCE BLOCKER found for publication as local runc image/source qualification, with exact-publication-head external review and host runsc acceptance still open. This is an independent read-only review of retained evidence, not a rerun or live certification. Prior reviews remain unchanged.

Reviewed recorded qualification-r2 summary/result/decoded output and frozen source entries, public evidence copies and evidence-manifest, image-build/identity, syntax result, ledger and CURRENT_STATE/WORK_GRAPH. No Docker or host commands were run. git diff --check passes.

Independent arithmetic from the actual suite-result decoded stdout: 66 test-summary blocks; 383 tests, 382 pass, 0 fail, 1 skipped, 0 cancelled and 0 todo. 382+1=383. All seven stage END records are zero. The slow-pipe regression is present and passes. The sole skip explicitly says Linux ownership and mode checks require the deployment-host acceptance lane. The output states final manifested input rehash passes. Recorded process and inner exit are zero, timeout false, parseError null, truncated false, decoded stdout 45,868 bytes and stderr empty. Decoded stdout exactly equals published suite-stdout.txt. Recorded outer capture is 95,431 bytes. Elapsed 206,150ms is 206.150s, below the unchanged 360s stage budget. Syntax result separately records exit0/no timeout/no parse error/555ms under the same image and runc.

Image build log ends with successful image 0f068249a489; identity and both run results name sha256:0f068249a489b8a74a4ff3ad513b02ae5319a3531256f1b0c132dc7ffb6882cf. Runtime is expressly runc and purpose expressly local compatibility, not runsc/trusted certification. Ledger and latest state/graph preserve that boundary and leave live provider/GitHub task, runsc and deployment gates open. No accepted operational task or product completion follows from this evidence.

All 201 frozen source entries were independently compared to current file size and SHA-256: zero mismatches; total 1,806,972 bytes agrees with receipt. All published evidence-manifest entries independently hash correctly. The six source identity anchors recorded in SOURCE_REVIEW_R2.md remain exactly unchanged, including shared emitter, both runners, Dockerfile, policy and regression test. Documentation/evidence added after runtime do not alter these qualified production/test bytes. Current metadata says sourceHead is baseline HEAD; the frozen entries, not that uncommitted HEAD alone, bind the tested candidate. A future publication commit must retain those exact entries.

Hash naming clarification (nonblocking, reported to controller): d82ee73941cd4a66d99dd41aace557402962bdcae7a40ff044058054bccac596 is the exact compact wrapped input manifest.json hash, independently verified in private qualification-input-r2/manifest.json. Published source-manifest.json is the pretty-printed files array and hashes 38fd1be1bb4789044d6f00c7b3d6286e5b8dc49ea249f91f9ffb564336db02fc. Its entries match the actual input manifest/current source. Ledger should distinguish the input-manifest hash from the array artifact hash, ideally publishing the exact wrapped manifest bytes as well.

Supporting artifact SHA-256 anchors at review:
- published source-manifest.json: 38fd1be1bb4789044d6f00c7b3d6286e5b8dc49ea249f91f9ffb564336db02fc
- published suite-summary.json: 6a904499ece4f676002ce48cbd132146da5da106fc7996d27693f32ae77e5ae0
- published suite-result.json: dc8976a6b4b8643aa1532294153b18a9866867d5affba8001d2a291e046af931
- ledger before naming clarification: e6ab3e1e44777265982870b82723de993c72a3d4b79b362343aff840cd24736b
- emit-result.js: cc968fd7aa17caa9636c20c44570bd7073d86ebbdb494e192a72a2af2246ec76
- run-repo-suite.js: 8269628cf3965da4fa10558b736892199cdec4d41e9adaf80c005eed2987a671

Remaining gates: publication commit/PR identity and independent review of that exact head; immutable operational image binding; fresh capacity and credential-free host runsc acceptance. Controller owns publication. Local compatibility evidence is sufficient for the stated focused PR claim, not for closing those gates.
