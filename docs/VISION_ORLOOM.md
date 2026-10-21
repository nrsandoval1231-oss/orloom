# Orloom — Canonical Product Vision
Status: **AUTHORITATIVE PRODUCT DIRECTION** — 2026-10-21. Supersedes the 2026-10-12 vision and any conflicting multi-agent/visual-first product requirements. This is a design decision, **not proof of implemented functionality**.

## Essence
**Orloom turns an idea into working software.**

The owner selects a repository and describes an outcome. Orloom understands relevant code, makes changes using an established coding agent, runs appropriate checks in a disposable isolated workspace, repairs mistakes within clear limits, and delivers an inspectable GitHub pull request. The owner controls acceptance and merge.

The product should feel like delegating work to one excellent software engineer, not operating an engineering organization.

## The only primary workflow
1. **Ask:** Choose repository; describe change; optionally specify acceptance criteria.
2. **Build:** A single coding-agent session reads relevant code, edits, tests, and retries with a finite budget.
3. **Review:** Show a human-readable summary, changed files, commands/tests and their results, remaining risks, and PR link.
4. **Decide:** Owner reviews and merges. Never deploy or merge to production without explicit authorization.

One mission, one current state, one understandable next action. Support cancellation and truthful failure reporting.

## Product non-goals — do not rebuild
- No architect/manager/parallel-builder agent hierarchy as a prerequisite for one coding mission.
- No Athena/Sol/Jev/Astra tribunal or multiparty judgment pipeline on the critical path.
- No learning/promotion engine, purpose graph, elaborate dependency scheduler, or multi-slice enterprise orchestration in the MVP.
- No six-worker target, simultaneous agent fleet, or automatic scaling requirement.
- No cinematic Loom, torus, visualization sectors, progress theater, or agent-status page as the primary UI.
- No manual budget-policy authoring, check-policy assembly, lease management, or infrastructure configuration exposed to the owner.
- No invented acceptance scores, fake agent activity, or claims that unit tests prove real execution.
- No building a proprietary coding model or coding runtime where a mature coding-agent engine can be integrated.

These ideas are historical, not standing requirements. Restore only when demonstrated user value justifies their operational and maintenance cost.

## Essential boundaries — keep them
- Run repository code in an isolated disposable environment; never on the web/control-plane host.
- Keep provider, GitHub and database credentials out of the untrusted checkout; use narrowly scoped short-lived authority.
- Enforce finite runtime, spend/tool limits, cancellation and safe treatment of interrupted/unknown execution.
- Keep trusted verification policy outside the target repository's control; report honestly what checks did and did not prove.
- Keep GitHub as source of truth. Produce a PR by default; no automatic merge or production deployment.
- Keep durable mission state and minimum useful logs for recovery and troubleshooting.
- Host it in the cloud so the owner's PC can be off.

## Implementation rule
**Simplify by subtraction.** Prefer the least number of deployable services and operational concepts capable of safely completing one real mission. Reuse the existing control plane, worker, storage and UI if their simpler form works. Keep code temporarily when removal would risk an unverified execution path, but remove it from product-critical workflows and retire it after characterization tests.

Do not add new security bureaucracy: retain actual isolation and authority boundaries while removing duplicate policy and ceremony.

## Definition of done
A real task on a controlled repository, launched from the UI, must: obtain the intended base revision; run a real coding model in an isolated workspace; make a nontrivial source change; run meaningful checks; correct an intentionally introduced failure or clearly report why it cannot; publish a real PR; and display accurate logs, diffs, checks, and failure state. Reproduce the demonstration from a fresh mission. Evidence must identify the commit, run, environment, and PR. Simulated tests or fixture replay are not sufficient.

## Measures
Primary: successfully delivered, owner-accepted PRs; time from request to working PR; owner interventions per task; cost per accepted change; regression rate. Do not optimize number of agents, steps, policies, evidence documents, or lines of code.

## Change discipline
No new platform features until the end-to-end coding delivery is verified. Remove unused layers in safe, testable slices. Historical records may be archived but cannot override this canonical product direction.
