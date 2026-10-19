import { runApprovedDockerWorkerLane, type ApprovedDockerWorkerLaneDependencies } from "../../control-plane/src/approved-worker-lane.js";
import { DockerWorkerRuntime, type DockerWorkerRuntimeOptions } from "./docker-runtime.js";
import type { TrustedRuntimeJournalBridge } from "../../control-plane/src/trusted-runtime-journal-bridge.js";

export type ApprovedRuntimeOptions = Omit<DockerWorkerRuntimeOptions, "runtimeJournal" | "checkoutTransport">;

export function approvedRuntimeOptions(
  options: Omit<ApprovedRuntimeOptions, "executionInputProfile">,
  executionInputProfile?: ApprovedRuntimeOptions["executionInputProfile"],
): Readonly<ApprovedRuntimeOptions> {
  return Object.freeze({ ...options, ...(executionInputProfile ? { executionInputProfile } : {}) });
}

export function createApprovedRuntimeComposition(
  baseOptions: Omit<ApprovedRuntimeOptions, "executionInputProfile">,
  executionInputProfile: ApprovedRuntimeOptions["executionInputProfile"],
  runtimeJournal: TrustedRuntimeJournalBridge,
  laneExecutor: typeof runApprovedDockerWorkerLane = runApprovedDockerWorkerLane,
) {
  const runtimeOptions = approvedRuntimeOptions(baseOptions, executionInputProfile);
  const reconciliationRuntime = new DockerWorkerRuntime({ ...runtimeOptions, runtimeJournal });
  return {
    runtimeOptions,
    reconciliationRuntime,
    executeLane(lease: unknown, dependencies: Omit<ApprovedDockerWorkerLaneDependencies, "runtimeOptions">) {
      return laneExecutor(lease, { ...dependencies, runtimeOptions });
    },
  };
}
