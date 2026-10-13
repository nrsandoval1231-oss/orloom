#!/usr/bin/env python3
"""Two concurrent stdio protocol fixtures on a pinned, networkless runsc container."""
import argparse
import base64
import hashlib
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
import uuid

BASE = "node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd"
LABEL = "org.orloom.worker-runtime-proof"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
PREFIX = "orloom-worker-proof-"
MAX_OUTPUT = 64_000
MAX_PROTOCOL = 16_000_000
DOCKER_CONFIG = ""
DOCKER_ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}


def docker_command(args: list[str]) -> list[str]:
    if not DOCKER_CONFIG:
        raise RuntimeError("private Docker CLI config is not initialized")
    return ["/usr/bin/docker", "--config", DOCKER_CONFIG, "--host", "unix:///var/run/docker.sock", *args]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def docker_json(args: list[str]) -> object:
    result = subprocess.run(docker_command(args), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20, env=DOCKER_ENV)
    return json.loads(result.stdout)


class Rpc:
    def __init__(self, name: str, image_id: str, labels: dict[str, str]):
        self.name = name
        create_args = ["create", "--rm", "--interactive", f"--name={name}", f"--label={LABEL}=true",
                       *[f"--label={key}={value}" for key, value in labels.items()], "--runtime=runsc", "--network=none",
                       "--read-only", "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                       "--pids-limit=64", "--memory=256m", "--memory-swap=256m", "--cpus=0.5",
                       "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
                       "--tmpfs=/work:rw,exec,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700",
                       "--workdir=/work", "--entrypoint=/usr/local/bin/node", image_id, "/opt/orloom/sandbox-entry.js"]
        created = subprocess.run(docker_command(create_args), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, timeout=30, env=DOCKER_ENV)
        self.container_id = created.stdout.strip()
        if not re.fullmatch(r"[a-f0-9]{64}", self.container_id):
            raise RuntimeError("Docker did not return an exact container ID")
        self.proc: subprocess.Popen | None = None
        self.next_id = 0

    def start(self) -> None:
        if self.proc is not None:
            raise RuntimeError("proof container started twice")
        self.proc = subprocess.Popen(docker_command(["start", "--attach", "--interactive", self.container_id]),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                     env=DOCKER_ENV)

    def request(self, op: str, payload: dict | None = None, timeout: float = 8) -> dict:
        if self.proc is None or self.proc.poll() is not None or self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("sandbox protocol process is not running")
        self.next_id += 1
        request = {"id": str(self.next_id), "op": op, **(payload or {})}
        line = json.dumps(request, separators=(",", ":")).encode() + b"\n"
        if len(line) > MAX_PROTOCOL:
            raise AssertionError("test input unexpectedly exceeds the documented protocol cap")
        selector = selectors.DefaultSelector()
        deadline = time.monotonic() + timeout
        response = bytearray()
        try:
            input_fd = self.proc.stdin.fileno()
            os.set_blocking(input_fd, False)
            selector.register(input_fd, selectors.EVENT_WRITE, "write")
            sent = 0
            while sent < len(line):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError(f"sandbox protocol write timed out during {op}")
                try:
                    sent += os.write(input_fd, line[sent:])
                except BlockingIOError:
                    continue
            selector.unregister(input_fd)
            os.set_blocking(input_fd, True)
            selector.register(self.proc.stdout.fileno(), selectors.EVENT_READ, "read")
            while b"\n" not in response:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError(f"sandbox protocol timed out during {op}")
                chunk = os.read(self.proc.stdout.fileno(), min(65_536, MAX_PROTOCOL + 1 - len(response)))
                if not chunk:
                    raise EOFError("sandbox closed protocol output before a complete response")
                response.extend(chunk)
                if len(response) > MAX_PROTOCOL:
                    raise AssertionError("sandbox protocol response exceeded 16,000,000 bytes")
        finally:
            selector.close()
        row = json.loads(bytes(response).split(b"\n", 1)[0])
        if row.get("id") != str(self.next_id):
            raise AssertionError("sandbox response id mismatch")
        if row.get("ok") is not True:
            raise RuntimeError(str(row.get("error", "sandbox operation rejected")))
        return row["value"]

    def close(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.request("close", timeout=5)
                if self.proc.stdin:
                    self.proc.stdin.close()
                self.proc.wait(timeout=8)
            except Exception:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)


