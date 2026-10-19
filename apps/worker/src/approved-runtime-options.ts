import type { DockerWorkerRuntimeOptions } from "./docker-runtime.js";

export type ApprovedRuntimeOptions = Omit<DockerWorkerRuntimeOptions, "runtimeJournal" | "checkoutTransport">;

export function approvedRuntimeOptions(
  options: Omit<ApprovedRuntimeOptions, "executionInputProfile">,
  executionInputProfile?: ApprovedRuntimeOptions["executionInputProfile"],
): Readonly<ApprovedRuntimeOptions> {
  return Object.freeze({ ...options, ...(executionInputProfile ? { executionInputProfile } : {}) });
}
