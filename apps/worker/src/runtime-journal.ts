import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { link, lstat, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const journalVersion = "orloom.runtime-journal.v2" as const;
const maxJournalBytes = 64 * 1024;
const maxJournalFiles = 10_000;
const recordNamePattern = /^[a-f0-9]{64}\.json$/;
const digestPattern = /^[a-f0-9]{64}$/;
const imageRefPattern = /^(?:ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:|sha256:)[a-f0-9]{64}$/;
const dockerNamePattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const lockName = ".runtime-journal.lock";

export const RUNTIME_RECONCILER_SOURCE = "orloom.trusted-docker-reconciler.v1" as const;

export interface RuntimeIdentity {
  readonly missionId: string;
  readonly sliceId: string;
  readonly leaseEpoch: number;
  readonly controllerRunId: string;
}

export interface RuntimeReconciliationObservation {
  readonly source: typeof RUNTIME_RECONCILER_SOURCE;
  readonly outcome: "absent" | "unknown";
  readonly identity: RuntimeIdentity;
  readonly name: string;
  readonly imageRef: string;
  readonly labelsDigest: string;
  readonly containerId: string | null;
  readonly observedAt: string;
}

export type RuntimeJournalTransition =
  | { readonly state: "intent"; readonly at: string }
  | { readonly state: "created"; readonly at: string; readonly containerId: string }
  | { readonly state: "unknown" | "absent"; readonly at: string; readonly observation: RuntimeReconciliationObservation };

export interface RuntimeJournalEntry {
  readonly version: typeof journalVersion;
  readonly identity: RuntimeIdentity;
  readonly name: string;
  readonly imageRef: string;
  readonly labelsDigest: string;
  readonly containerId: string | null;
  readonly state: "intent" | "created" | "absent" | "unknown";
  readonly updatedAt: string;
  readonly reconciliation: RuntimeReconciliationObservation | null;
  readonly history: readonly RuntimeJournalTransition[];
}

export interface RuntimeJournal {
  recordIntent(entry: Omit<RuntimeJournalEntry, "version" | "containerId" | "state" | "updatedAt" | "reconciliation" | "history">): Promise<void>;
  recordCreated(identity: RuntimeIdentity, containerId: string, labelsDigest: string): Promise<void>;
  recordUnknown(observation: RuntimeReconciliationObservation): Promise<void>;
  recordAbsent(observation: RuntimeReconciliationObservation): Promise<void>;
  unresolved(): Promise<RuntimeJournalEntry[]>;
}

export class RuntimeJournalQuarantinedError extends Error {
  constructor(message = "Runtime journal is quarantined") { super(message); this.name = "RuntimeJournalQuarantinedError"; }
}

class RuntimeJournalRejectedError extends Error {}

/** Durable binding over the exact ownership labels. Sorting is byte-wise on
 * purpose: a persisted digest must not depend on host locale or ICU data. */
export function ownershipLabelsDigest(labels: Record<string, string>): string {
  const rows = Object.entries(labels).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function quarantine(reason: string): never {
  throw new RuntimeJournalQuarantinedError(`Runtime journal is quarantined: ${reason}`);
}

function rejected(message: string): never { throw new RuntimeJournalRejectedError(message); }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function validIdentity(value: unknown): value is RuntimeIdentity {
  if (!object(value) || !exactKeys(value, ["controllerRunId", "leaseEpoch", "missionId", "sliceId"])) return false;
  const bounded = (part: unknown) => typeof part === "string" && part.length >= 1 && part.length <= 256 && !/[\u0000-\u001f\u007f]/.test(part);
  return bounded(value.missionId) && bounded(value.sliceId) && Number.isSafeInteger(value.leaseEpoch) && (value.leaseEpoch as number) >= 1 && bounded(value.controllerRunId);
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.missionId === right.missionId && left.sliceId === right.sliceId && left.leaseEpoch === right.leaseEpoch && left.controllerRunId === right.controllerRunId;
}

function identityDigest(identity: RuntimeIdentity): string {
  if (!validIdentity(identity)) return rejected("Runtime journal identity is invalid");
  return createHash("sha256").update(JSON.stringify([identity.missionId, identity.sliceId, identity.leaseEpoch, identity.controllerRunId])).digest("hex");
}

function validObservation(value: unknown): value is RuntimeReconciliationObservation {
  if (!object(value) || !exactKeys(value, ["containerId", "identity", "imageRef", "labelsDigest", "name", "observedAt", "outcome", "source"])) return false;
  return value.source === RUNTIME_RECONCILER_SOURCE
    && (value.outcome === "absent" || value.outcome === "unknown")
    && validIdentity(value.identity)
    && typeof value.name === "string" && dockerNamePattern.test(value.name)
    && typeof value.imageRef === "string" && imageRefPattern.test(value.imageRef)
    && typeof value.labelsDigest === "string" && digestPattern.test(value.labelsDigest)
    && (value.containerId === null || (typeof value.containerId === "string" && digestPattern.test(value.containerId)))
    && validTimestamp(value.observedAt);
}

function validTransition(value: unknown): value is RuntimeJournalTransition {
  if (!object(value) || typeof value.state !== "string" || !validTimestamp(value.at)) return false;
  if (value.state === "intent") return exactKeys(value, ["at", "state"]);
  if (value.state === "created") return exactKeys(value, ["at", "containerId", "state"]) && typeof value.containerId === "string" && digestPattern.test(value.containerId);
  if (value.state === "unknown" || value.state === "absent") return exactKeys(value, ["at", "observation", "state"]) && validObservation(value.observation) && value.observation.outcome === value.state;
  return false;
}

function observationMatchesStatic(entry: Pick<RuntimeJournalEntry, "identity" | "name" | "imageRef" | "labelsDigest" | "containerId">, observation: RuntimeReconciliationObservation): boolean {
  return sameIdentity(entry.identity, observation.identity) && entry.name === observation.name && entry.imageRef === observation.imageRef && entry.labelsDigest === observation.labelsDigest && entry.containerId === observation.containerId;
}

function assertObservationBinding(entry: RuntimeJournalEntry, observation: RuntimeReconciliationObservation, requireOutcome: "absent" | "unknown" | false): void {
  if (!validObservation(observation) || (requireOutcome && observation.outcome !== requireOutcome) || !observationMatchesStatic(entry, observation)) rejected("Runtime reconciliation observation does not match the durable runtime binding");
}

function parseEntry(bytes: Buffer, fileName: string): RuntimeJournalEntry {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { quarantine("record JSON is malformed"); }
  if (!object(value) || !exactKeys(value, ["containerId", "history", "identity", "imageRef", "labelsDigest", "name", "reconciliation", "state", "updatedAt", "version"])) quarantine("record schema is malformed");
  if (value.version !== journalVersion || !validIdentity(value.identity) || typeof value.name !== "string" || !dockerNamePattern.test(value.name) || typeof value.imageRef !== "string" || !imageRefPattern.test(value.imageRef) || typeof value.labelsDigest !== "string" || !digestPattern.test(value.labelsDigest) || (value.containerId !== null && (typeof value.containerId !== "string" || !digestPattern.test(value.containerId))) || !validTimestamp(value.updatedAt) || !Array.isArray(value.history) || value.history.length < 1 || value.history.length > 3 || value.history.some(row => !validTransition(row))) quarantine("record fields are invalid");
  if (`${identityDigest(value.identity)}.json` !== fileName) quarantine("record filename is not bound to its identity");
  const history = value.history as RuntimeJournalTransition[];
  if (history[0]?.state !== "intent" || history.at(-1)?.state !== value.state || history.at(-1)?.at !== value.updatedAt) quarantine("record transition history is inconsistent");
  const states = history.map(row => row.state).join(">");
  if (!["intent", "intent>created", "intent>unknown", "intent>absent", "intent>created>unknown", "intent>created>absent", "intent>unknown>absent"].includes(states)) quarantine("record transition is illegal");
  if (value.state === "intent" && (value.containerId !== null || value.reconciliation !== null)) quarantine("intent binding is inconsistent");
  if (value.state === "created" && (typeof value.containerId !== "string" || value.reconciliation !== null)) quarantine("created binding is inconsistent");
  if ((value.state === "unknown" || value.state === "absent") && (!validObservation(value.reconciliation) || value.reconciliation.outcome !== value.state)) quarantine("reconciliation binding is inconsistent");
  const result = value as unknown as RuntimeJournalEntry;
  if ((result.state === "unknown" || result.state === "absent") && result.reconciliation) assertObservationBinding(result, result.reconciliation, false);
  for (const transition of history) {
    if (transition.state === "created" && transition.containerId !== result.containerId) quarantine("created container identity changed");
    if ((transition.state === "unknown" || transition.state === "absent") && !observationMatchesStatic(result, transition.observation)) quarantine("historical reconciliation binding changed");
  }
  return result;
}

function serialize(entry: RuntimeJournalEntry): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
  if (bytes.byteLength > maxJournalBytes) quarantine("record exceeds its byte limit");
  return bytes;
}

type ValidationMode = "operational-linux" | "portable-test";

/** Durable broker state. Missing, unexpected, unreadable, or malformed
 * evidence fails closed as quarantine. */
export class FileRuntimeJournal implements RuntimeJournal {
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly root: string, private readonly mode: ValidationMode) {}

  static async openOperational(root: string): Promise<FileRuntimeJournal> {
    if (process.platform !== "linux") quarantine("operational validation requires Linux");
    const journal = new FileRuntimeJournal(root, "operational-linux");
    await journal.unresolved();
    return journal;
  }

  /** Portable filesystem tests only; this is not Linux, Docker, or runsc acceptance. */
  static async openPortableTestRoot(root: string): Promise<FileRuntimeJournal> {
    let info: Awaited<ReturnType<typeof lstat>>, resolved: string;
    try { info = await lstat(root); resolved = await realpath(root); } catch { return quarantine("root is missing or unreadable"); }
    if (!info.isDirectory() || info.isSymbolicLink()) return quarantine("root is not a real directory");
    const journal = new FileRuntimeJournal(resolved, "portable-test");
    await journal.unresolved();
    return journal;
  }

  private file(identity: RuntimeIdentity): string { return path.join(this.root, `${identityDigest(identity)}.json`); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async validateRoot(): Promise<void> {
    if (!path.isAbsolute(this.root)) quarantine("root must be absolute");
    let info: Awaited<ReturnType<typeof lstat>>, resolved: string;
    try { info = await lstat(this.root); resolved = await realpath(this.root); } catch { quarantine("root is missing or unreadable"); }
    if (!info.isDirectory() || info.isSymbolicLink()) quarantine("root is not a real directory");
    const expected = path.resolve(this.root), comparable = (value: string) => process.platform === "win32" ? path.normalize(value).replace(/^\\\\\?\\/, "").toLowerCase() : value;
    if (comparable(resolved) !== comparable(expected)) quarantine("root resolves through a link");
    if (this.mode === "operational-linux") {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) quarantine("root is not private and owner-controlled");
    }
  }

  private async syncDirectory(): Promise<void> {
    let handle: FileHandle | undefined;
    try { handle = await open(this.root, constants.O_RDONLY); await handle.sync(); }
    catch (error) {
      if (this.mode === "operational-linux") quarantine("directory durability sync failed");
      if (process.platform !== "win32") throw error;
    } finally { await handle?.close().catch(() => undefined); }
  }

  private async withRootLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.validateRoot();
      const lockPath = path.join(this.root, lockName);
      let lock: FileHandle;
      try { lock = await open(lockPath, "wx", 0o600); await lock.sync(); await this.syncDirectory(); }
      catch { quarantine("exclusive journal lock is unavailable"); }
      let releaseLock = false;
      try {
        await this.validateRoot();
        const result = await operation();
        releaseLock = true;
        return result;
      } catch (error) {
        if (error instanceof RuntimeJournalRejectedError) releaseLock = true;
        throw error;
      }
      finally {
        await lock.close().catch(() => undefined);
        if (releaseLock) try { await unlink(lockPath); await this.syncDirectory(); } catch { /* retained lock quarantines the next access */ }
      }
    });
  }

  private async readRecord(fileName: string): Promise<RuntimeJournalEntry> {
    const target = path.join(this.root, fileName);
    let before: Awaited<ReturnType<typeof lstat>>, handle: FileHandle | undefined;
    try {
      before = await lstat(target);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > maxJournalBytes) quarantine("record is not a bounded regular file");
      if (this.mode === "operational-linux") {
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (uid === undefined || before.uid !== uid || (before.mode & 0o077) !== 0) quarantine("record is not private and owner-controlled");
      }
      const flags = process.platform === "linux" ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
      handle = await open(target, flags);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) quarantine("record changed while being opened");
      const bytes = await handle.readFile();
      if (bytes.byteLength !== opened.size) quarantine("record changed while being read");
      return parseEntry(bytes, fileName);
    } catch (error) {
      if (error instanceof RuntimeJournalQuarantinedError) throw error;
      return quarantine("record is unreadable");
    } finally { await handle?.close().catch(() => undefined); }
  }

  private async readAllLocked(): Promise<Map<string, RuntimeJournalEntry>> {
    let entries: Dirent<string>[];
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { quarantine("root cannot be enumerated"); }
    if (entries.length > maxJournalFiles + 1) quarantine("root exceeds its file-count limit");
    const rows = new Map<string, RuntimeJournalEntry>();
    for (const entry of entries) {
      if (entry.name === lockName) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !recordNamePattern.test(entry.name)) quarantine("root contains unexpected or ambiguous evidence");
      rows.set(entry.name, await this.readRecord(entry.name));
    }
    return rows;
  }

  private async writeTemp(entry: RuntimeJournalEntry): Promise<string> {
    const temporary = path.join(this.root, `.runtime-journal.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(serialize(entry)); await handle.sync(); }
    finally { await handle.close(); }
    return temporary;
  }

  private async create(entry: RuntimeJournalEntry): Promise<void> {
    const temporary = await this.writeTemp(entry);
    await link(temporary, this.file(entry.identity));
    await this.syncDirectory();
    await unlink(temporary);
    await this.syncDirectory();
  }

  private async replace(entry: RuntimeJournalEntry): Promise<void> {
    const temporary = await this.writeTemp(entry);
    await rename(temporary, this.file(entry.identity));
    await this.syncDirectory();
  }

  async recordIntent(input: Omit<RuntimeJournalEntry, "version" | "containerId" | "state" | "updatedAt" | "reconciliation" | "history">): Promise<void> {
    return this.withRootLock(async () => {
      if (!validIdentity(input.identity) || !dockerNamePattern.test(input.name) || !imageRefPattern.test(input.imageRef) || !digestPattern.test(input.labelsDigest)) rejected("Runtime journal intent is invalid");
      const rows = await this.readAllLocked(), fileName = `${identityDigest(input.identity)}.json`;
      if (rows.has(fileName)) rejected("Runtime journal identity already exists and cannot be reused");
      const now = new Date().toISOString();
      await this.create({ ...input, version: journalVersion, containerId: null, state: "intent", updatedAt: now, reconciliation: null, history: [{ state: "intent", at: now }] });
    });
  }

  async recordCreated(identity: RuntimeIdentity, containerId: string, labelsDigest: string): Promise<void> {
    return this.withRootLock(async () => {
      if (!digestPattern.test(containerId) || !digestPattern.test(labelsDigest)) rejected("Runtime journal create binding is invalid");
      const prior = (await this.readAllLocked()).get(`${identityDigest(identity)}.json`);
      if (!prior || prior.state !== "intent" || prior.labelsDigest !== labelsDigest) rejected("Runtime journal create does not match a durable intent");
      const now = new Date().toISOString();
      await this.replace({ ...prior, containerId, state: "created", updatedAt: now, history: [...prior.history, { state: "created", at: now, containerId }] });
    });
  }

  async recordUnknown(observation: RuntimeReconciliationObservation): Promise<void> { return this.recordReconciliation(observation, "unknown"); }
  async recordAbsent(observation: RuntimeReconciliationObservation): Promise<void> { return this.recordReconciliation(observation, "absent"); }

  private async recordReconciliation(observation: RuntimeReconciliationObservation, outcome: "unknown" | "absent"): Promise<void> {
    return this.withRootLock(async () => {
      const rows = await this.readAllLocked();
      const prior = validIdentity(observation.identity) ? rows.get(`${identityDigest(observation.identity)}.json`) : undefined;
      if (!prior || prior.state === "absent" || (outcome === "unknown" && prior.state === "unknown")) rejected(`Runtime journal ${outcome} transition is illegal`);
      assertObservationBinding(prior, observation, outcome);
      if (Date.parse(observation.observedAt) < Date.parse(prior.updatedAt)) rejected("Runtime reconciliation observation is stale");
      const now = new Date().toISOString();
      await this.replace({ ...prior, state: outcome, updatedAt: now, reconciliation: observation, history: [...prior.history, { state: outcome, at: now, observation }] });
    });
  }

  async unresolved(): Promise<RuntimeJournalEntry[]> {
    return this.withRootLock(async () => [...(await this.readAllLocked()).values()].filter(row => row.state !== "absent").sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)));
  }
}