def inspect_container(name: str, expected_labels: dict[str, str], expected_id: str, expected_image_id: str) -> dict:
    rows = docker_json(["inspect", expected_id])
    if not isinstance(rows, list) or len(rows) != 1:
        raise AssertionError("container inspect did not return exactly one test container")
    item = rows[0]
    if expected_id is not None and item.get("Id") != expected_id:
        raise AssertionError("container ID changed after creation")
    host = item["HostConfig"]
    config = item["Config"]
    if config.get("Image") != expected_image_id:
        raise AssertionError("container is not using the inspected immutable image ID")
    actual_labels = config.get("Labels") or {}
    for key, value in {LABEL: "true", **expected_labels}.items():
        if actual_labels.get(key) != value:
            raise AssertionError("container provenance label mismatch")
    if item["Name"] != "/" + name or host.get("Runtime") != "runsc" or host.get("NetworkMode") != "none":
        raise AssertionError("container identity/runtime/network mismatch")
    if not host.get("ReadonlyRootfs") or config.get("User") != "65532:65532":
        raise AssertionError("container rootfs/user policy mismatch")
    if host.get("Binds"):
        raise AssertionError("sandbox unexpectedly has a bind mount")
    if set(host.get("Tmpfs", {})) != {"/tmp", "/work"}:
        raise AssertionError("sandbox tmpfs set differs from /tmp and /work")
    mounts = item.get("Mounts") or []
    if any(row.get("Type") != "tmpfs" or row.get("Destination") not in {"/tmp", "/work"} for row in mounts):
        raise AssertionError("sandbox has a non-tmpfs mount")
    if host.get("CapDrop") != ["ALL"] or "no-new-privileges:true" not in (host.get("SecurityOpt") or []):
        raise AssertionError("sandbox capability/security policy mismatch")
    if host.get("PidsLimit") != 64 or host.get("Memory") != 268435456 or host.get("MemorySwap") != 268435456 or host.get("NanoCpus") != 500000000:
        raise AssertionError("sandbox resource limits mismatch")
    env_names = [entry.split("=", 1)[0] for entry in (config.get("Env") or [])]
    if any(re.search(r"TOKEN|SECRET|KEY|CREDENTIAL|AUTH|DOCKER", name, re.I) for name in env_names):
        raise AssertionError("sensitive environment variable name present")
    return {"containerId": item["Id"], "runtime": host["Runtime"], "networkMode": host["NetworkMode"], "readonlyRootfs": host["ReadonlyRootfs"],
            "user": config["User"], "bindCount": len(host.get("Binds") or []), "mountTypes": sorted(row.get("Type", "unknown") for row in mounts), "mountCount": len(mounts),
            "tmpfs": sorted(host.get("Tmpfs", {}).keys()), "capDrop": host.get("CapDrop"),
            "noNewPrivileges": "no-new-privileges:true" in (host.get("SecurityOpt") or []),
            "pidsLimit": host.get("PidsLimit"), "memoryBytes": host.get("Memory"), "memorySwapBytes": host.get("MemorySwap"), "nanoCpus": host.get("NanoCpus"),
            "sensitiveEnvNameCount": 0}


def assert_names_available(names: list[str]) -> None:
    for name in names:
        result = subprocess.run(docker_command(["inspect", name]), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, env=DOCKER_ENV)
        if result.returncode == 0:
            raise AssertionError("randomized proof container name already exists; refusing to touch it")

def cleanup_owned_containers(names: list[str], expected_labels: dict[str, str], expected_ids: dict[str, str]) -> None:
    for name in names:
        expected_id = expected_ids.get(name)
        if expected_id is None:
            continue
        result = subprocess.run(docker_command(["inspect", expected_id]), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, timeout=15, env=DOCKER_ENV)
        if result.returncode != 0:
            continue
        rows = json.loads(result.stdout)
        if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("Name") != "/" + name or rows[0].get("Id") != expected_id:
            raise AssertionError("cleanup refused an unexpected container identity")
        actual = rows[0].get("Config", {}).get("Labels") or {}
        if any(actual.get(key) != value for key, value in {LABEL: "true", **expected_labels}.items()):
            raise AssertionError("cleanup refused a container with mismatched proof labels")
        subprocess.run(docker_command(["rm", "--force", expected_id]), check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=20, env=DOCKER_ENV)

