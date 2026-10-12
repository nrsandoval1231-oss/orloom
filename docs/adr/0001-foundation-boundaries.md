# ADR 0001: bounded single-operator foundation

Status: accepted for ORL-001 foundation only.

The browser talks to one control plane; PostgreSQL owns durable job state; an isolated worker will later claim leases; object storage will retain evidence; GitHub App credentials and Codex SDK calls remain server-side adapters. This repository currently implements the local control plane, memory store, SQL repository and schema, adapter contracts, and a worker placeholder. It does not provision or operate those cloud services.

Job status changes are explicit. A lease token fences stale worker messages. A running job whose lease expires becomes `unknown`, since an external effect may have happened. Unknown jobs require operator reconciliation; no automatic replay is permitted. A queued/leased job that never started can be returned to the queue after lease expiry.

Forge owns trusted CI policy outside a target repository checkout. Orloom defines no GitHub Actions workflow. The Codex adapter requires the caller to supply its environment explicitly and a working directory; it has no implicit execution authority.

Consequences: local mode is easy to run and visibly non-live; cloud deployment is intentionally blocked pending persistent database, secure sessions, actual isolation, IAM, retention, monitoring, and recovery proofs.
