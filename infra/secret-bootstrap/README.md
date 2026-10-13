# Orloom Infisical machine-secret bootstrap

This owner-run step stores the Orloom-only Infisical Viewer machine identity secret on the dedicated DigitalOcean worker as `/etc/orloom/infisical-client-secret`, mode `0600`, owned by root. It does not make a network request, retrieve a token, or print the entered value. The client identity is `d1d0e292-405d-4f8f-920d-57ac1929fb83`, client ID `b5a6543d-8c6a-4450-8fc4-73915505881e`. These identifiers are not the client secret.

First create/copy the client secret from the Infisical browser yourself. The owner creates `/etc/orloom` as root with mode `0700` if it is absent. Upload only the reviewed helper to a temporary owner-controlled staging path on the dedicated machine. Then run it in a real interactive SSH terminal:

```powershell
ssh -t codex-dark-peak-5042 python3 /root/orloom-infisical-bootstrap.py
```

At the hidden prompt, paste the client secret. The helper requires root and an existing root-owned `/etc/orloom` directory with exact mode `0700`, refuses any existing destination (including a symlink), bounds input to 8192 UTF-8 bytes, and atomically creates the file without replacing anything. It emits only success/failure status. If it fails, inspect path ownership/mode without displaying file contents; do not retry by overwriting an existing secret. No actual secret was entered or tested during preparation.

The staged script is [bootstrap.py](bootstrap.py). Do not place the client secret in shell arguments, environment variables, chat, logs, or a repository file. After the helper succeeds, keep the secret file outside job workspaces and provide it only through the already-approved service secret-file mount. This preparation does not configure service access, request tokens, or prove authentication.

Checkpoint: the helper was staged on the dedicated worker and passed Linux synthetic atomic-write, permissions, overwrite and symlink tests. No actual client secret was entered; authentication remains pending. The project Viewer identity exists, access-token TTL is 900 seconds, and the unsubmitted client-secret form proposes 86400 seconds. No provider calls have been made.
