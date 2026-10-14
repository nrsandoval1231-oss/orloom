import assert from "node:assert/strict";
import path from "node:path";

const uint = value => {
  assert.match(value, /^[0-9]+$/);
  return Number(value);
};
const stat = value => Object.fromEntries(value.trim().split("\n").filter(Boolean).map(row => {
  const [key, raw] = row.split(/\s+/, 2); return [key, uint(raw)];
}));

export function createCgroupObserver({ readFile, now = () => new Date().toISOString() }) {
  const exactCgroup = async (cid, pid) => {
    assert.match(cid, /^[a-f0-9]{64}$/);
    const expected = "/sys/fs/cgroup/system.slice/docker-" + cid + ".scope";
    try { await readFile(path.posix.join(expected, "memory.current"), "utf8"); return { path: expected, source: "expected" }; } catch {}
    if (!Number.isInteger(pid) || pid < 1) return null;
    try {
      const row = (await readFile("/proc/" + pid + "/cgroup", "utf8")).trim().split("\n").find(value => value.startsWith("0::"));
      if (!row) return null;
      const relative = row.slice(3);
      if (!relative.endsWith("docker-" + cid + ".scope")) return null;
      return { path: path.posix.join("/sys/fs/cgroup", relative), source: "verified-proc" };
    } catch { return null; }
  };
  const sample = async (binding, elapsedMs) => {
    const [current, memoryStat, events] = await Promise.all([
      readFile(path.posix.join(binding.path, "memory.current"), "utf8"),
      readFile(path.posix.join(binding.path, "memory.stat"), "utf8"),
      readFile(path.posix.join(binding.path, "memory.events"), "utf8")
    ]);
    return { format: "orloom.c3.jobs-probe.cgroup.v1", observedAt: now(), elapsedMs,
      cgroupSource: binding.source, memoryCurrentBytes: uint(current.trim()),
      memoryStat: stat(memoryStat), memoryEvents: stat(events) };
  };
  return { exactCgroup, sample };
}
