# Orloom work graph

Updated 2026-10-19 UTC for owner-directed Hostinger preparation. Prior graph bytes are preserved in `archive/2026-10-19-hostinger-preparation/WORK_GRAPH.md`.

| Node | Dependency | State |
| --- | --- | --- |
| UI-H1 | PR30 | Hostinger web control plane source/deployment evidence is historical; execution remains disabled. |
| FLW-INPUT | PR32 | Prior source acceptance remains scoped to its exact candidate. |
| FLW-V10-COMBINED | a80f2e7 + dfc06fd | Exact source `4203f3a` accepted for the combined-source scope; accepted isolated runtime evidence is DigitalOcean-specific. |
| H2B-SOURCE-01 | owner Hostinger direction + accepted `4203f3a` | Documentation and disabled preparation template successor. This candidate's final gates and independent review are pending. |
| H3-HOSTINGER-QUALIFY | H2B-SOURCE-01 exact freeze | OPEN: credential-free Hostinger image/runsc qualification and full fixed v10 suite; no execution. |
| H4-DISABLED-RELEASE | H3 plus compatible app reader, backup/restore and rollback evidence | OPEN: separately reviewed disabled compatible release/preparation. |
| H5-APPROVED-MISSION | H3 + H4 + owner authorization | WAIT: one capped approved mission, exact commit, trusted checks, certificate and real draft PR evidence. |
| FLW-2 | FLW-1 success | NOT READY for automatic dispatch, six-lane operation or learning claims. |

Preserve v9 failures and UNKNOWN journal quarantine unchanged. No activation follows from source or local diagnostics. Provider execution, Hostinger runtime qualification, deployment and production evidence remain OPEN.
