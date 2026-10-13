# ORL integrated C1b/C2/PR7 source packet

Node: integrated-source-stage-1 (serialized source integration)

Repository/worktree: `work/orloom-integrated`, branch `feat/integrated-harness`.
Base: C2 evidence head `a4064ebe1073562991d220722944b58763a94bda`. Active merge head: PR7 `aa63a12736e82e145c0e162145683823edcd39e4`.

Objective: resolve the approved PR7 merge while preserving C2 scheduler argument positions, PR7's default-closed learning activation, and automatic SQL/contract changes from both parents. Append learning activation after existing scheduling-adapter positions; update PR7 fixtures and add a behavioral regression proving both dependencies operate independently.

Allowed: integrated merged source, affected tests, compact packet/completion, and merge evidence/state reconciliation in this worktree only. Excluded: C3 integration until controller-frozen source arrives; production activation/configuration, worker protocol, migrations, provider/host calls, commits, push, PR edits, merge completion, or deployment.

Validation: `npm run typecheck`; `npm run build`; focused scheduling, recovery-learning, activation, and HTTP tests; `git diff --check`; inspect merged SQL/contract capabilities for both scheduling and lesson-impact methods. Local fixture evidence only. Parent controller owns exact-candidate freeze, final gates, independent review, and next C3 serial integration.
