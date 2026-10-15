import { createHash } from "node:crypto";
import type { Config } from "../../../packages/config/src/config.js";
import type { Mission, MissionEvent, MissionPlan, MissionSlice } from "../../../packages/contracts/src/mission.js";
import { canonicalJson } from "../../../packages/judgment/src/canonical.js";

export type OwnerCancellationState = "none" | "requested" | "pre-runtime-settled" | "runtime-absence-settled" | "quarantined-unknown";
export interface OwnerReadiness {
  state: "unavailable" | "unverified" | "ready";
  meaning: string;
  liveExecution: "unverified";
  reasons: string[];
  configuration: {
    mode: "local" | "cloud";
    workerPolicyConfigured: boolean;
    verificationConfigured: boolean;
    integrationConfigured: boolean;
    deliveryConfigured: boolean;
    capacityEvidenceDigest: string | null;
    capacityEvidenceExpiresAt: string | null;
    baseSha: string | null;
    planDigest: string | null;
    checkPolicyDigest: string | null;
  };
}
export interface OwnerCancellation {
  state: OwnerCancellationState;
  slices: Array<{ sliceId: string; leaseEpoch: number; state: OwnerCancellationState; reasons: string[] }>;
  reasons: string[];
}

const digest64 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function validPlan(mission: Mission | null, plan: MissionPlan | null, slices: MissionSlice[] | null): boolean {
  if (!mission || !plan || !slices || plan.missionId !== mission.id || !plan.approvedAt || !iso(plan.approvedAt) || !Array.isArray(plan.slices) || !plan.slices.length) return false;
  const ids = plan.slices.map(slice => slice.id);
  if (new Set(ids).size !== ids.length || new Set(slices.map(slice => slice.id)).size !== slices.length || ids.length !== slices.length) return false;
  return plan.slices.every(planned => {
    const current = slices.find(slice => slice.id === planned.id);
    return Boolean(current && current.missionId === mission.id && current.objective === planned.objective && current.owner === planned.owner
      && current.budgetCents === planned.budgetCents && canonicalJson(current.dependencies) === canonicalJson(planned.dependencies)
      && canonicalJson(current.checks) === canonicalJson(planned.checks) && canonicalJson(current.scopes) === canonicalJson(planned.scopes));
  });
}

/** Reports only control-plane policy and durable plan prerequisites, never live execution health. */
export function evaluateOwnerReadiness(config: Config, authorities: { verification: boolean; integration: boolean; delivery: boolean }, mission: Mission | null, plan: MissionPlan | null, slices: MissionSlice[] | null, now = Date.now()): OwnerReadiness {
  const reasons: string[] = [];
  const expiry = config.capacityEvidenceExpiresAt ?? null;
  const validExpiry = iso(expiry) && Date.parse(expiry) > now;
  const validCapacity = Number.isSafeInteger(config.capacitySlots) && (config.capacitySlots ?? 0) > 0
    && digest64(config.capacityEvidenceDigest) && validExpiry;
  const workerPolicyConfigured = Boolean(config.workerToken && validCapacity
    && Number.isSafeInteger(config.workerMaxProviderCalls) && (config.workerMaxProviderCalls ?? 0) > 0
    && Number.isSafeInteger(config.workerMaxInputTokens) && (config.workerMaxInputTokens ?? 0) > 0
    && Number.isSafeInteger(config.workerMaxOutputTokens) && (config.workerMaxOutputTokens ?? 0) > 0
    && Number.isSafeInteger(config.workerMaxWallSeconds) && (config.workerMaxWallSeconds ?? 0) > 0
    && config.workerAllowedProviders?.length && config.workerAllowedModels?.length);
  const expectedCheckDigest = config.trustedCheckPolicy?.length ? createHash("sha256").update(canonicalJson(config.trustedCheckPolicy)).digest("hex") : null;
  const verificationConfigured = Boolean(authorities.verification && config.trustedCheckPolicy?.length
    && digest64(config.trustedCheckPolicyDigest) && expectedCheckDigest === config.trustedCheckPolicyDigest && config.trustedVerifierId
    && digest64(config.trustedVerifierImageDigest) && config.trustedVerificationPolicyVersion);
  const integrationConfigured = config.integrationEnabled === true && authorities.integration;
  const deliveryConfigured = config.deliveryEnabled === true && authorities.delivery;
  const planValid = validPlan(mission, plan, slices);
  const planDigest = planValid ? createHash("sha256").update(canonicalJson(plan!.slices)).digest("hex") : null;
  const checksBound = planValid && plan!.slices.every(slice => slice.checks.length > 0 && slice.checks.every(check => config.trustedCheckPolicy?.includes(check)));
  const missionPermitsWork = Boolean(mission && !["cancelling", "cancelled", "unknown", "failed"].includes(mission.status));
  if (!mission || !plan || !slices) reasons.push("Durable mission or plan data is unavailable.");
  else if (!planValid) reasons.push("The durable approved plan does not match the current mission slices.");
  if (!/^[a-f0-9]{40}$/i.test(mission?.baseSha ?? "")) reasons.push("The mission base revision is not a valid immutable SHA.");
  if (!config.workerToken || !workerPolicyConfigured) reasons.push("Worker policy or capacity evidence is missing, incomplete, or expired; worker credentials and startup remain unverified.");
  if (!verificationConfigured) reasons.push("Trusted verification policy, pinned verifier identity, or verification authority is incomplete.");
  if (planValid && !checksBound) reasons.push("The approved plan checks are not fully bound to the configured trusted check policy.");
  if (config.integrationEnabled && !integrationConfigured) reasons.push("Integration is enabled but its configured authority is unavailable.");
  if (config.deliveryEnabled && !deliveryConfigured) reasons.push("Delivery is enabled but its configured authority is unavailable.");
  if (mission && !missionPermitsWork) reasons.push("The durable mission state does not permit new execution.");
  const configuredPrerequisites = Boolean(mission && planValid && /^[a-f0-9]{40}$/i.test(mission.baseSha) && workerPolicyConfigured && verificationConfigured && checksBound
    && (!config.integrationEnabled || integrationConfigured) && (!config.deliveryEnabled || deliveryConfigured));
  return {
    state: !mission || !plan || !slices ? "unavailable" : configuredPrerequisites && missionPermitsWork ? "ready" : "unverified",
    meaning: "Control-plane prerequisites only; no live worker, runtime, provider, or image attestation.",
    liveExecution: "unverified",
    reasons,
    configuration: {
      mode: config.mode, workerPolicyConfigured, verificationConfigured, integrationConfigured, deliveryConfigured,
      capacityEvidenceDigest: digest64(config.capacityEvidenceDigest) ? config.capacityEvidenceDigest! : null,
      capacityEvidenceExpiresAt: validExpiry ? new Date(Date.parse(expiry!)).toISOString() : null,
      baseSha: mission && /^[a-f0-9]{40}$/i.test(mission.baseSha) ? mission.baseSha : null,
      planDigest, checkPolicyDigest: digest64(config.trustedCheckPolicyDigest) ? config.trustedCheckPolicyDigest! : null
    }
  };
}

