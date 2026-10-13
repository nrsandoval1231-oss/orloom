# ORL-004 repair 1 deterministic evidence

- Original Sol FIX review preserved byte-for-byte at .agent/archive/ORL-004-repair1/HOSTINGER-REVIEW.json; SHA-256 51b30681cbe3dc1987ecf2e50fd6c29d61ad838a5561baa343af2b5212c8d3b9.
- Updated implementation candidate manifest .agent/HOSTINGER-CANDIDATE.json; SHA-256 04759a85db512b330db56050365a3a504c0ce861e7aac6918680b8784ec85e76.
- Host guard now requires one strict raw Host header with DNS hostname syntax, no port, and case-insensitive exact hostname match; Origin remains exact. Node HTTP tests send actual Host headers and reject path, userinfo, fragment, internal whitespace, and port variants.
- App password generator now sets owner postgres Alpine UID/GID 70, mode 0400. Existing secret values were not modified. Operator metadata-only correction is in docs/deployment.md.
- Cloud UI now says Cloud control plane, queue-only/live execution disabled, and Unlock submissions.
- npm ci: exit 0, 99 packages audited, zero vulnerabilities.
- npm run typecheck: exit 0.
- npm test: exit 0, 14 passed, 0 failed.
- npm run build: exit 0.
- npm run validate: exit 0.
- git diff --check: exit 0 (CRLF normalization notices only).
- No deployment or external writes by builder. Host runtime, DB restart/restore, TLS/browser remain controller-owned UNKNOWNs.
- UTC finish 2026-10-13T01:17:34Z; start, phase durations, config identity, and measured tokens UNKNOWN.