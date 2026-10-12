# Living Loom Prototype History and Provenance
This is a historical preservation record. These prototypes were built under the Forge Living Loom name before the clean-slate **Orloom** repository.

| Version | Historical behavior | Evidence category |
|---|---|---|
| V1 | Canvas torus, synthetic agents, completion and drift controls | Purely synthetic |
| V2 | Auto-build, activity feed, improved mobile controls | Purely synthetic |
| V3 | WebGL2 fiber torus, agent streams, validation/repair simulation, cinematic view | Purely synthetic |
| V4 | Inspectable source-backed code bundles, cited dependencies, purpose/source/evidence inspector, mobile layout | Actual source inspection + synthetic agent activity |

V3 reported 15 simulation tests and 44 browser checks in its historical handoff. V4 reported 31 Node tests and 87 browser checks. These are historical reported results; do not treat them as current Orloom CI results. Real mobile Safari testing was not established.

Canonical visual inspiration: a dark 3D torus of flowing particles and fibers, progressively forming a complete circle. The design was independently evolved into a purpose- and verification-driven engineering instrument. Do not copy unrelated trading functionality.

### Porting guidelines
Keep original standalone files under `prototypes/v1`, `v2`, `v3`, `v4`; do not rewrite them in place. Reuse V3 geometry and V4 inspectability as visual references, not as the production event model. Record screenshot and source hashes for every imported artifact. If a historical binary asset is missing, mark it as missing rather than replacing it with an invented recreation.
