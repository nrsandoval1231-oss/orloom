import assert from 'node:assert/strict';
import path from 'node:path';

export function createCgroupObserver({ readFile, now = () => new Date().toISOString() }) {
  const unsigned = value => {
    assert.match(value, /^\d+$/);
    const parsed = Number(value);
    assert.ok(Number.isSafeInteger(parsed));
    return parsed;
  };
  const selectedStats = (text, names) => {
    const values = new Map(text.trim().split('\n').map(line => line.split(' ')).filter(parts => parts.length === 2));
    return Object.fromEntries(names.map(name => [name, unsigned(values.get(name) ?? '')]));
  };
  const exactCgroup = async (cid, pid) => {
    assert.match(cid, /^[a-f0-9]{64}$/);
    const expected = `/sys/fs/cgroup/system.slice/docker-${cid}.scope`;
    try { await readFile(path.posix.join(expected, 'memory.current'), 'utf8'); return { path: expected, source: 'expected' }; } catch {}
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      const rows = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim().split('\n');
      if (!rows.includes(`0::/system.slice/docker-${cid}.scope`)) return null;
      await readFile(path.posix.join(expected, 'memory.current'), 'utf8');
      return { path: expected, source: 'proc-v2-exact' };
    } catch { return null; }
  };
  const readCgroupSample = async (binding, elapsedMs) => {
    const [current, stat, events] = await Promise.all([
      readFile(path.posix.join(binding.cgroup.path, 'memory.current'), 'utf8'),
      readFile(path.posix.join(binding.cgroup.path, 'memory.stat'), 'utf8'),
      readFile(path.posix.join(binding.cgroup.path, 'memory.events'), 'utf8'),
    ]);
    return {
      format: 'orloom-c3-memory-observation-v1', observedAt: now(), elapsedMs,
      candidateSha: binding.candidateSha, imageDigest: binding.imageDigest, sandboxId: binding.runId, containerId: binding.cid,
      cgroupSource: binding.cgroup.source, memoryCurrentBytes: unsigned(current.trim()),
      memoryStat: selectedStats(stat, ['anon', 'file', 'shmem']),
      memoryEvents: selectedStats(events, ['low', 'high', 'max', 'oom', 'oom_kill']),
    };
  };
  return { exactCgroup, readCgroupSample };
}