def recover_created_ids(names: list[str], container_ids: dict[str, str], expected_labels: dict[str, str], image_id: str) -> None:
    for name in names:
        if name in container_ids:
            continue
        try:
            rows = docker_json(["inspect", name])
        except subprocess.CalledProcessError:
            continue
        if not isinstance(rows, list) or len(rows) != 1:
            raise AssertionError("recovery inspect returned an unexpected container count")
        item = rows[0]
        actual = item.get("Config", {}).get("Labels") or {}
        if item.get("Name") != "/" + name or item.get("Config", {}).get("Image") != image_id:
            raise AssertionError("recovery refused an unexpected name or image")
        if any(actual.get(key) != value for key, value in {LABEL: "true", **expected_labels}.items()):
            raise AssertionError("recovery refused a container with mismatched provenance")
        container_id = item.get("Id")
        if not isinstance(container_id, str) or not re.fullmatch(r"[a-f0-9]{64}", container_id):
            raise AssertionError("recovery could not establish an exact container ID")
        container_ids[name] = container_id

def ensure_no_owned_containers(names: list[str]) -> None:
    subprocess.run(docker_command(["ps", "--all", "--no-trunc", "--quiet"]), check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15, env=DOCKER_ENV)
    for name in names:
        try:
            rows = docker_json(["inspect", name])
        except subprocess.CalledProcessError:
            continue
        if rows:
            raise AssertionError("proof container remains after guarded cleanup")


def protected_container_snapshot() -> dict:
    rows = docker_json(["inspect", "codex-universal"])
    if not isinstance(rows, list) or len(rows) != 1:
        raise AssertionError("protected codex-universal baseline is unavailable")
    row = rows[0]
    return {"id": row.get("Id"), "startedAt": row.get("State", {}).get("StartedAt"),
            "restartCount": row.get("RestartCount"), "status": row.get("State", {}).get("Status")}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--dockerfile-sha256", required=True)
    parser.add_argument("--sandbox-source-sha256", required=True)
    parser.add_argument("--compiled-entry-sha256", required=True)
    args = parser.parse_args()
    for value in (args.source_manifest_sha256, args.dockerfile_sha256, args.sandbox_source_sha256, args.compiled_entry_sha256):
        if not HEX64.fullmatch(value):
            raise SystemExit("all source identity arguments must be lowercase SHA-256")
    if not re.fullmatch(r"orloom-worker-sandbox-proof:[0-9a-f]{12}", args.image):
        raise SystemExit("image tag must use the proof-only allowlisted name and manifest prefix")

    global DOCKER_CONFIG, DOCKER_ENV
    config_dir = tempfile.mkdtemp(prefix="orloom-proof-docker-config-", dir="/tmp")
    resolved_config = os.path.realpath(config_dir)
    if not resolved_config.startswith("/tmp/orloom-proof-docker-config-"):
        raise RuntimeError("private Docker config escaped the dedicated temp prefix")
    os.chmod(resolved_config, 0o700)
    DOCKER_CONFIG = resolved_config
    DOCKER_ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/tmp", "DOCKER_CONFIG": resolved_config}
    try:
        return execute(args)
    finally:
        if DOCKER_CONFIG != resolved_config or not os.path.isdir(resolved_config):
            raise RuntimeError("private Docker config cleanup identity changed")
        import shutil
        shutil.rmtree(resolved_config)
        DOCKER_CONFIG = ""


