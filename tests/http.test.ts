import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";

function postWithHost(url: string, host: string, origin: string, value: unknown, extraHeaders: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { host, origin, "content-type": "application/json", ...extraHeaders } }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(JSON.stringify(value));
  });
}

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

test("cloud sessions are opaque, secure, expiring, and writes require the configured origin and host", async () => {
  const config = { mode: "cloud" as const, port: 0, sessionToken: "cloud-secret", publicOrigin: "https://orloom.example", host: "orloom.example", sessionTtlSeconds: 1 };
  const server = createControlPlane(config, new MemoryJobStore());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await postWithHost(`${base}/session`, config.host, "https://attacker.example", { token: config.sessionToken })), 403);
    for (const host of ["orloom.example/extra", "attacker@orloom.example", "orloom.example#fragment", "orloom .example", "orloom.example:443", "orloom.example:3000"]) {
      assert.equal(await postWithHost(`${base}/session`, host, config.publicOrigin, { token: config.sessionToken }), 403, `expected Host ${JSON.stringify(host)} to be rejected`);
    }
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.match(html, /Cloud control plane\. Jobs are queued only/);
    assert.match(html, /Unlock submissions/);
    assert.doesNotMatch(html, /Unlock local submissions/);
    const login = await new Promise<{ status: number; cookie: string | undefined }>((resolve, reject) => {
      const req = request(`${base}/session`, { method: "POST", headers: { host: config.host, origin: config.publicOrigin, "content-type": "application/json" } }, res => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, cookie: res.headers["set-cookie"]?.[0] }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ token: config.sessionToken }));
    });
    assert.equal(login.status, 204);
    const setCookie = login.cookie; assert(setCookie);
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Max-Age=1/);
    const session = setCookie.split(";")[0]!.slice("orloom_session=".length);
    assert.notEqual(decodeURIComponent(session), config.sessionToken);
    assert.equal(await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/jobs`, { method: "POST", headers: { host: config.host, origin: config.publicOrigin, cookie: `orloom_session=${session}`, "content-type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject); req.end(JSON.stringify({ repository: "owner/repo", task: "queue" }));
    }), 201);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await postWithHost(`${base}/api/jobs`, config.host, config.publicOrigin, { repository: "owner/repo", task: "expired" }, { cookie: `orloom_session=${session}` }), 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
