# Orloom current state

Updated 2026-10-15 UTC. Authority: [canonical harness](../docs/architecture/CANONICAL_HARNESS.md), owner delegation, [work graph](WORK_GRAPH.md). Product completion remains OPEN. Replaced state bytes are preserved under `.agent/archive/2026-10-15-before-minimal-verifier-*`.

Merged main `9457b1bcb10b085602f337b253580d23ad0b1d93`, tree `b8aa985ff55fffd9be658c9893ae96eded669abf`, contains reviewed PR27. Current branch `fix/minimal-verifier-qualification` is a focused successor; reviewer owns merges. [Packet](MINIMAL_VERIFIER_PACKET.md), [ledger](../docs/validation/2026-10-15-minimal-verifier.md).

The pinned minimal Node24.15 verifier keeps exact binary/package/lock bindings, all dependencies and seven stages. Trusted TMPDIR=/work preserves HOME=/nonexistent and noexec /tmp. Two fixture repairs preserve POSIX security checks and immutable source. Both result paths await complete pipe emission. Suite policy v8 invalidates earlier identities. Independent review caught an actual HOME mismatch; it was repaired and reinspected. A further large-marker truncation failure and repair remain recorded.

Image `sha256:0f068249a489b8a74a4ff3ad513b02ae5319a3531256f1b0c132dc7ffb6882cf`: local runc suite PASS,66 files,383 tests/382 pass/0 fail/1 existing deployment-host skip, all seven stages,206150ms, complete untruncated marker. Syntax PASS. Frozen201-file source manifest and final unchanged-input check bind this acceptance. Independent R2 source review found no material issues. Next: publish exact candidate for independent review. Host runsc qualification remains OPEN.

Canonical UI/startup defaults remain preserved. No paid-provider activity, credential creation, capacity activation, live verifier certification, external demonstration, merge or site switch. Judgment, adaptive scheduling and learning remain unconfigured. Fixtures do not establish a live verified GitHub task.

Separate private release preparation uses exact-main source and isolated synthetic PostgreSQL only. Production database and retained-image exports were rejected by automatic review; no payload was copied. Image/rehearsal/storage outcomes are separate private evidence, not deployment acceptance. Durable backup, restored-clone startup, exact-old-image rollback and cutover review remain gates. Do not deploy on this ledger alone.
