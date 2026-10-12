# Forge-owned CI contract

Forge, outside the target checkout, owns validation policy. Commands and policy are loaded from a trusted Forge-controlled source and pinned by version/hash before running against a candidate. Never execute a candidate-controlled script as the trusted gate and never let repository code replace its own check list. Run checks in a disposable, unprivileged worker without host socket/mount access, with bounded CPU/memory/time, restricted network, read-only credential-free source until a job-specific credential is strictly required, and a fresh workspace per job.

Required foundation gate sequence:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `npm run validate`

Record exact candidate commit/tree identity, policy identity, tool/runtime versions, commands, exit codes, bounded logs, timestamps, and artifact digests. A timeout or lost worker is `UNKNOWN` where side effects may have started. Forge must not automatically repeat external effects. ORL-001 has not implemented this scheduler or hostile-code isolation; this document is a contract only.
