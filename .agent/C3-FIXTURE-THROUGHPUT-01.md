# C3-FIXTURE-THROUGHPUT-01

READY: reduce repeated database cold starts within the delivery-effects test file without reducing coverage or weakening isolation. Actual isolated f602 suite evidence recorded 91066ms in delivery-effects.test.js before a later Linux cleanup failure. This is evidence of a verification bottleneck, not a proven optimization benefit.

Repository work/orloom-fixture-throughput; branch fix/delivery-fixture-throughput; base 3a983fa9a51ffb0ac4760bcfc33128883673f024. Canonical requirements unchanged; PR2 frozen/excluded. This packet is an independent established-pattern test-fixture change, not production architecture.

Own only tests/delivery-effects.test.ts and this packet/completion. Keep all existing cases, assertions, production migration execution, UNKNOWN handling and exact identity gates. Prefer one file-scoped PGlite engine with explicit serialized fixture ownership, clean database state per setup, and final closure. Prove cleanup restores all mutable schema data, counters, globals and connection state, including failed cases. Never share a fixture across concurrent tests or silently bypass migrations. If safe lifecycle reuse cannot be established, report the real constraint instead of weakening coverage.

No production source, dependencies, package manifests, migrations, verifier limits/policy, cloud scripts, other tests, broker, credentials or external side effects. No Git commit/push, host or provider execution. Shared node_modules is read-only. Root owns integration and full gates.

Validation: typecheck/build and the entire affected test file, with an explicit isolation regression demonstrating a failed/mutating fixture cannot influence the next one. Record actual local durations with same command and environment before/after if measured, but do not label this as cloud speedup. Preserve failure evidence. Retry budget two materially different repairs. Completion artifact includes changed files, commands/exits, raw timings or UNKNOWN, limitations and next required exact Linux measurement.
