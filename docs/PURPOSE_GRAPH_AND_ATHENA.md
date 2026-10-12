# Purpose Graph and Athena — Evidence-Driven Intelligence
Status: architecture proposal; not yet implemented in Orloom.

## Purpose Graph
Canonical typed nodes: MissionVersion, RequirementVersion, ArchitecturalDecision, Constraint, WorkUnit, Repository, Commit, SourceSymbol, Dependency, Candidate, TestExecution, ReviewFinding, VerificationClaim, RunEvent, Decision, Outcome, Lesson.

Canonical edges: requires, implements, depends_on, constrained_by, produced_by, verified_by, challenges, supersedes, learned_from. Every important edge has provenance, timestamp, origin, confidence class (observed / curated / inferred / verified), and immutable identity.

**Do not** accept a model-proposed semantic link as verified fact. Static parsers, Git objects, test artifacts, and deterministic policies establish mechanically provable relationships; LLMs propose intent mappings; independent evaluation and owner decisions establish approved semantic claims.

## Coverage
Verified completion is weighted coverage of a *versioned* set of accepted requirements. Missing or stale evidence blocks the affected claim. Do not derive progress from lines of code, file count, agent token output, or green CI alone.

## Athena's role
Athena is not knowledge; Athena is wisdom through **verified experience**. Distinct responsibilities:
- Orloom harness: authorized execution and engineering operations.
- Purpose Graph: intended structure, code/evidence traceability.
- Athena: reflection on decisions, outcomes, trade-offs, and policy candidates.
- Human: governing mission, values, approval, irreversible authority.

Learning process: register context + alternatives + predicted outcome; record actual result and cost; challenge candidate lessons independently; evaluate on disjoint discovery/challenge/holdout sets; promote only validated, scoped strategies with lineage; retain rejected lessons. Athena may propose questioning the strategy or even mission but cannot change the owner's mission silently.

## Jev
Jev may actively select typed finite actions for strategy, model routing, decomposition, recovery, and additional verification. Host code validates action membership, user grants, budgets, scopes, and invariants. Jev cannot grant its own privileges, waive mandatory review, approve a merge, or self-promote learning policy. Use safe fallback for noncritical routing and fail closed for authorization/evidence-sensitive actions.

## Evidence contract (draft)
```json
{
  "schema_version": 1,
  "tenant_id": "owner",
  "project_id": "project",
  "run_id": "run",
  "event_id": "immutable-id",
  "occurred_at": "ISO-8601",
  "actor": "builder|validator|athena|host",
  "event_type": "plan|build|candidate|check|review|verification|decision|outcome",
  "candidate_commit": "optional-exact-sha",
  "mission_version": "immutable-mission-id",
  "requirement_ids": [],
  "evidence_refs": [],
  "decision_policy_id": "optional-versioned-policy",
  "authority": "host-policy",
  "synthetic": false
}
```
This is a proposal for the future normalized event adapter, not a claim that Orloom currently emits these fields.

## MVP experiment
Use 20–30 representative, disposable engineering tasks; record decisions before execution; independently verify outcomes; evaluate one scoped Athena strategy against a fixed baseline on fresh tasks. Report uncertainty and negative results. The first success is a **measurable, reproducible improvement**, not an eloquent retrospective.
