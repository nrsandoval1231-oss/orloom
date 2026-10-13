import type { MissionStore } from "../../contracts/src/mission.js";

export interface LeaseReconcilerOptions {
  intervalMs?: number;
  batchSize?: number;
  onError?: () => void;
}

/** Reconcile one bounded batch at startup, then continue until stopped. */
export async function startLeaseReconciler(
  store: Pick<MissionStore, "expire">,
  options: LeaseReconcilerOptions = {}
): Promise<() => Promise<void>> {
  const intervalMs = options.intervalMs ?? 5_000;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("Invalid lease reconciler configuration");
  }

  await store.expire(new Date(), batchSize);
  let active: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (active) return;
    active = store.expire(new Date(), batchSize)
      .then(() => undefined)
      .catch(() => { try { options.onError?.(); } catch { /* A logger must not destabilize lease recovery. */ } })
      .finally(() => { active = null; });
  }, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); if (active) await active; };
}
