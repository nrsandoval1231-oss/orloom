# Consolidation validation — 2026-10-14

## Scope and status

Repository: nrsandoval1231-oss/orloom. Pinned base: PR #17, `410882d4afff33e028be50b816ad69eb387eae6d`. Historical main observed by the audit: `6110c692f47202978b2d22d22f6522aa4aa59277`.

Independent review returned **PASS for the bounded repair source**. The owner has authorized open-PR cleanup and advancing reviewed, ready work; earlier frozen-head/no-merge statements are historical. The canonical harness, product vision and Living Loom requirements are unchanged. This record does not claim merge, deployment or full product completion.

## Exact reviewed source and results

- [Independent review](2026-10-14-consolidation-independent-review.md): PASS within its stated source scope.
- [Reviewed source manifest](2026-10-14-consolidation-source-manifest.json): 89 individual file SHA-256 bindings; compact canonical JSON SHA-256 `63345151c8d403d54b4f62836fdc658b9655ad16fbb60925b88c633671f4c285`.
- `npm run typecheck`: PASS.
- `npm run validate`: PASS.
- `npm test`, including production TypeScript build and asset helper: **167/167 PASS**, zero failures, skips or cancellations; 45061 ms test duration on Node v24.19.0/Linux. [Captured output](orloom-consolidated-independent-tests.log).
- Clean disposable locked-install follow-up: `npm ci`, typecheck, explicit build, validate and full test suite PASS; **167/167**, zero failures/skips/cancellations, 44117 ms. All 89 file bindings unchanged. [Install log](orloom-clean-install-final.log), [validation log](orloom-clean-validation-final.log), [full suite](orloom-clean-tests-final.log).
- The [initial clean-copy failure](orloom-clean-tests-initial-tmp.log) is retained: two verifier configuration cases hit the temporary-directory artifact rejection, and two test-file process exits had no diagnostic cause. The unchanged-source rerun outside the temporary directory passed; the review records the limits of this diagnosis.
- Every manifest-bound file was rechecked unchanged after the independent run. Documentation/history additions and separate worker integration are outside that source-review scope.
- Publication identity is resolved by the Git commit containing this record and its associated PR. A self-referential commit SHA is intentionally unnecessary; the file manifest identifies exactly what was tested. The PR records publication and disposition; this document does not claim merge.
- PR #2 broker composition and integrated acceptance remain **SEPARATE, OPEN**.

Independent review also finds a bounded owner-authorized source merge supportable, conditional on exact publication identity, reconciled documentation, sufficient owner authority and actual branch policy. This is eligibility, not a claim that a merge happened. These are combined-source results, not an aggregation of component suite counts. The green Linux suite does not replace the operational gates below.

## Seven audited correctness repairs

| Finding | Reviewed repair | Regression boundary |
|---|---|---|
| R1: worker claim returned a noncanonical plan digest | Return the authoritative lease grant digest | Memory and SQL-backed HTTP claims agree with canonical policy/progress bindings |
| R2: restart could claim checks removed from trusted policy | Revalidate approved checks against current trusted policy | Stale approved checks fail closed after policy change |
| R3: a new independent claim hid unresolved UNKNOWN state | Use consistent aggregate precedence | UNKNOWN remains observable while disjoint work starts; quarantine stays intact |
| L1: contradicted/withdrawn learning evidence could be reused | Scope a retained negative cutoff to lineage; require fresh observations/attempts and recheck challenge/promotion | Old evidence cannot resurrect advice; fresh candidates remain possible; later negatives fence stale attestations |
| L2: cohort normalization differed between Governor and store | Share the canonical scope-cohort normalization | Mixed case, whitespace and ordering yield consistent recovery eligibility |
| D1: Docker build omitted the helper-copy script | Copy scripts before the build step | Declared build inputs contain executable helpers; this is not Docker image acceptance |
| D2: Loom could close on contradictory certificate digests | Bind every certificate ID to its corresponding digest | Mismatches/missing values/swapped associations fail closed; correctly paired reorderings remain valid |

The audit found seven correctness defects plus larger product/operability gaps. Repairing these seven does not complete autonomous execution, operational recovery, the canonical visualization or measured learning.

## Evidence and consolidation boundaries

See [PR #14 provenance and preservation notes](orloom-pr14-evidence-manifest.md) and [the machine-readable original-blob manifest](orloom-pr14-evidence-manifest.json).

PR #17 contains the source/history of #4–13 and #16. PR #3's non-ancestor evidence content was found in the base except historical current-state differences. This consolidation preserves PR #14's 95 original evidence blobs under delivery-postgres, loom-postgres and delivery-cloud-v3, including binary artifacts and failed outcomes, from head `5908bd42fc55e14353a550cc6804354a986881ed`. Two original current-state files are retained separately under `.agent/history/pr14-5908bd42/`, rather than overwriting current truth. These historical blobs are included atomically in the same Git tree as the repaired source. PR #15's two additional symlink repair records and two historical state/manifest blobs are also preserved by their original SHA, without reverting later fixture changes. The [all-stack path verification](orloom-pr3-17-preservation-verification.json) confirms zero absent original paths across all 15 untruncated PR #3–17 trees after the 97 evidence additions; four historical archives are additional. Path coverage does not claim identical current-state documentation or supersede source acceptance. PR disposition is recorded by the associated PR, not asserted here.

PR #2's observed head `639bff0759870d3522ae38d2887b75fe6c4297c7` is not in the PR #17 base. Its controlled broker/proof work requires separate reviewed composition; neither an open PR nor a retained Docker fixture proves live DeepSeek execution.

Historical actual cloud suite `f6023acade03091a494644409e9bc65d28d59ad4` failed after 271438 ms with ENOTDIR and zero certificates. The later fixture repairs do not retroactively change that result. Retained PostgreSQL, browser and source reviews stay bound to their original source revisions.

## Still open

- Clean Docker image build and authentic exact-source runsc full-suite certification.
- Live PostgreSQL proof of the combined repairs; PGlite is useful SQL execution but not a live server acceptance result.
- Secure App/R2/provider configuration, real Git-object publication and deployment.
- Executable isolated builders, real Sol planning, bounded live Jev judgment/scheduling and durable spend controls.
- Owner-controlled operational recovery from quarantined UNKNOWN/BLOCKED work and integrated deployed recovery.
- Independently evaluated fresh comparable tasks against a fixed baseline, including failures/cost/time/uncertainty. Measured improvement remains null.
- Canonical Living Loom interactions beyond the present real-event projection.

No live provider, production deployment, six active builders or learning-gain claim is made by this record.

