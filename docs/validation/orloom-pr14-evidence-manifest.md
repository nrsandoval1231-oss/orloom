# PR #14 historical evidence provenance

Source: [PR #14](https://github.com/nrsandoval1231-oss/orloom/pull/14), exact head `5908bd42fc55e14353a550cc6804354a986881ed`. Destination baseline: [PR #17](https://github.com/nrsandoval1231-oss/orloom/pull/17), `410882d4afff33e028be50b816ad69eb387eae6d`.

The [machine-readable manifest](orloom-pr14-evidence-manifest.json) records the 95 original path/blob/mode entries absent from PR #17. This consolidation preserves those exact existing Git blobs, including binary archives, screenshots and failed outcomes; they are not regenerated. The inventory was prepared read-only on 2026-10-14; its `remote_changes_performed: false` describes that preparation, not the subsequent publication of the containing commit.

Groups:
- [Delivery PostgreSQL evidence](../evidence/delivery-postgres/)
- [Loom PostgreSQL/browser evidence](../evidence/loom-postgres/)
- [Failed full cloud suite and cleanup](../evidence/delivery-cloud-v3/)

All are historical evidence bound to their original source revisions. Inclusion does not certify the new consolidated candidate.

Two historical state blobs are preserved separately as [CURRENT_STATE](../../.agent/history/pr14-5908bd42/CURRENT_STATE.md) and [WORK_GRAPH](../../.agent/history/pr14-5908bd42/WORK_GRAPH.md). The manifest records their original blobs and historical destination paths. Canonical current-state documentation is reconciled separately rather than overwritten by these snapshots. `candidate_blob_sha` in the collision inventory refers to the pinned PR #17 baseline, before that reconciliation.

The publication copy corrects one metadata typo in the prepared inventory: `source_tree_sha` is `6f878e042274c7604a215834593d00e15380967e`, verified from the [source Git commit object](https://api.github.com/repos/nrsandoval1231-oss/orloom/git/commits/5908bd42fc55e14353a550cc6804354a986881ed). The original inventory had repeated the commit SHA in that field. All 95 evidence tree entries are unchanged.

When checking the published commit, compare these path/blob/mode triples and both historical state entries with its Git tree, and retain the intended reconciled canonical state. Publication identity and PR disposition are provided by the containing commit and associated PR; no merge is asserted by this provenance record.

## PR #15 and complete stack path coverage

The same publication tree also preserves PR #15's two [symlink-repair records](orloom-pr15-evidence-tree-elements.json) at their original paths and its two [historical state/manifest blobs](orloom-pr15-historical-state-tree-elements.json) under `.agent/history/pr15-d4c14280/`. Source head: `d4c14280e90809f4fa53337ba6224718e282e585`. The records are preserved by original blob SHA and do not replace newer fixture source.

The [PR #3–17 preservation verification](orloom-pr3-17-preservation-verification.json) checked all 15 untruncated source trees: no original path was absent from the candidate path set after the 97 evidence additions (95 PR #14 plus two PR #15 records). Four historical archives are additional: two PR #14 state files and two PR #15 state/manifest files. Path coverage alone is not byte equality or behavioral acceptance; the separate exact-blob manifests bind historical evidence, and the reviewed source manifest binds tested runtime source.
