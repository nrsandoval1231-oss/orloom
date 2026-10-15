# Living Loom: recorded engineering activity

After unlocking the existing owner session, open `/loom?mission=<mission-id>` on the same control plane. The page reads the mission's approved plan, slice state, and durable events. It does not start builders, approve work, or change state.

The three-dimensional circular weave has one sector per recorded slice. Its color follows the recorded slice status. The central nucleus identifies the mission repository; the inspector shows objectives, ownership, dependencies, and evidence references. Drag or use arrow keys to rotate, use the camera controls to zoom, and expand the inspector on mobile. A labeled two-dimensional fallback remains available without WebGL. Archived V1–V4 prototypes retain their original bytes and synthetic data; they are not the live view.

The inspector also reports control-plane prerequisites from the actual configuration, configured authorities and durable approved plan. “Prerequisites ready” never attests a live worker, provider, image or runtime; live execution remains unverified. Capacity evidence expires at read time. Cancellation distinguishes a request, settlement before runtime, settlement after confirmed runtime absence and unresolved UNKNOWN, with current lease epochs. Recovery and delivery events retain their recorded references in the same timeline. A disconnected view retains historical rows while readiness becomes unavailable; refresh or reload reconstructs from durable records.

The authenticated `/api/missions/:id/loom?after=N` endpoint catches up through bounded event pages, allowing gaps in global cursor values. It currently reads at most 10,000 mission events within eight seconds, then returns an explicitly unavailable projection if that bound is exceeded. The browser uses finite, abortable catch-up and reconnects without advancing progress from time or animation. This bounded implementation does not yet support arbitrarily long campaign histories.

Completion requires every approved slice to be verified and to have matching, causally ordered certification, integration intent, and integration events for its candidate and lease. Missing, contradictory, disconnected, or stale evidence leaves completion unavailable. This display is an observation of Governor state, not an independent certification authority.

Untrusted labels are rendered as text. The page uses a nonce content policy, existing HttpOnly owner authentication, and same-origin evidence links; it never stores a provider or owner token in browser storage. There is no public mission-data endpoint.

Source tests and controlled browser checks are separate from PostgreSQL durability, actual worker execution, operational cloud verification, and measured learning gains. Those acceptance levels must be supported by their own retained evidence; rendering a mission does not prove them.
