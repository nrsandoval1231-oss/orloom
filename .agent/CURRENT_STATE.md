# Orloom current state

Updated 2026-10-19 UTC for the owner-directed Hostinger successor. Owner selected Hostinger for the control plane, database and engineering workers. The approved Hostinger key staging is complete; worker execution remains disabled.

## Governing records

- [Canonical harness](../docs/architecture/CANONICAL_HARNESS.md), [Finish Contract](../docs/FINISH_CONTRACT.md), [approved UI](../docs/design/FOREST_BRASS_UI_V1_1.md).
- [Work Graph](WORK_GRAPH.md), [Hostinger source packet](H2B-SOURCE-01.md), [Hostinger preparation](../docs/operations/hostinger-worker-preparation.md).
- Exact source `4203f3a1f379e60fb853ab48b04d389fe75e4978`, tree `cb60832ea4dd20a17613c60ddd7f407401e6fae0`, was accepted for its stated combined-source scope. Its isolated runtime qualification used DigitalOcean; that evidence does not qualify Hostinger. Controller-local external receipts outside this Git tree (workspace-relative paths, not portable GitHub links): `outputs/Orloom-combined-v10/accepted-state.json` and `outputs/Orloom-combined-v10/SOURCE_REVIEW_PASS.json`. The prior state and graph bytes are preserved in [archive/2026-10-19-hostinger-preparation](archive/2026-10-19-hostinger-preparation/).
- Builder evidence for this docs/configuration candidate is a claim pending independent review. The controller records final frozen-candidate authority in the controller-local external receipt outside this Git tree (not a portable GitHub link): `outputs/Orloom-Hostinger-prepared/SOURCE-COMPLETION.json`. No acceptance transfers from the earlier source.
- Hostinger key staging evidence records the expected root-owned mode `0400` file and unchanged protected containers in a controller-local external receipt outside this Git tree (not a portable GitHub link): `outputs/Orloom-Hostinger-worker/POSTCOPY.json`. It does not prove worker execution or production deployment.

## Source and operations

This documentation/configuration successor is based on the exact accepted source above. Its own frozen candidate gates and independent review are pending. No source/runtime implementation or deployment changed in this successor.

The Hostinger host has 2 CPUs and about 8 GiB RAM, shared with eight protected containers. Prepare a private Node `24.15.0` runtime under `/opt/orloom-worker-runtime/node-v24.15.0` with the packet-specified digest; system Node `20.20.2` does not satisfy the repository engine requirement. Build and qualify serially with one initial lane. The fixed v10 runsc suite and its resource/security policy remain unchanged. Do not infer six-lane capacity.

The private App key is staged at `/etc/orloom/credentials/github-app-private-key`; never read, copy, print or hash its contents in this source task. Database, provider, R2, policy, image and runtime qualification remain explicit activation gates. Keep `ORLOOM_WORKER_MODE` and the approved-task pointer blank, capacity zero, and integration/delivery disabled. Missing configuration must not be filled with invented values or used to claim `--check-config` passes.

## Direction and authority

H2B source freeze -> H3 credential-free Hostinger image/runsc qualification and full suite -> H4 separately reviewed disabled compatible release/preparation -> H5 owner-enabled mission. H3 and H4 remain open until their own evidence and review are recorded. Backups, isolated restore and rollback evidence are required before a compatible app cutover; a compatible v10 reader must precede v10 production records.

The accepted source/runtime checkpoint is not Hostinger qualification. Runtime execution, production certification, draft PR delivery, and Finish Contract acceptance remain open. Preserve UNKNOWN for unresolved effects. Owner retains activation, merge and delivery authority. The known $1 mission cap remains unused.
