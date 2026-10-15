import type { MissionStore } from "../../../packages/contracts/src/mission.js";
import type { CancellationRuntimeEntry } from "../../../packages/contracts/src/cancellation-settlement.js";
import type { RuntimeIdentity, RuntimeJournal, RuntimeJournalEntry, RuntimeReconciliationObservation } from "../../worker/src/runtime-journal.js";

/** Mirrors trusted worker journal transitions into the controller-private cancellation ledger. */
export class TrustedRuntimeJournalBridge implements RuntimeJournal {
  constructor(private readonly journal: RuntimeJournal, private readonly store: MissionStore) {
    if (!store.registerCancellationRuntimeBinding || !store.bindCancellationRuntimeContainer || !store.reconcileCancellationRuntime) {
      throw new Error("Cancellation runtime settlement is not configured");
    }
  }

  async recordIntent(entry: Parameters<RuntimeJournal["recordIntent"]>[0]): Promise<void> {
    await this.store.registerCancellationRuntimeBinding!({ ...entry.identity }, { name: entry.name, imageRef: entry.imageRef, labelsDigest: entry.labelsDigest });
    await this.journal.recordIntent(entry);
  }

  async recordCreated(identity: RuntimeIdentity, containerId: string, labelsDigest: string): Promise<void> {
    await this.journal.recordCreated(identity, containerId, labelsDigest);
    await this.store.bindCancellationRuntimeContainer!({ ...identity }, containerId);
  }

  recordUnknown(observation: RuntimeReconciliationObservation): Promise<void> { return this.journal.recordUnknown(observation); }
  recordAbsent(observation: RuntimeReconciliationObservation): Promise<void> { return this.journal.recordAbsent(observation); }
  unresolved(): Promise<RuntimeJournalEntry[]> { return this.journal.unresolved(); }

  /** Replay settlement from the journal's retained evidence, including terminal ABSENT rows. */
  async reconcileRetained(controllerRunId?: string): Promise<Array<"settled" | "quarantined" | "ignored">> {
    if (!this.journal.entries) throw new Error("Runtime journal does not expose retained entries for settlement replay");
    const entries = await this.journal.entries();
    const results: Array<"settled" | "quarantined" | "ignored"> = [];
    for (const entry of entries) {
      if (controllerRunId && entry.identity.controllerRunId !== controllerRunId) continue;
      if (entry.state === "intent") continue;
      // The journal write can succeed while the SQL container bind transiently fails.
      // Replay the exact recorded ID before attempting terminal settlement.
      if (entry.containerId) await this.store.bindCancellationRuntimeContainer!({ ...entry.identity }, entry.containerId);
      if (entry.state === "created") continue;
      results.push(await this.store.reconcileCancellationRuntime!(entry as CancellationRuntimeEntry));
    }
    return results;
  }
}