def execute(args) -> int:
    protected_before = protected_container_snapshot()
    labels = {
        "org.orloom.proof.source-manifest-sha256": args.source_manifest_sha256,
        "org.orloom.proof.dockerfile-sha256": args.dockerfile_sha256,
        "org.orloom.proof.sandbox-source-sha256": args.sandbox_source_sha256,
        "org.orloom.proof.compiled-entry-sha256": args.compiled_entry_sha256,
        "org.orloom.proof.node-base": BASE
    }
    image = docker_json(["image", "inspect", args.image])
    if not isinstance(image, list) or len(image) != 1:
        raise AssertionError("proof image must resolve locally exactly once")
    image_config = image[0]["Config"]
    image_labels = image_config.get("Labels") or {}
    for key, value in labels.items():
        if image_labels.get(key) != value:
            raise AssertionError("proof image source/base label mismatch")
    if image[0].get("Os") != "linux" or image[0].get("Architecture") != "amd64" or image_config.get("User") != "65532:65532":
        raise AssertionError("proof image platform or configured user mismatch")
    image_id = image[0]["Id"]
    if os.listdir(DOCKER_CONFIG):
        raise AssertionError("dedicated Docker CLI configuration directory must remain empty")

    stamp = f"{int(time.time())}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    names = [f"{PREFIX}{stamp}-a", f"{PREFIX}{stamp}-b"]
    runners: list[Rpc] = []
    assert_names_available(names)
    evidence = {"result": "FAIL", "scope": "bounded protocol fixture; not provider or full-lane proof", "sourceIdentity": labels,
                "image": {"ref": args.image, "id": image_id, "os": image[0]["Os"], "architecture": image[0]["Architecture"], "user": image_config["User"]},
                "testContainerNames": names, "tests": []}
    container_ids: dict[str, str] = {}
    cleanup_failures = []
    try:
        for name in names:
            runner = Rpc(name, image_id, labels)
            runners.append(runner)
            container_ids[name] = runner.container_id
            evidence["containerIds"] = dict(container_ids)
        for rpc in runners:
            rpc.start()
        # Both containers exist concurrently. Inspect establishes OS enforcement before any fixture traffic.
        inspections = []
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                inspections = [inspect_container(name, labels, container_ids[name], image_id) for name in names]
                break
            except subprocess.CalledProcessError:
                time.sleep(0.1)
        if len(inspections) != 2:
            raise TimeoutError("two proof containers did not become inspectable")
        evidence["enforcement"] = inspections
        for index, rpc in enumerate(runners):
            lane = "lane-a" if index == 0 else "lane-b"
            files = []
            for rel, text in (("fixture.txt", f"{lane} initial\n"), ("src/check.js", f"export const marker = '{lane}';\n")):
                data = text.encode()
                files.append({"path": rel, "bytesBase64": b64(data), "sha256": digest(data)})
            checks = {
                "verify-fixture": {"executable": "node", "args": ["-e", f"const fs=require('node:fs'); if (!fs.readFileSync('fixture.txt','utf8').includes('updated-{lane}')) process.exit(7); process.stdout.write('verified-{lane}')"], "timeoutSeconds": 5},
                "oversized-output": {"executable": "node", "args": ["-e", "process.stdout.write('x'.repeat(70000))"], "timeoutSeconds": 5},
                "timeout": {"executable": "node", "args": ["-e", "setTimeout(()=>process.stdout.write('late'),5000)"], "timeoutSeconds": 1},
                "readonly-write": {"executable": "node", "args": ["-e", "try { require('node:fs').writeFileSync('/opt/orloom/proof-write','x'); process.exit(9) } catch (e) { if (!['EROFS','EACCES'].includes(e.code)) throw e; process.stdout.write(e.code) }"], "timeoutSeconds": 5},
                "make-symlink": {"executable": "node", "args": ["-e", "require('node:fs').symlinkSync('/etc/passwd','escape')"], "timeoutSeconds": 5}
            }
            initialized = rpc.request("init", {"files": files, "checks": checks})
            if initialized.get("initialized") is not True or initialized.get("fileCount") != 2:
                raise AssertionError("sandbox init did not accept the two fixture files")
            read = rpc.request("read_file", {"path": "fixture.txt"})
            if read.get("text") != f"{lane} initial\n":
                raise AssertionError("read_file did not return this lane's input")
            try:
                rpc.request("read_file", {"path": "../../etc/passwd"})
                raise AssertionError("path traversal unexpectedly accepted")
            except RuntimeError as exc:
                if "invalid" not in str(exc) and "escaped" not in str(exc):
                    raise
            rpc.request("replace_text", {"path": "fixture.txt", "oldText": "initial", "newText": f"updated-{lane}"})
            check = rpc.request("run_check", {"checkId": "verify-fixture"})
            if check.get("exitCode") != 0 or check.get("output") != f"verified-{lane}":
                raise AssertionError("trusted check did not observe the replacement")
            readonly = rpc.request("run_check", {"checkId": "readonly-write"})
            if readonly.get("exitCode") != 0 or readonly.get("output") not in {"EROFS", "EACCES"}:
                raise AssertionError("sandbox rootfs write unexpectedly succeeded")
            oversized = rpc.request("run_check", {"checkId": "oversized-output"})
            if oversized.get("exitCode") == 0 or len(oversized.get("output", "").encode()) > MAX_OUTPUT:
                raise AssertionError("oversized check output was not bounded")
            started = time.monotonic()
            timeout_result = rpc.request("run_check", {"checkId": "timeout"}, timeout=4)
            elapsed = time.monotonic() - started
            if timeout_result.get("exitCode") == 0 or elapsed >= 4:
                raise AssertionError("trusted check timeout did not terminate promptly")
            snapshot = rpc.request("snapshot")
            changed = {row["path"]: row for row in snapshot.get("changed", [])}
            if "fixture.txt" not in changed:
                raise AssertionError("snapshot omitted changed fixture")
            snapshot_bytes = base64.b64decode(changed["fixture.txt"]["bytesBase64"], validate=True)
            if snapshot_bytes != f"{lane} updated-{lane}\n".encode() or digest(snapshot_bytes) != changed["fixture.txt"]["sha256"]:
                raise AssertionError("snapshot bytes/hash do not match the replacement")
            rpc.request("run_check", {"checkId": "make-symlink"})
            try:
                rpc.request("read_file", {"path": "escape"})
                raise AssertionError("symlink read unexpectedly accepted")
            except RuntimeError as exc:
                if "symlink" not in str(exc):
                    raise
            evidence["tests"].append({"lane": lane, "init": "PASS", "read": "PASS", "replace": "PASS", "runCheck": "PASS",
                                      "traversalRejected": "PASS", "symlinkRejected": "PASS", "oversizedResponseBounded": "PASS",
                                      "readOnlyRootfsWriteDenied": "PASS",
                                      "timeoutTerminated": "PASS", "snapshotHashVerified": "PASS", "timeoutElapsedSeconds": round(elapsed, 3),
                                      "snapshotChangedPaths": sorted(changed)})
        evidence["testsCompleted"] = True
    except Exception as error:
        evidence["testsCompleted"] = False
        evidence["testFailure"] = {"type": type(error).__name__, "message": str(error)[:300]}
    finally:
        for rpc in runners:
            try:
                rpc.close()
            except Exception as error:
                cleanup_failures.append({"type": type(error).__name__, "message": str(error)[:200]})
        try:
            recover_created_ids(names, container_ids, labels, image_id)
            evidence["containerIds"] = dict(container_ids)
            cleanup_owned_containers(names, labels, container_ids)
        except Exception as error:
            cleanup_failures.append({"type": type(error).__name__, "message": str(error)[:200]})
        try:
            ensure_no_owned_containers(names)
            evidence["possibleRemainingContainerNames"] = []
        except Exception as error:
            cleanup_failures.append({"type": type(error).__name__, "message": str(error)[:200]})
            evidence["possibleRemainingContainerNames"] = names
        try:
            protected_after = protected_container_snapshot()
            evidence["protectedContainer"] = {"before": protected_before, "after": protected_after,
                                               "unchanged": protected_before == protected_after}
            if protected_before != protected_after:
                cleanup_failures.append({"type": "ProtectedContainerChanged", "message": "ID/start/restart/status changed"})
        except Exception as error:
            cleanup_failures.append({"type": type(error).__name__, "message": "protected-container post-check unavailable"})
        evidence["containerIds"] = dict(container_ids)
        evidence["cleanup"] = "PASS" if not cleanup_failures else "FAIL"
        if cleanup_failures:
            evidence["cleanupFailures"] = cleanup_failures
    evidence["result"] = "PASS" if evidence.get("testsCompleted") and not cleanup_failures else "FAIL"
    print(json.dumps(evidence, sort_keys=True))
    return 0 if evidence["result"] == "PASS" else 1
if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"result": "FAIL", "errorType": type(error).__name__, "error": str(error)[:300]}), file=sys.stderr)
        sys.exit(1)
