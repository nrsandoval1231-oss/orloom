# PR #2 worker evidence provenance

Original source: [PR #2](https://github.com/nrsandoval1231-oss/orloom/pull/2), head `639bff0759870d3522ae38d2887b75fe6c4297c7`, Git tree `c8f98ac6b2ad6387b8bc741d87e9f0168b3fbea7`.

The [original inventory](orloom-pr2-evidence-manifest.json) compared untruncated trees against PR #17 `410882d4afff33e028be50b816ad69eb387eae6d`. Within `.agent/` and `work/worker-runtime-proof/`, it selected 83 blobs: 40 already identical, 40 missing and three conflicting historical state records. This inventory baseline predates merged repair PR #18; it is not a claim about an unverified later branch tip.

The successor publication includes:
- [40 exact original evidence blobs](orloom-pr2-evidence-tree-elements.json), including retained controlled runtime proof.
- [Three original state archives](orloom-pr2-historical-state-tree-elements.json) under `.agent/history/pr2-639bff07/`, preserving old CURRENT_STATE, WORK_GRAPH and WORKER-ORL-005B without overwriting current state.
- [Three historical checkpoint documents](orloom-pr2-checkpoint-tree-elements.json) under `docs/checkpoints/`: CLOUD_SETUP_HISTORICAL, REFERENCE_AUDIT and WORKER_SAVE_CHECKPOINT.

Historical setup directions and verdicts remain bound to their original circumstances. They do not authorize new credentials, activation or provider spending, and controlled-provider Docker proof is not live DeepSeek or successor acceptance. Reviewed source composition is covered separately by [the worker validation ledger](2026-10-14-worker-composition.md).

Parent ancestry preserves history but cannot substitute for the explicit tree entries above. Compare every path/blob/mode triple with the actual publication tree before closing PR #2 as superseded. Publication identity and disposition are supplied by the containing Git commit and associated PR; no successor merge is claimed here.
