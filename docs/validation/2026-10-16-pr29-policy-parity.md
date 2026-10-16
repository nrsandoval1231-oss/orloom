# PR29 full-tree policy parity

PR29 adds an operator-owned execution projection under the unchanged16MiB selected-source-plus-manifest limit. Review of8eba291 reproduced a regression: records excluded from that projection could contain credential-shaped paths, nested workflows or dependency overrides which the existing full-tree suite would reject.

The repair applies the same forbidden-path predicate to every tree entry before execution selection. The image's existing suite check remains defense in depth. A parity test runs the TypeScript predicate against the unchanged baked suite admission implementation; a real Git regression checks three independently constructed excluded-path candidates and ordinary evidence/root package-lock controls. No evidence is deleted or rewritten, and no size bound or image helper changes.

Validation and independent exact-head acceptance are recorded at publication after the candidate freezes. Guard-removed RED is retained privately, as are focused/aggregate logs and actual fresh/cache admission receipts. These checks do not establish runsc acceptance, production activation or an autonomous delivered task. Host cleanup and diagnostic copies are separately paused pending owner approval.
