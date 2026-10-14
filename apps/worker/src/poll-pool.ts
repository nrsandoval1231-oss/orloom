import type { WorkerLeaseContract } from "../../../packages/contracts/src/worker-protocol.js";

export interface WorkerPollPoolOptions {
  concurrency: number;
  pollIntervalMs: number;
  signal: AbortSignal;
  claim(): Promise<WorkerLeaseContract | null>;
  execute(lease: WorkerLeaseContract): Promise<void>;
  onPollError?(): void;
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Runs a fixed operator-bounded number of independent claim loops; A remains the global lease arbiter. */
export async function runWorkerPollPool(options: WorkerPollPoolOptions): Promise<void> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 6) throw new Error("Worker poll concurrency must be between one and six");
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1 || options.pollIntervalMs > 60_000) throw new Error("Worker poll interval is outside its bounded range");
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (!options.signal.aborted) {
      try {
        const lease = await options.claim();
        if (lease) await options.execute(lease);
        else await waitForPoll(options.pollIntervalMs, options.signal);
      } catch {
        options.onPollError?.();
        await waitForPoll(Math.min(options.pollIntervalMs, 5_000), options.signal);
      }
    }
  }));
}
