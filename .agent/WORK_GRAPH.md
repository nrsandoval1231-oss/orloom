# Work graph

| Node | Dependencies | State | Acceptance |
| --- | --- | --- | --- |
| ORL-001 foundation | none | ACCEPTED LOCALLY | REVIEW.json binds 11-test gates and independent Sol PASS to final manifest |
| ORL-002 secure cloud connections | ORL-001 | PARTIAL | OAuth foundation correction accepted; account access verified; dedicated paid worker and actual sign-in pending |
| ORL-003 isolated live job proof | ORL-002 | NOT READY | Cloud authorization, proven isolation, persistent job and immutable artifacts, Forge-issued check bound to SHA |

Only ORL-001 is in current implementation scope. No parallel READY node. No cloud or GitHub write authority is inferred from local validation.

## ORL-004 Hostinger deployment — current frontier
ORL-002 is PARTIAL: worker OAuth and private R2 resource verified; provider runtime integrations pending. ORL-004 depends on accepted foundation/OAuth code and owner deployment authority; READY then BUILDING with one Luna. Acceptance is a separate durable queue-only app/database service with secure HTTPS/session boundary, exact-candidate review and live persistence proof. Existing nine Hostinger containers are protected. ORL-003 worker execution remains NOT READY. Historical rows above describe earlier scope and are superseded by this entry.
ORL-004: DEPLOYED_QUEUE_ONLY; technical gates and Sol PASS established, interactive browser acceptance remains UNKNOWN. See HOSTINGER-RUNTIME.md. Next direction VALIDATE user browser access then next bounded connection/isolation node. Full product remains incomplete.
