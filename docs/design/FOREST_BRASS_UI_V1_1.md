# Orloom — Forest & Brass Design Contract (V1.1)

Status: **Owner-approved visual direction**, not implemented software or proof of production execution. Approved October 16, 2026.

## Product promise
Two connected experiences: **Command Center = control** and **Live Loom = visibility**. Keep the existing trust boundaries and exact-source evidence contract. Visual polish must never manufacture readiness, telemetry, coverage, certification, or agent activity.

## Brand
- Name: **Orloom**, never Forge in production UI.
- Mark: sculptural interwoven toroidal strands; metallic champagne brass, deep forest, dark steel. Use one consistent simplified vector mark for UI and retain the full torus treatment for hero/3D.
- Mood: precise, architectural, quiet, industrial luxury. No neon cyberpunk, glass overload, fake activity, or decorative clutter.
- Typography: expressive editorial serif for the brand and rare editorial headlines; highly legible modern sans for controls/data; monospaced font for SHA, code, timestamps, execution IDs and logs.
- Logo: transparent backgrounds in exported assets, accessible text alternative, monochrome variant, minimum size and visible contrast.
- Palette (design tokens; verify WCAG contrast before release):
  - `--forest: #183A2E` deep sidebar, primary action
  - `--forest-dark: #0B1914` Live Loom shell
  - `--espresso: #4B2E1F` depth only
  - `--sandstone: #C9B59B` quiet ornament
  - `--brass: #D4AF7C` brand highlight / focus detail
  - `--warm-cream: #F9F6ED` primary canvas
  - `--muted-sage: #A7B89A` secondary surfaces
  - `--ink: #1D2520` text on cream
  - `--line: #E5E3DA` separators
  - Status tokens are semantic and independently contrast-tested; brass is NOT used as a generic success color.
- Radius: 10–14px cards/inputs, 6–8px compact controls; 1px restrained borders; shadow only for elevation.
- Spacing: 4/8/12/16/24/32/48px scale; consistent card padding and large whitespace.
- Motion: deliberate, subtle, optional. Honor prefers-reduced-motion. Never obscure text.

## Navigation and responsive layout
Desktop: 224px forest sidebar, calm cream content; content width flexible. Primary items: Dashboard, Missions, Repositories, Verification, Memory, Settings. Hide specialist/admin functions behind explicit disclosure.
Tablet: narrow icon navigation; cards reflow.
Mobile: compact top bar and bottom/bottom-sheet navigation; single column, no horizontal overflow, sticky mission safety actions.

## Command Center
One focused hero title with **Create Mission** primary and **Live Loom** secondary button. Small real mission-state summary below. Active missions list is the largest content area. System readiness is a short compact card, not a constellation of tiles. Show meaningful errors or required action prominently; hide internal implementation details by default.
Use real state only. Empty dashboard: `No missions yet` plus `Create Mission`. Unknown readiness: `Status unavailable`, never `Healthy`.

## Mission Composer
Repository selector, objective, clearly measurable acceptance criteria, readable budget in USD (convert to cents at API boundary without changing authoritative units), optional advanced immutable SHA/policy controls. Honor the immutable base SHA requirement, even if visually moved to an advanced area: never silently substitute a moving branch for the required pinned commit. Disable submission until mandatory authenticated inputs and validation pass. Mission creation != authorization to execute.

## Live Loom: intentional view switch
The button label is **Live Loom**; clicking opens a separate immersive dark Observatory workspace and does NOT start or resume work. Exit Live View returns to prior command surface without interrupting missions.
The chosen geometry follows the historical Forge Living Loom prototypes V3/V4: fine filament torus, airy particle threads, distributed orbital annotations, restrained green/sage/brass highlights, no chunky solid-metal donut. Fullscreen 3D central viewport with minimal left mission/plan rail and optional right inspector. On small screens, inspector is a drawer. Main interactions: drag to orbit, pinch/scroll to zoom, focus/reset, select a sector/agent/source bundle, keyboard equivalents, reduced-motion/static fallback.
Show PLAN / BUILD / VERIFY / LEARN as instrumented stages, not as cosmetic animation presets. Mission, agents, selected files, event timeline, trusted checks, exact commit, evidence and decisions are linked through event IDs.
Inspector tabs: Activity, Code, Tests, Evidence, Logs; show read-only source when available and anchor evidence to exact repository/ref/path/line or artifact digest. Respect information authorization. Distinguish authored intent, observed source, pending work, candidate artifacts and independently verified completion.
When no live data: show `Idle`, `Offline` or `Source snapshot — not live` visibly. Historical demo/prototype must be explicitly labeled `Synthetic demo`. Avoid arbitrary percentage progress when the backend has no authoritative denominator.
Progressive filament motion may respond to verified mission events only. Do not visually close the ring until defined acceptance criteria are independently certified. Paused/unknown/blocked states use conservative animation and persistent labels. If event delivery fails, pause animation and show stale timestamp.

## Operator safety and truthful states
- Never show `Running`, `Ready`, `Verified`, `Passed`, or `Completed` from mock data.
- Workers disabled by default remains explicit in both experiences.
- Keep plan approval, authorized execution, stop/cancel, budget reservations, and verification separate.
- Cancel must invoke existing owner-authorized cancellation; do not imply immediate process termination without verified worker absence.
- If pause/resume isn't supported end-to-end, do not display an active pause/resume control.
- Authentication is via the existing owner session; never leak owner token into logs/client persistent storage.
- 3D renderer cannot receive privileged credentials or become the source of truth for mission state.
- Preserve immutable reference, trusted validator, isolated worker, and publish approval boundaries.

## Build sequence
1. Inspect current repo and routing/UI; establish visual tokens/components and dashboard/mission UI without replacing backend behavior.
2. Add reversible Live Loom route/view switch using the existing read-only mission/event endpoints; keep old observer behavior until parity.
3. Rebuild 3D fine-filament torus and inspector as progressive enhancement; fallback 2D/read-only list.
4. Wire traceable mission events/lag/unknown states; inspect in desktop and mobile; keyboard, screen reader, reduced-motion, accessibility.
5. Verify build/types/tests and screenshots; independent review before merge. Do not change trusted verifier/worker enablement to make the demo look active.

## Acceptance
- Dashboard is substantially simpler than legacy form page; no overflowing mobile fields.
- Create Mission and Live Loom are clear, separate, functioning actions.
- Switching views does not create, start, pause, or cancel a mission.
- Selected Loom nodes expose source/intent/evidence with provenance.
- Simulated and live modes cannot be confused.
- No unsupported completion claims, fabricated telemetry, authentication regressions, or worker activation.
- Keep historical prototypes preserved as provenance; mark them non-production.

## Reference provenance
Approved owner screenshots in conversation: Forest & Brass brand board (warm cream workspace/forest sidebar/brass woven-ring) and three historical FORGE Living Loom V3/V4 screenshots (fine-line torus/source inspector). The screenshots represent design references, not production execution. The original approved brand/UI image files are conversation assets and should be added to `docs/design/references/` if exported through an authenticated local checkout; do not recreate or falsely claim pixel-identical originals from prose.

See `docs/LIVING_LOOM_CANONICAL.md`, `docs/PROTOTYPE_HISTORY.md`, `docs/living-loom.md`, and the canonical harness security/verification documents for precedence on execution semantics.
