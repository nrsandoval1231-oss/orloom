# C5-PAGE-RECOVERY-01 — page runtime repairs

**Objective.** Repair the four page-only findings in `work/c5-source-review-df72574.json` without changing the C5 projector, renderer direction, server/store/governor, schema, or trust boundary.

**Repository identity.** `work/orloom-loom`, branch `feat/live-loom`, base `df72574e35799cd379a24a734d5e3ae00e86e2f5`.

**Bounded follow-up.** On frozen browser candidate `8d6dda1ef62d5c4250c9965d4f280b2fe96d9afc`, desktop resize left the mobile disclosure subtree visible beside the desktop inspector. Keep exactly one visible inspector: `#inspect` hidden by default and enabled only at the mobile breakpoint; desktop summary remains hidden only at that breakpoint. Preserve mobile toggle behavior and add a focused responsive-rule regression. No authority or renderer change.

**Owned files.** `apps/control-plane/src/loom-page.ts`, page-focused test(s), this packet, and its completion record. No other files are authorized.

**Acceptance.**

- Forced WebGL failure explicitly removes the SVG `hidden` attribute and hides the canvas with an attribute; the normal renderer explicitly hides the SVG and shows the canvas.
- Fallback mouse, Enter, and Space inspection focuses the visible matching inspector row, opening the mobile inspector first when necessary.
- Only a certified event bound to the current slice, candidate, and check can link to the existing certificate route while the slice is `awaiting_verification`; verified historical evidence stays plain text.
- Manual and visibility-triggered refresh clears the one scheduled poll timer; each request completion installs at most one replacement timer and retains timeout/backoff behavior.
- Focused TypeScript build and Loom page/HTTP tests pass. Root owns final frozen-candidate browser checks and review.

**Authority and exclusions.** Read-only event viewer; do not add writes, provider calls, APIs, migration, or completion claims. Preserve all four V1–V4 prototype bytes. No commit, push, host, or external mutation.
