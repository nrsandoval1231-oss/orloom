/** Private controller settlement input. This is deliberately not exposed by an HTTP route. */
export const trustedRuntimeReconcilerSource = "orloom.trusted-docker-reconciler.v1" as const;

export interface CancellationRuntimeIdentity {
  readonly missionId: string;
  readonly sliceId: string;
  readonly leaseEpoch: number;
  readonly controllerRunId: string;
}

export interface CancellationRuntimeBinding {
  readonly name: string;
  readonly imageRef: string;
  readonly labelsDigest: string;
}

export interface CancellationRuntimeEntry {
  readonly version: "orloom.runtime-journal.v2";
  readonly identity: CancellationRuntimeIdentity;
  readonly name: string;
  readonly imageRef: string;
  readonly labelsDigest: string;
  readonly containerId: string | null;
  readonly state: "intent" | "created" | "unknown" | "absent";
  readonly updatedAt: string;
  readonly reconciliation: {
    readonly source: typeof trustedRuntimeReconcilerSource;
    readonly outcome: "absent" | "unknown";
    readonly identity: CancellationRuntimeIdentity;
    readonly name: string;
    readonly imageRef: string;
    readonly labelsDigest: string;
    readonly containerId: string | null;
    readonly observedAt: string;
  } | null;
  readonly history: readonly unknown[];
}

const digest = /^[a-f0-9]{64}$/;
const image = /^(?:ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:|sha256:)[a-f0-9]{64}$/i;
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Rejects all states except a fully bound, exact, trusted absent observation.
 * UNKNOWN remains durable quarantine and can never release execution capacity. */
export function validateCancellationSettlementEvidence(entry: CancellationRuntimeEntry, binding: CancellationRuntimeBinding): boolean {
  if (!entry || typeof entry !== "object" || !binding || typeof binding !== "object") return false;
  const o = entry.reconciliation;
  if (entry?.version !== "orloom.runtime-journal.v2" || entry.state !== "absent" || !o || o.source !== trustedRuntimeReconcilerSource || o.outcome !== "absent") return false;
  const id = entry.identity;
  if (!id || typeof id !== "object" || !id.missionId || !id.sliceId || !Number.isSafeInteger(id.leaseEpoch) || id.leaseEpoch < 1 || typeof id.controllerRunId !== "string" || !digest.test(id.controllerRunId)) return false;
  if (!o.identity || typeof o.identity !== "object" || typeof o.identity.controllerRunId !== "string") return false;
  if (!digest.test(entry.labelsDigest) || !image.test(entry.imageRef) || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(entry.name)) return false;
  if (entry.name !== binding.name || entry.imageRef !== binding.imageRef || entry.labelsDigest !== binding.labelsDigest) return false;
  if (entry.containerId === null || !digest.test(entry.containerId) || o.containerId !== entry.containerId) return false;
  if (o.identity.missionId !== id.missionId || o.identity.sliceId !== id.sliceId || o.identity.leaseEpoch !== id.leaseEpoch || o.identity.controllerRunId !== id.controllerRunId) return false;
  if (o.name !== entry.name || o.imageRef !== entry.imageRef || o.labelsDigest !== entry.labelsDigest || !timestamp(o.observedAt) || !timestamp(entry.updatedAt)) return false;
  if (!Array.isArray(entry.history) || entry.history.length < 3 || entry.history.length > 4) return false;
  const states = entry.history.map(row => row && typeof row === "object" ? (row as {state?:unknown}).state : null);
  const legal = new Set(["intent>created>absent","intent>created>unknown>absent"]);
  if (!legal.has(states.join(">"))) return false;
  const intent = entry.history[0] as { at?: unknown };
  const created = entry.history[1] as { at?: unknown; containerId?: unknown };
  if (typeof intent.at !== "string" || !timestamp(intent.at) || typeof created.at !== "string" || !timestamp(created.at) || Date.parse(created.at) < Date.parse(intent.at) || created.containerId !== entry.containerId) return false;
  if (entry.history.length === 4) {
    const unknown = entry.history[2] as { at?: unknown; observation?: typeof o };
    const prior = unknown.observation;
    if (typeof unknown.at !== "string" || !timestamp(unknown.at) || Date.parse(unknown.at) < Date.parse(created.at) || !prior || !prior.identity || typeof prior.identity !== "object" || prior.source !== o.source || prior.outcome !== "unknown" || prior.identity.missionId !== id.missionId || prior.identity.sliceId !== id.sliceId || prior.identity.leaseEpoch !== id.leaseEpoch || prior.identity.controllerRunId !== id.controllerRunId || prior.name !== entry.name || prior.imageRef !== entry.imageRef || prior.labelsDigest !== entry.labelsDigest || prior.containerId !== entry.containerId || !timestamp(prior.observedAt) || Date.parse(prior.observedAt) < Date.parse(created.at) || Date.parse(prior.observedAt) > Date.parse(unknown.at)) return false;
  }
  const previous = entry.history.at(-2) as { at?: unknown };
  const last = entry.history.at(-1) as { at?: unknown; observation?: unknown };
  const lastObservation = last.observation as typeof o | undefined;
  if (typeof previous.at !== "string" || !timestamp(previous.at) || typeof last.at !== "string" || last.at !== entry.updatedAt || !lastObservation || !lastObservation.identity || typeof lastObservation.identity !== "object" || lastObservation.source !== o.source || lastObservation.outcome !== o.outcome || lastObservation.observedAt !== o.observedAt || lastObservation.containerId !== o.containerId || lastObservation.name !== o.name || lastObservation.imageRef !== o.imageRef || lastObservation.labelsDigest !== o.labelsDigest || lastObservation.identity.missionId !== o.identity.missionId || lastObservation.identity.sliceId !== o.identity.sliceId || lastObservation.identity.leaseEpoch !== o.identity.leaseEpoch || lastObservation.identity.controllerRunId !== o.identity.controllerRunId) return false;
  return Date.parse(o.observedAt) >= Date.parse(previous.at) && Date.parse(o.observedAt) <= Date.parse(entry.updatedAt);
}
