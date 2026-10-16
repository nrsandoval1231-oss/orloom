# Governed execution input implementation plan

Goal: Admit real Orloom Git candidates without increasing any security/resource limit or removing historical records.

Architecture: Add an optional operator-only, fixed version execution profile to RepositoryConfig. Validate the entire Git tree; select classified execution inputs; bind selection, exclusions and full-tree identity into the input manifest. Preserve the complete admitted Git object store and all existing scope, parent, pack, deadline and retention checks. Default remains full-tree extraction.

- [x] Reproduce excessive historical-input failure with a real Git bundle regression.
- [x] Add fixed path classification and propagate operator profile through initial and cached admission.
- [ ] Verify safety regressions, full suite, and genuine current Git candidate within unchanged limits.
- [ ] Independently review final commit; publish implementation PR and report operational gates.

Review focus: unsafe excluded paths, unclassified source roots, profile changes on cached admission, excluded objects retained, manifest/identity/size integrity. No activation or paid-provider work.
