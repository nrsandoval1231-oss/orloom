# PR1 revalidation attempts

- Candidate preparation succeeded on clean detached HEAD `2d45b64e24817a14826a6c9466145909680fec0b`. First payload omitted `reset-proof-db.mjs`; before remote staging, it was preserved as `payload.attempt01`, `payload-manifest.sha256.attempt01`, and `candidate-identity.json.attempt01`. The final allowlisted payload includes the reset helper and has manifest SHA-256 `2ac74b88818440a9e7778808bb1629853cf743418239c960849e17d77f1253df`.
- Two read-only resource-metadata commands failed during shell templating (`k: unbound variable`; then a Docker Go-template map indexing error). Neither changed remote state nor emitted credential data. They were replaced with simpler sanitized inspection commands.
- No PostgreSQL setup, test, or cleanup attempt failed. The schema reset and proof passed once; exact-resource cleanup and post-cleanup inventory passed.
- After successful proof, `work/orloom-main-review` changed concurrently to branch `feat/judgment-recovery` at `6110c692f47202978b2d22d22f6522aa4aa59277` with untracked controller files. This is recorded in `EVIDENCE.md`; those files were preserved untouched.
