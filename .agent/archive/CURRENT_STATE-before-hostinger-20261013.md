# Orloom current state

Foundation ORL-001 published to private https://github.com/nrsandoval1231-oss/orloom main at 43101e95e31806777d741c8c4db5b10005c6fe00. Local and remote SHA verified after push. OAuth correction ORL-002 accepted for publication; see OAUTH-REVIEW.json. Local checkout outputs/orloom.

Owner authorized foundation commit/push and secure cloud connections, then selected OAuth/subscription usage instead of API keys. No GitHub Actions. Aura and forge-agent excluded entirely. Paid provisioning, deployment, and live model execution not yet authorized.

Read README.md, docs/FINISH_CONTRACT.md, docs/security.md, WORK_GRAPH.md and OAUTH-REVIEW.json. Latest OAuth manifest SHA256: bd41d1ff1d5b7b857d8217dac9291855cd02f682c294e87ef8ca3bf61706f8e4. Controller gates passed, 11 tests, independent Sol PASS. All manifests exclude .agent bookkeeping. Original foundation review is historical; current acceptance is OAUTH-REVIEW.json.

Local HTTP and PGlite SQL runtime verified. OAuth config requires explicit isolated CODEX_HOME and forces ChatGPT login, rejecting API-key env vars. No login or real credentials were created, copied or read. DigitalOcean and Cloudflare account access verified; no Orloom Droplet or R2 bucket exists. Docker daemon unavailable. Live providers, durable cloud service, isolated worker and Forge CI scheduler remain incomplete. Before deployment, scope check-publishing token, implement persistence/lease transport, prove isolation. Next: obtain spending approval for dedicated worker, then perform operator device-code login on that worker. No credential is required for local tests.
