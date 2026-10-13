# C4 local PostgreSQL proof: failure retained

Exact source: `078ed12c8b2cbaf102e8f788e37980b017fc061a`. PostgreSQL 18.6 ran in a new private loopback cluster per attempt. The installed database service was not used. Every attempt ended with `STOPPED_OWNED_CLUSTER`; data remains privately retained outside Git.

| Attempt | Observed result |
| --- | --- |
| `startup-wrapper` | PostgreSQL became ready, but inherited Windows process handles kept the wrapper waiting. No scenarios ran. |
| `fixture-path` | Migrations 001–006 and three distinct database connections passed. Fixture Git clone failed before integration because of its long Windows path. |
| `concurrent-replay` | Ordinary real PostgreSQL/bare-Git integration passed: verified parent, ready child, one integration event. Concurrent recovery after a post-CAS interruption failed with a missing-or-stale certificate error. |

The last failure reveals a source race: one caller can finish integration while another still reads a certificate through the awaiting-verification interface. The completed-replay branch must reconcile the exact durable outcome without weakening first-time verification or repeating Git/SQL effects. See `c4-race-direction.md`.

All three outcomes are **FAIL** for the complete proof. The first two are proof-harness defects; the third is a product implementation defect. The earlier source review did not detect this interleaving. No subsequent negative scenario is claimed to have run after that failure.

`inventory.json` binds each attempt's runner/scenario and copied evidence. The helper source is retained for reproduction, but commands must use a freshly frozen source, compiled manifest, unique runtime and reviewed ownership checks. Never copy private `runtime/connection.json`, password files, database files, OAuth state or provider secrets into this evidence directory.

Receipts and independent-review artifacts in these cases are clearly controlled fixtures entering production coordinator interfaces. These runs establish only the database/Git behavior actually observed. They do not establish authentic Orloom CI, cloud deployment, live provider execution, real reviewer outcomes or measured learning improvements.
