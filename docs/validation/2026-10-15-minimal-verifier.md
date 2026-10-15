# Minimal pinned verifier qualification — 2026-10-15

Baseline merged main `9457b1bcb10b085602f337b253580d23ad0b1d93`, tree `b8aa985ff55fffd9be658c9893ae96eded669abf`. Focused successor `fix/minimal-verifier-qualification`; no merge or live activation. [Packet](../../.agent/MINIMAL_VERIFIER_PACKET.md). [Evidence](../evidence/validation/2026-10-15-minimal-verifier/).

## Changes and root causes

The broad Universal base is replaced by official Node24.15 bookworm-slim pinned index `4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d`. The existing Node binary digest, exact package/lock digests, full locked development dependencies and trusted helpers remain required. Git comes from signed Debian snapshot20261014; download caches are removed. No dependency changes.

Trusted TMPDIR=/work uses the existing executable writable tmpfs outside read-only source. This fixes runner configuration: executable subprocess fixtures otherwise land under noexec /tmp. HOME remains /nonexistent. Sandbox mounts, network-none, UID65532, capabilities, resources, deadlines and immutable-input check are unchanged. Policy v8 binds stage environment and awaited-result behavior.

The approved-startup fixture assumed HOME was writable; it now uses trusted temporary storage or repository-parent fallback while retaining POSIX security assertions. The packaging fixture preserved read-only directory modes in its disposable copy and could not remove it as nonroot. Cleanup makes only that copied tree writable and skips symlinks. These are fixture repairs, not relaxed production permission checks.

A further production defect appeared with large results: immediate process.exit after stdout.write can discard queued marker bytes. Both paths now await a shared write callback. A real slow-reader regression verifies a233167-byte marker containing two65536-byte logs. Errors remain non-success; existing launcher deadlines bound stalled emission. Marker schema and log bounds are unchanged.

## Acceptance ledger

| Gate | Outcome / scope |
|---|---|
| Executable-temp RED | Canonical helper fails EACCES executing fake Docker under noexec /tmp; red-noexec-result.json. |
| HOME-fixture RED | Private TMPDIR diagnostic then fails mkdtemp under /nonexistent; red-home-result.json. |
| Read-only-copy RED | Private fixture correction then fails EACCES removing copied directories; red-readonly-copy-result.json. |
| Source review correction | Independent review rejected actual HOME=/work versus bound /nonexistent. Actual helper repaired; initial/R1 reports preserved. That image is not accepted. |
| Marker RED | First candidate capture79280 bytes; marker ends at65536 characters with incomplete JSON. Raw red-marker-stdout.txt preserved. UNKNOWN, not acceptance. |
| Exact image build | PASS; Node/package/lock checks and full99-package install. Image `sha256:0f068249a489b8a74a4ff3ad513b02ae5319a3531256f1b0c132dc7ffb6882cf`. |
| Syntax | PASS exit0,555ms, complete marker. |
| Local suite | PASS under **runc**,206150ms;66 files,383 tests,382 pass,0 fail,1 existing deployment-host ownership/mode skip. |
| Seven stages | PASS dependency admission, typecheck, clean build/assets, discovery, serial tests, foundation validation, final offline policy/source rehash. |
| Result integrity | Process/inner exit0; no parse error; untruncated45868-byte decoded stdout; zero stderr; outer95431 bytes. |
| Frozen inputs |201 files; exact input-manifest.json SHA256 `d82ee73941cd4a66d99dd41aace557402962bdcae7a40ff044058054bccac596`; source-manifest.json is a separately formatted array of the same entries. Controller rechecked every file after run. Archive2013184 bytes. |
| Independent R2 source review | No material findings; source-review-r2.md. Source approval only. |
| Host runsc suite | OPEN; no verifier imported or host acceptance performed for this source repair. |
| Full Orloom Git admission | NOT PROVEN by the check snapshot. At publication6c242f0,1771 tracked blobs total17156078 bytes, already378862 over the existing16777216-byte cap before manifest overhead. The guard remains unchanged. |
| Live provider/GitHub task | OPEN; no credentialed task or paid-provider execution. |

Every discovered file in the frozen201-file check snapshot ran; no test or required stage was omitted. This snapshot contains the application/test/helper/packaging inputs, not the complete Git tree with historical evidence. It qualifies local image/check compatibility, not end-to-end Git candidate admission. The existing skip explicitly requires deployment-host ownership/mode acceptance. The sanitized local-npm test runs because this image contains the baked npm path; other environments may skip it. Prior ledgers remain unchanged.

## Boundaries

This is local image/source qualification. Canonical UI and fail-closed startup remain preserved. No production data, running-site image, host networking/security settings, capacity or adapters changed. Operational use needs independent exact-head review, immutable image binding and credential-free runsc acceptance with fresh capacity admission. The separate disabled web release needs its own image, secure backup/restore, new/old startup compatibility and final cutover approval. Synthetic work cannot close those gates.

Builder model: gpt-6-luna, fresh bounded context, two repair rounds; independent source reviewers: gpt-6.1-sol. Exact tokens and complete planning/build/audit durations are UNKNOWN. Measured final suite206150ms is not elapsed-to-product-completion or a speed comparison. Builder completion is retained separately and is not certification. Publication SHA/PR are reported in the handoff.
