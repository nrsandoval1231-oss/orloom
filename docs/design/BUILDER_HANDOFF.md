# Builder handoff — Orloom Forest & Brass V1.1

Implement [the approved design contract](FOREST_BRASS_UI_V1_1.md) against the EXISTING Orloom source and APIs. This is a new implementation task, not evidence that the UI has shipped.

## Outcome
A clean Forest & Brass Command Center, mission composer, and a separate dark observatory **Live Loom** view based on historical fine-line Forge V3/V4 geometry. Do not use a chunky metallic-ring 3D hero as the live execution visualization. The brand mark may remain sculptural metallic woven brass.

## Read first
- README.md; docs/architecture/CANONICAL_HARNESS.md
- docs/LIVING_LOOM_CANONICAL.md; docs/PROTOTYPE_HISTORY.md; docs/living-loom.md
- docs/verification.md; docs/security.md
- docs/design/FOREST_BRASS_UI_V1_1.md

## Work order
1. Audit current components/routes/state, auth, missions/events, Loom renderer, and styles. Record actual behavior and gaps; don't invent backends.
2. Implement shared color/type/spacing components and responsive clean dashboard with empty/loading/error states.
3. Implement mission creation UI bound to existing validated API; preserve full SHA, owner approval, budget semantics.
4. Add prominent **Live Loom** view-switch that only changes presentation. Preserve source snapshot and demo labeling.
5. Integrate V3/V4-inspired fine-filament 3D visualization with deterministic mission-event projection and right inspector tabs; keep renderer disposable/read-only.
6. Verify on mobile and desktop, with accessible controls and no misleading active build or verification claims.
7. Run the existing repository test/typecheck/build/validation checks; submit a PR with screenshots, actual results, and documented remaining runtime blockers.

## Hard constraints
- Never turn worker execution on to make the interface seem live.
- No fake percentages, jobs, approvals, tests, health or completed missions.
- No weakening cancellation fencing, isolated verification, auth, or SHA binding.
- Visual navigation is not mission execution. A Live Loom click never performs side effects.
- Don't delete older V1–V4 prototypes or label their synthetic telemetry live.
- No new GitHub Actions workflows.
- Use existing hosting/deployment decisions only after confirming actual repository and environment configuration.

## Definition of done
Both views function against actual available mission state; layout is clean on desktop/mobile; approved brand tokens and the detailed Loom inspector are implemented; unknown/offline/stale states are truthful; independent validation results and visual screenshots are attached to the implementation PR.
