import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SqlJobStore } from "../packages/contracts/src/sql-store.js";
import { StateConflictError } from "../packages/contracts/src/job.js";

test("SQL job persistence behaviors", async (t) => {
  const db = new PGlite();

  try {
    const migration = await readFile(new URL("../../db/migrations/001_initial.sql", import.meta.url), "utf8");
    await db.exec(migration);

    await t.test("lifecycle fences stale completion and preserves UNKNOWN after interrupted execution", async () => {
      const store = new SqlJobStore(db);
      const queued = await store.submit({ repository: "example/repo", task: "inspect" });
      assert.equal(queued.status, "queued");
      const leased = await store.lease(queued.id, "lease-a", new Date(Date.now() + 60_000));
      assert.equal(leased.status, "leased");
      await store.start(queued.id, "lease-a");
      await assert.rejects(store.complete(queued.id, "stale", "bad"), StateConflictError);
      assert.equal(await store.expireLeases(new Date(Date.now() + 120_000)), 1);
      assert.equal((await store.get(queued.id))?.status, "unknown");

      const second = await store.submit({ repository: "example/repo", task: "one-shot effect" });
      await store.lease(second.id, "lease-b", new Date(Date.now() + 60_000));
      await store.start(second.id, "lease-b");
      assert.equal((await store.complete(second.id, "lease-b", "done")).status, "succeeded");
      await assert.rejects(store.complete(second.id, "lease-b", "again"), StateConflictError);
    });

    await t.test("migration constrains status and lease consistency", async () => {
      await assert.rejects(db.query("INSERT INTO jobs (id,repository,task,status) VALUES (gen_random_uuid(),'a/b','x','made-up')"));
    });
  } finally {
    await db.close();
  }
});