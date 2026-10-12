import { randomUUID } from "node:crypto";
import { InputValidationError, Job, JobStore, StateConflictError } from "./job.js";

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  async submit(input: { repository: string; task: string }): Promise<Job> {
    if (!input.repository.trim() || input.repository.length > 256 || !input.task.trim() || input.task.length > 20000)
      throw new InputValidationError("repository and task are required and must fit the documented limits");
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), ...input, status: "queued", leaseToken: null, leaseExpiresAt: null, result: null, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    return { ...job };
  }
  async get(id: string) { const job = this.jobs.get(id); return job ? { ...job } : null; }
  async lease(id: string, leaseToken: string, expiresAt: Date) {
    const job = this.must(id);
    if (job.status !== "queued" || expiresAt <= new Date()) throw new StateConflictError("Job cannot be leased");
    return this.set(job, { status: "leased", leaseToken, leaseExpiresAt: expiresAt.toISOString() });
  }
  async start(id: string, leaseToken: string) {
    const job = this.mustLease(id, leaseToken);
    if (job.status !== "leased") throw new StateConflictError("Job is not leased");
    return this.set(job, { status: "running" });
  }
  async complete(id: string, leaseToken: string, result: string) {
    const job = this.mustLease(id, leaseToken);
    if (job.status !== "running") throw new StateConflictError("Job is not running");
    return this.set(job, { status: "succeeded", leaseToken: null, leaseExpiresAt: null, result });
  }
  async expireLeases(now: Date) {
    let expired = 0;
    for (const job of this.jobs.values()) if (["leased", "running"].includes(job.status) && job.leaseExpiresAt && new Date(job.leaseExpiresAt) <= now) {
      this.set(job, job.status === "running" ? { status: "unknown", leaseToken: null, leaseExpiresAt: null } : { status: "queued", leaseToken: null, leaseExpiresAt: null });
      expired++;
    }
    return expired;
  }
  private must(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("Job not found"); return job; }
  private mustLease(id: string, token: string) {
    const job = this.must(id);
    if (job.leaseToken !== token || !job.leaseExpiresAt || new Date(job.leaseExpiresAt) <= new Date()) throw new StateConflictError("Lease is stale or expired");
    return job;
  }
  private set(job: Job, update: Partial<Job>): Job {
    const next = { ...job, ...update, updatedAt: new Date().toISOString() };
    this.jobs.set(job.id, next);
    return { ...next };
  }
}
