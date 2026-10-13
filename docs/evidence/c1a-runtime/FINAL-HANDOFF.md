ORL-005C1A real PostgreSQL runtime proof handoff

Candidate: outputs/orloom, frozen source HEAD 545279c7b53fef8453c8e50ae0bc7f0d790959af
Source manifest: .agent/ORL-005C1A-MANIFEST.sha256 SHA256 85612beddd1d5b81bd2987fc6980c149f87092d42b316e54ea6af93c8e5fbace
Attempt-3 payload manifest SHA256 77322aa943bc1df89931f96f917bfb020eb98385e3b590b543d50e22f3cc4ec3
Runner: runtime-proof.mjs SHA256 facf0a089edcd361b27e674f1ad0f8cd9e9ebc4fe43dea1d7aef0c3b9895dbc9

RESULT: bounded real-PostgreSQL HTTP/pool proof PASS. Remote command `ssh codex-dark-peak-5042 'bash /var/lib/orloom/c1a-pg-proof-20261013/staging/run-proof-03.sh'` exited 0. Raw output is runtime-result-attempt3.txt (SHA256 FF7B5A9A26AEBC9FB08437D32BCDAF410BEDB0C2954AA6F21F8F666C923FC6D5). It includes executable fixture receipts and receipt-byte hashes, 42 recorded invariant outcomes, concurrent backend PIDs [4457,4458,4459], reconnect/event replay, provider calls=0.

The test used actual HTTP/control-plane code, PostgresJobStore and SqlMissionStore against PostgreSQL in an internal-only network. It proved failure then approved fixture repair then the same executable invariant passed; candidate provenance/exclusions; authenticated promotion fails closed; authorization, replay/canonical JSON ordering, conflicting replay, ordinal gap; expiry; and budget-context in-flight fencing to durable UNKNOWN/quarantine with retained scope/capacity slot/reservation. This does not establish C3 verification, promotion, downstream lesson use/withdrawal, worker execution/capacity, provider behavior, or product readiness.

Prior attempts retained, not overwritten:
- Attempt 1 (runtime-result-attempt1.txt, SHA256 0C80C27131FF7C57724B230B43CE34EAD161A2D982F043E01FAF8DECB988ECE3): failed only in bootstrap due runsc DNS EAI_AGAIN. Separate metadata-derived private-IP DB connection succeeded as mission_app (backend 2113). Details in ATTEMPT-01.txt.
- Attempt 2 (runtime-result-attempt2.txt, SHA256 5C6A5D87F526E46A8A71B7C5286A6EAAF1130CC86D5BB6B8C7ACE1C3F8C48B76): scenario persisted four committed episode events and candidate; harness challenge digest omitted challenge fields. No source changes; attempt 3 used fresh attempt-specific databases.
- Setup/stage CRLF transport errors and unresolved first setup invocation status are retained in ATTEMPT-SETUP-AND-STAGE.txt; no setup rerun was done.

Cleanup command: `ssh codex-dark-peak-5042 'bash /var/lib/orloom/c1a-pg-proof-20261013/staging/cleanup-disposable.sh'` completed with `cleanup=PASS exact labeled containers, volumes, network, staging removed; protected codex-universal unchanged`. Read-only post-check found no matching packet containers, network, volumes, or staging paths. codex-universal remains ID 5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67, StartedAt 2026-10-12T23:51:46.164222792Z, restart count 0, runtime runc, running. Post-check output is REMOTE-CLEANUP-POSTCHECK.txt.

UTC completion: 2026-10-13 07:12:20 UTC. Token usage and exact elapsed work duration: UNKNOWN. No providers, new paid resources, production DB, Hostinger, push, merge, or deploy actions were performed by this proof worker.
