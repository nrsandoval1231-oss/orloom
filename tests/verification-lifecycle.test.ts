import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustedCheckCoordinator, type TrustedCheckRunner } from "../packages/governor/src/governor.js";
import type { MissionStore } from "../packages/contracts/src/mission.js";
import type { TrustedCheckRequestV1, TrustedCheckReceiptV1 } from "../packages/contracts/src/verification.js";

// Exercise the actual coordinator dispatch loop with controlled operation seams;
// these synthetic requests/receipts are not certification or runner acceptance.
for (const stopAt of ["prepare", "run", "submit"] as const) {
  test(`trusted verification stops at the ${stopAt} boundary before another dispatch`, async () => {
    const calls: string[] = [];
    let stopped = false;
    const store = { async getMission() { return { slices: [{ id: "slice", checks: ["first", "second"] }] }; } } as unknown as MissionStore;
    const coordinator = new TrustedCheckCoordinator(store, {} as TrustedCheckRunner, { allowedChecks: ["first", "second"], imageDigest: "a".repeat(64), verifierId: "synthetic", policyDigest: "b".repeat(64), leasePolicyDigest: "c".repeat(64), policyVersion: "fixture", attemptLifetimeMs: 1000 });
    const pending = Reflect.get(coordinator, "pending") as Map<string, unknown>;
    coordinator.prepare = async (_mission, _slice, check) => {
      calls.push(`prepare:${check}`);
      pending.set(check, { capability: "synthetic-capability" });
      if (stopAt === "prepare") stopped = true;
      return { attemptId: check } as TrustedCheckRequestV1;
    };
    coordinator.run = async request => {
      calls.push(`run:${request.attemptId}`);
      if (stopAt === "run") stopped = true;
      return { request } as TrustedCheckReceiptV1;
    };
    coordinator.submit = async receipt => {
      calls.push(`submit:${receipt.request.attemptId}`);
      stopped = true;
      return null;
    };
    const guard = async () => { if (stopped) throw new Error("fixture lifecycle stopped"); };
    await assert.rejects(coordinator.verifySlice("mission", "slice", guard), /fixture lifecycle stopped/);
    const expected = ["prepare:first", ...(stopAt === "prepare" ? [] : ["run:first"]), ...(stopAt === "submit" ? ["submit:first"] : [])];
    assert.deepEqual(calls, expected, "no later operation or second check dispatches after observed stop");
  });
}
