# Pinned worker launch, exec, and copy contract

This is the reusable boundary for the next worker integration. It only proves a small disposable sandbox configuration; it does not authorize credentials, network access, provider calls, host mounts, or a six-lane workload.

## Launch

Run `/var/lib/orloom/worker-isolation/launch-worker-sandbox.sh <name>` as host root, with a unique name matching `orloom-worker-[a-z0-9][a-z0-9-]{0,32}`. The script accepts no other arguments, rejects inherited account/provider/daemon credential variables by name, and launches only the locally cached image digest embedded in the script with `--pull=never`. Do not pass Docker arguments, image names, entrypoints, or commands from job data. The fixed policy is `runsc`, `network=none`, read-only rootfs, UID/GID 65532, dropped capabilities, no-new-privileges, PID limit 64, memory/swap 256 MiB, CPU 0.5, and separate per-container tmpfs at `/tmp` and `/work`.

The printed container ID is the only launch result. Retain it in the trusted controller and address that ID explicitly; do not select containers by an untrusted name or label. The host Docker API is privileged and stays outside the worker.

## Exec

Use the fixed local Docker client and socket with a temporary empty mode-0700 client config, as the scripts do. `docker exec` may run only the trusted worker program and its fixed arguments; pass an argv array directly. Never build a shell command from job text, evaluate job text, pass Docker flags from job data, or set per-exec environment variables. Any task-specific command and resource contract must be reviewed by the controller before the worker integration is enabled.

## Copy in and out

No host directory is mounted into the container. Stage only explicitly approved, non-secret regular input files under the container's `/work/in/` using `docker cp` to the exact container ID and exact destination. Record source hashes before transfer and verify hashes in the container. Reject symlinks, device nodes, sockets, path traversal, archives that would be unpacked, and inputs above the controller's declared size limit. Never stage OAuth, API keys, database URLs, Docker credentials, or host configuration.

Treat all worker output as untrusted. Permit only explicitly named regular files under `/work/out/`, with no symlinks, archives, or path traversal. Check file type and size inside the sandbox before copying individual files from the exact container ID to a fresh private host staging directory. Hash copied outputs, scan/validate them before use, and do not execute them on the host. Do not use `docker cp` against `/`, home directories, auth paths, or other host/container paths. Delete only the named sandbox and its private staging directory after evidence is retained.

## Limits

Two concurrent sleeping containers and short denial/isolation probes do not establish compiler/build throughput, production reliability, adversarial escape resistance, safe artifact ingestion, or six concurrent live lanes. Those remain UNKNOWN until separately designed and measured. Provider and GitHub calls remain outside this networkless worker and are not covered by this packet.
