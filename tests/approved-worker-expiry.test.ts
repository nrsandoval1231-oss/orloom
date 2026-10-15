import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleApprovedTaskExpiry } from "../apps/worker/src/approved-startup.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

function fakeClock(initial: number) {
  let now = initial;
  let nextId = 1;
  const scheduled = new Map<number, { delay: number; callback: () => void }>();
  const cleared: number[] = [];
  return {
    now: () => now,
    setNow(value: number) { now = value; },
    scheduled,
    cleared,
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      scheduled.set(id, { delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id: ReturnType<typeof setTimeout>) {
      const key = id as unknown as number;
      cleared.push(key);
      scheduled.delete(key);
    },
    fire(id: number) {
      const timer = scheduled.get(id);
      assert(timer, `timer ${id} must be pending`);
      scheduled.delete(id);
      timer.callback();
    }
  };
}

test("long approved-task expiry reschedules against the absolute deadline without aborting early", () => {
  const clock = fakeClock(1_000);
  const deadline = clock.now() + 30 * 24 * 60 * 60 * 1000;
  let aborts = 0;
  const cancel = scheduleApprovedTaskExpiry(new Date(deadline).toISOString(), () => aborts++, clock);

  assert.equal(clock.scheduled.size, 1);
  let [id, timer] = [...clock.scheduled.entries()][0]!;
  assert.equal(timer.delay, MAX_TIMEOUT_MS);
  clock.setNow(clock.now() + timer.delay);
  clock.fire(id);
  assert.equal(aborts, 0, "the first capped wait must not expire a 30-day manifest");
  assert.equal(clock.scheduled.size, 1);
  [id, timer] = [...clock.scheduled.entries()][0]!;
  assert.equal(timer.delay, deadline - clock.now());
  assert(timer.delay > 0 && timer.delay <= MAX_TIMEOUT_MS);

  clock.setNow(deadline);
  clock.fire(id);
  assert.equal(aborts, 1);
  assert.equal(clock.scheduled.size, 0);
  cancel();
  assert.equal(aborts, 1, "expiry callback and cleanup are idempotent");
});

test("expiry aborts immediately for an already-reached absolute deadline", () => {
  const clock = fakeClock(10_000);
  let aborts = 0;
  const cancel = scheduleApprovedTaskExpiry(new Date(10_000).toISOString(), () => aborts++, clock);
  assert.equal(aborts, 1);
  assert.equal(clock.scheduled.size, 0);
  cancel();
  assert.equal(aborts, 1);
});

test("each timer wakeup reevaluates wall-clock shifts before expiring", () => {
  const clock = fakeClock(30_000);
  const deadline = clock.now() + 30 * 24 * 60 * 60 * 1000;
  let aborts = 0;
  const cancel = scheduleApprovedTaskExpiry(new Date(deadline).toISOString(), () => aborts++, clock);
  const [firstId, firstTimer] = [...clock.scheduled.entries()][0]!;
  clock.setNow(clock.now() + firstTimer.delay - 5_000);
  clock.fire(firstId);
  assert.equal(aborts, 0, "a backward wall-clock shift must extend the remaining wait");
  const [secondId, secondTimer] = [...clock.scheduled.entries()][0]!;
  assert.equal(secondTimer.delay, deadline - clock.now());
  clock.setNow(deadline + 1);
  clock.fire(secondId);
  assert.equal(aborts, 1, "a forward wall-clock shift is honored at the next wakeup");
  cancel();
});

test("timer wakeup reevaluates wall clock and cleanup cancels pending reschedules", () => {
  const clock = fakeClock(20_000);
  const deadline = clock.now() + 30 * 24 * 60 * 60 * 1000;
  let aborts = 0;
  const cancel = scheduleApprovedTaskExpiry(new Date(deadline).toISOString(), () => aborts++, clock);
  const [firstId, firstTimer] = [...clock.scheduled.entries()][0]!;
  clock.setNow(clock.now() + firstTimer.delay);
  clock.fire(firstId);
  const [pendingId] = [...clock.scheduled.entries()][0]!;
  cancel();
  assert.equal(clock.scheduled.size, 0);
  assert(clock.cleared.includes(pendingId));
  assert.equal(aborts, 0);
});

