import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";

test("HTTP control plane exposes status, authenticates job operations, and never executes jobs", async () => {
  const server = createControlPlane({ mode: "local", port: 0, sessionToken: "local-test-secret" }, new MemoryJobStore());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok", mode: "local", liveExecution: false });
    assert.equal((await fetch(`${base}/api/jobs`, { method: "POST", body: "{}" })).status, 401);
    const unlocked = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "local-test-secret" }) });
    assert.equal(unlocked.status, 204);
    const setCookie = unlocked.headers.get("set-cookie");
    if (!setCookie) throw new Error("Missing session cookie");
    assert(setCookie.includes("HttpOnly"));
    const cookie = setCookie.split(";")[0];
    const created = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie! }, body: JSON.stringify({ repository: "example/repo", task: "inspect" }) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).status, "queued");
    assert.equal((await fetch(`${base}/api/run`, { method: "POST" })).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("unexpected provider/store errors return generic 500 without reflecting secrets", async () => {
  const baseStore = new MemoryJobStore();
  const jobs = {
    submit: async () => { throw new Error("provider-secret-value must-not-escape"); },
    get: baseStore.get.bind(baseStore),
    lease: baseStore.lease.bind(baseStore),
    start: baseStore.start.bind(baseStore),
    complete: baseStore.complete.bind(baseStore),
    expireLeases: baseStore.expireLeases.bind(baseStore)
  };
  const server = createControlPlane({ mode: "local", port: 0, sessionToken: "http-test-secret" }, jobs);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unlocked = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "http-test-secret" }) });
    const cookie = unlocked.headers.get("set-cookie")?.split(";")[0]; assert(cookie);
    const result = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ repository: "owner/repo", task: "task" }) });
    assert.equal(result.status, 500);
    const text = await result.text();
    assert.equal(text, JSON.stringify({ error: "Internal server error" }));
    assert.doesNotMatch(text, /provider-secret-value/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
