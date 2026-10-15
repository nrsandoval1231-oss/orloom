# Slice 0 baseline validation — 2026-10-14

Slice 0 establishes a reproducible current baseline for the continuation mission. It verifies the remote state, the retained manifest, and a fresh locked-install check chain on the one host available. It changes no production source and closes no runtime gate.

## Source boundary

Rechecked live before any edit:

- `nrsandoval1231-oss/orloom`, default branch `main`, public.
- Commit `86a972300708f9bc05f557c5c09efd1c0f7e2ba6`; tree `10de087b4999e1d3264c644a752d651df04a3927`. Both equal the audit anchor.
- **Zero open pull requests.** All 16 original PRs (#2–17) remain resolved; PRs #18, #19 and #20 are merged.
- 21 remote branches, no tags.
- The baseline was taken from a fresh clone of `origin`; its commit and tree were verified equal to the anchor before any command ran, and the worktree was clean before and after every gate.

## Preserved local successor work

An uncommitted successor existed in a prior local working copy (`…\Codex\2026-10-14\continue-orloom-from-its-cleaned-foundation\work\orloom`), branched `feat/coherent-mission-runtime-20261014` at base `86a9723` with **52 modified files (+1262/−309) and 24 new files**. Its content is runtime composition, runtime journal, cancellation and recovery-checkpoint work — directly relevant to Slices 1–3 — and it is *not* covered by any merged PR.

Preservation performed before any other action:

- Committed locally as `5c59eb3f87fd520651c811d243f02a1af3433853` on its own branch under the existing author identity. **Never pushed.**
- Exported a complete-history bundle (5,117,327 bytes, `git bundle verify` = "The bundle records a complete history") retained outside the repository.
- Scanned all 76 changed/untracked paths for credential patterns; the only matches were the credential-*detection* regexes in `docker-runtime.ts` and `worker.ts`. No secret material present.

No successor file has been reused in Slice 0. Reuse is deferred to the slice that needs it, after provenance and fit are assessed individually.

## Commands and results

| Gate | Command | Exit | Duration |
|---|---|---|---|
| Locked install | `npm ci` | 0 | 99 packages, 0 vulnerabilities |
| Typecheck | `npm run typecheck` | 0 | 3.8 s |
| Build | `npm run build` | 0 | 3.9 s |
| Validation | `npm run validate` | 0 | 0.5 s |
| Suite | `npm test` | **1** | 78.2 s |

Suite totals: **202 tests, 189 pass, 13 fail, 0 skipped, 0 cancelled, 0 todo, 73656.69 ms.** The worktree remained clean; commit and tree are unchanged, so no production source was touched by the check chain.

## Failure classification

All 13 failures are the 13 tests of `tests/candidate-admission.test.ts` — 189 = 202 − 13, and no other test file produced a failure. Every one reports the same single error:

```
Candidate admission refused: admission root must be a private owned real directory
```

This is a **platform guard, not a defect and not a regression**:

- `packages/verification/src/candidate-admission.ts:73` — `privateDirectory()` requires an absolute, non-symlink, real directory with POSIX group/world bits clear (`info.mode & 0o077 === 0`) and `st_uid` equal to the process uid. Windows cannot satisfy POSIX ownership/mode semantics.
- `packages/verification/src/candidate-admission.ts:45` — `boundedGit()` throws `bounded Linux Git importer is unavailable` when `process.platform !== "linux"`.
- `packages/verification/src/candidate-admission.ts:49` — the bounded importer spawns `/usr/bin/prlimit` and `/usr/bin/git`, absent on Windows.

`docs/verification.md` already declares this boundary as Linux-only with an owner-only real admission directory. The failures are therefore the intended fail-closed behaviour of a Linux-only source path executed on Windows. They are not evidence the source is broken, and they are **not** evidence it works on Linux from this host.

## Retained manifest cross-check

The [119-file release manifest](foundation-release/source-manifest.json) (SHA-256 `c458c72a…`) was re-verified against this checkout: **119/119 entries match by size, SHA-256 and Git blob SHA-1; zero mismatches, zero missing, zero untracked-but-listed.** The retained Linux source acceptance therefore binds exactly to this tree despite `core.autocrlf=true`, because `.gitattributes` sets `* text=auto eol=lf`.

One accuracy caveat is recorded rather than smoothed over: the manifest's prose exclusion list omits `.agent/**`, `work/**`, `infra/**`, `deploy/**`, `prototypes/**` and `.gitattributes`, which it also excludes in practice. Verified separately, **no unlisted tracked path is a runtime, test, build or configuration input** — nothing under `packages/`, `apps/`, `tests/`, `scripts/`, `db/`, and not `tsconfig.json`, `package.json`, `package-lock.json`, `.env.example` or `.dockerignore`. The claim is accurate for shipped runtime source and incomplete as written.

## Platform requirements and current versus historical evidence

**Required for the full suite to be green:** Linux (for the bounded Git importer at `/usr/bin/git` and `/usr/bin/prlimit`), a POSIX-private admission root owned by the process uid with mode `0o077` clear, Node ≥ 24, and a Git index. Docker/runsc, PostgreSQL, credentials and network are **not** required for the 202 suite.

**This host:** Windows, Node `v24.18.0`, npm `11.16.0`. No Docker, no WSL, no Linux runner was available, so the suite could not be run on supported Linux here. The Windows result is a *subset* result and is never labelled green.

| | Retained record | This run |
|---|---|---|
| Result | 202/202 pass, 0 fail | 189/202, 13 fail |
| Input | materialized frozen snapshot with a local-only Git index (no commit, no remote) | fresh clone of `origin/main` at `86a9723`, tree `10de087b` |
| Host | node `v24.19.0`, npm `11.9.0`; no OS field recorded | Windows, node `v24.18.0`, npm `11.16.0` |
| Duration | 88881.44 ms | 73656.69 ms |
| Retained failure | first snapshot run 201/202 (`git ls-files` without Git metadata), kept | none additional |
| Class | source-only acceptance | source-only acceptance |

The retained 202/202 is **source** evidence over the same 119 files verified here, not a runtime certificate. Neither record closes an admission, recovery, cancellation, PostgreSQL, runsc, provider or publication gate.

## Gate

- **Reproducible baseline** — PASS. Exact commit and tree reproduced from `origin`, with every gate command, exit code, duration and artifact retained under [`slice0-baseline/`](slice0-baseline/).
- **Clean scope** — PASS. Zero production changes; only active documentation and this validation record are added. Frozen historical evidence is untouched.
- **Classified failures** — PASS. All 13 failures are attributed to a named, documented, deliberately fail-closed Linux/POSIX boundary with file-and-line evidence.
- **No false green claim** — PASS. The suite is reported as 189/202 with a non-zero exit; no green status is claimed for any unexercised class.

Evidence classes exercised: **source** and **fixture/PGlite**. Not exercised: **actual PostgreSQL, Docker/runsc, live provider, publication.**

## Unresolved

1. Linux execution of the 13 candidate-admission tests is not reproducible from this host; it rests on retained snapshot evidence only.
2. No PostgreSQL, Docker/runsc, live provider or publication evidence exists at this baseline.
3. The retained manifest's declared exclusion list understates the paths it actually excludes.

This slice grants no credentials, spending, deployment, activation, publication or merge authority. Slice 1 may proceed.
