#!/usr/bin/env python3
import json
import os
import subprocess
import sys

DOCKER = ["/usr/bin/docker", "--config", os.environ["INSPECT_CONFIG"], "--host", "unix:///var/run/docker.sock"]
IMAGE = "ghcr.io/openai/codex-universal@sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304"
IDS = sys.argv[1:]
if len(IDS) != 2:
    raise SystemExit("expected exactly two sandbox container IDs")
items = json.loads(subprocess.check_output(DOCKER + ["inspect", *IDS], text=True))
for item in items:
    assert item["Image"] == "sha256:905e512f36460e1be4cfedb30928a8a28299edb0fcd5de7998ceaa72d27fe304"
    config = item["Config"]
    host = item["HostConfig"]
    assert item["State"]["Status"] == "running"
    assert host["Runtime"] == "runsc"
    assert host["NetworkMode"] == "none"
    assert host["ReadonlyRootfs"] is True
    assert config["User"] == "65532:65532"
    assert host["Privileged"] is False
    assert "ALL" in host["CapDrop"]
    assert "no-new-privileges:true" in host["SecurityOpt"]
    assert host["PidsLimit"] == 64
    assert host["Memory"] == 268435456
    assert host["MemorySwap"] == 268435456
    assert host["NanoCpus"] == 500000000
    assert host["AutoRemove"] is True
    assert not host.get("Binds")
    assert not host.get("Devices")
    assert not host.get("PortBindings")
    assert not host.get("DeviceRequests")
    assert set(host["Tmpfs"]) == {"/tmp", "/work"}
    assert item["Mounts"] == []  # Docker reports --tmpfs in HostConfig.Tmpfs, not Mounts.
    sensitive = ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "ORLOOM_", "GITHUB_TOKEN", "GH_TOKEN", "DOCKER_")
    names = {entry.split("=", 1)[0] for entry in config.get("Env", [])}
    assert not any(name == prefix or name.startswith(prefix) for name in names for prefix in sensitive)
    print(f"inspect=PASS name={item['Name'].lstrip('/')} runtime=runsc network=none uid={config['User']} readonly=true mounts=2tmpfs caps_drop_all=true pids=64 memory=268435456 cpu_nanos=500000000")