/** Projects cancellation from current-epoch durable settlement rows plus the durable mission/slice state. */
export function evaluateOwnerCancellation(mission: Mission | null, slices: MissionSlice[] | null, events: MissionEvent[] | null): OwnerCancellation {
  if (!mission || !Array.isArray(slices) || !Array.isArray(events)) return { state: "quarantined-unknown", slices: [], reasons: ["Durable cancellation history is unavailable."] };
  const requested = events.some(event => event.missionId === mission.id && event.type === "mission.cancellation_requested");
  if (!requested && mission.status !== "cancelling" && mission.status !== "cancelled") return { state: "none", slices: slices.map(slice => ({ sliceId: slice.id, leaseEpoch: slice.leaseEpoch, state: "none", reasons: [] })), reasons: [] };
  const current = events.filter(event => event.missionId === mission.id);
  const rows = slices.map(slice => {
    const matches = current.filter(event => {
      const data = asRecord(event.data);
      return data.sliceId === slice.id && Number.isSafeInteger(data.leaseEpoch) && data.leaseEpoch === slice.leaseEpoch;
    });
    const pre = matches.filter(event => event.type === "slice.cancellation_settled_before_runtime");
    const runtime = matches.filter(event => event.type === "slice.cancellation_settled");
    const staleOrMalformed = current.some(event => {
      if (event.type !== "slice.cancellation_settled" && event.type !== "slice.cancellation_settled_before_runtime") return false;
      const data = asRecord(event.data);
      return data.sliceId === slice.id && data.leaseEpoch !== slice.leaseEpoch;
    });
    const reasons: string[] = [];
    let state: OwnerCancellationState = "requested";
    if (slice.status === "verified") state = "none";
    else if (pre.length + runtime.length > 1 || (pre.length && runtime.length) || (slice.status !== "cancelled" && (pre.length || runtime.length))) {
      state = "quarantined-unknown"; reasons.push("Current slice state contradicts or duplicates its durable cancellation settlement proof.");
    } else if (staleOrMalformed) {
      state = "quarantined-unknown"; reasons.push("Cancellation settlement evidence does not match the current lease epoch.");
    } else if (pre.length === 1 && slice.status === "cancelled") state = "pre-runtime-settled";
    else if (runtime.length === 1 && slice.status === "cancelled") state = "runtime-absence-settled";
    else if (slice.status === "cancelled" && slice.leaseEpoch === 0) state = "pre-runtime-settled";
    else if (slice.status === "unknown") {
      state = "quarantined-unknown"; reasons.push("Cancellation remains unresolved or the slice is in durable UNKNOWN state.");
    } else if (slice.status === "cancel_requested") state = "requested";
    else if (slice.status === "cancelled") { state = "quarantined-unknown"; reasons.push("A leased slice is cancelled without exact current-epoch settlement evidence."); }
    return { sliceId: slice.id, leaseEpoch: slice.leaseEpoch, state, reasons };
  });
  const states = new Set(rows.map(row => row.state));
  const state: OwnerCancellationState = states.has("quarantined-unknown") ? "quarantined-unknown"
    : states.has("requested") ? "requested"
    : states.has("runtime-absence-settled") ? "runtime-absence-settled"
    : states.has("pre-runtime-settled") ? "pre-runtime-settled" : "none";
  const reasons = [...new Set(rows.flatMap(row => row.reasons))];
  return { state, slices: rows, reasons };
}
