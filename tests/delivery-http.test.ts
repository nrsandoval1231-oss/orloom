import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../apps/control-plane/src/server.js";
import { MemoryJobStore } from "../packages/contracts/src/memory-store.js";
import { MemoryMissionStore } from "../packages/contracts/src/memory-mission-store.js";
import type { DeliveryAuthority, DeliveryPolicy } from "../packages/integration/src/delivery.js";

const command = {
  version: "orloom.delivery-command.v1",
  missionId: "11111111-1111-4111-8111-111111111111",
  sliceId: "slice-1",
  leaseEpoch: 1,
  integratedSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  reviewArtifactId: "review-001",
  reviewArtifactDigest: "d".repeat(64),
  idempotencyKey: "delivery-idempotency-00001"
};
const policy: DeliveryPolicy = {
  repository: "acme/orloom",
  appId: 11,
  installationId: 9,
  baseRef: "main",
  baseSha: "c".repeat(40),
  protectedRefs: ["main"],
  checkIds: ["node-repo-suite-v1"],
  policyVersion: "policy-v1",
  policyDigest: "d".repeat(64),
  imageDigest: "e".repeat(64),
  checkName: "Orloom certified suite"
};
const authority = {} as DeliveryAuthority;

async function withServer(controller?: { policy: DeliveryPolicy; authority: DeliveryAuthority }, run?: (url: string) => Promise<void>, missionStore = new MemoryMissionStore()) {
  const server = createControlPlane(
    { mode: "local", port: 0, sessionToken: "delivery-http-test" },
    new MemoryJobStore(),
    missionStore,
    undefined, undefined, undefined, undefined, undefined,
    controller
  );
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try { await run?.(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const send = (url: string, value: unknown, authenticated = true) => fetch(`${url}/api/delivery`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(authenticated ? { cookie: "orloom_session=delivery-http-test" } : {})
  },
  body: JSON.stringify(value)
});

test("delivery route authenticates owner session and fails closed without controller authority", async () => {
  await withServer(undefined, async url => {
    assert.equal((await send(url, command, false)).status, 401);
    const response = await send(url, command);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Delivery authority is not configured" });
  });
});

test("delivery route accepts only the exact command shape and rejects browser policy overrides", async () => {
  await withServer({ policy, authority }, async url => {
    assert.equal((await send(url, { ...command, repository: "attacker/repo" })).status, 400);
    assert.equal((await send(url, { ...command, baseSha: "f".repeat(40) })).status, 400);
    assert.equal((await send(url, { ...command, appId: 999 })).status, 400);
    assert.equal((await send(url, { ...command, leaseEpoch: "1" })).status, 400);
  });
});

test("delivery route reports an unavailable retained delivery pipeline as a conflict without starting effects", async () => {
  await withServer({ policy, authority }, async url => {
    const response = await send(url, command);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Delivery could not be confirmed" });
  });
});

test("delivery route maps unexpected store failures to a generic unavailable response", async () => {
  const brokenStore = {
    getMission: async () => { throw new Error("private-store-detail"); },
    getIntegratedIntent: async () => null,
    getIntegratedCertificate: async () => null,
    createDeliveryIntent: async () => { throw new Error("unreachable"); },
    updateDeliveryIntent: async () => { throw new Error("unreachable"); },
    getDeliveryIntent: async () => null,
    claimDeliveryEffect: async () => { throw new Error("unreachable"); },
    observeDeliveryEffect: async () => { throw new Error("unreachable"); },
    getTrustedAttempt: async () => null
  } as never;
  const trustedAuthority = {
    integrator: { repositoryIdentity: policy.repository, uploadRef: async () => undefined },
    reviews: {},
    artifacts: {},
    github: { appId: policy.appId, withContentsWriteToken: async () => undefined }
  } as unknown as DeliveryAuthority;
  await withServer({ policy, authority: trustedAuthority }, async url => {
    const response = await send(url, command);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text, JSON.stringify({ error: "Delivery is unavailable" }));
    assert.doesNotMatch(text, /private-store-detail/);
  }, brokenStore);
});
