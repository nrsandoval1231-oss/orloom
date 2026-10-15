# Approved composition packet

Started 2026-10-15 UTC. Owner instruction: connect worker execution, protected candidate admission and independent verification; finish reliable cancellation; one owner-authored approved slice and one worker lane. Baseline `eed0a9264ec2b5c64f59a247a4aa6be93e3677e4`, tree `6666a4b575e6fc412b0a165eebbde720f1a83423`. Isolated clone in task-4/orloom, branch `feat/approved-worker-composition`.

Authority: [canonical architecture](../docs/architecture/CANONICAL_HARNESS.md), owner delegation in this task. No AGENTS.md or AGENT_RULES.md exists in the baseline. Existing current state and evidence remain historical until replaced with an archived copy.

READY node: compose the already implemented worker, admission and trusted verifier through an exact approved single-lane boundary, with trusted runtime cancellation settlement. Dependencies are existing source modules, not assumed live services.

Acceptance: failing regression before implementation, passing focused checks, deterministic integrated fixture, build/typecheck/validate, full Linux suite, actual PostgreSQL when available, independent review of exact candidate, focused branch/PR with honest ledger.

Boundaries: preserve canonical UI/architecture and deployment. Unconfigured startup stays disabled. No paid provider execution, new credentials, merge, deployment, network/security settings, external repository creation or changes outside Orloom. UNKNOWN side effects retain quarantine and full spend reservation; fixtures are never live evidence.

Implementation uses Luna bounded workers for verifier configuration, trusted cancellation store and single-lane composition. Controller owns final checks/publication. Independent source acceptance is distinct from operational product acceptance.

Remaining operational UNKNOWNs: current deployment version, real runsc image acceptance, secure provider/App/R2 configuration, owner target task/repository and exact spend ceiling. External demonstration needs these concrete owner decisions and release authority.
