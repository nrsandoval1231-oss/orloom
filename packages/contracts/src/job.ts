export const jobStatuses = ["queued", "leased", "running", "succeeded", "failed", "unknown"] as const;
export type JobStatus = typeof jobStatuses[number];

export interface Job {
  id: string;
  repository: string;
  task: string;
  status: JobStatus;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobStore {
  submit(input: { repository: string; task: string }): Promise<Job>;
  get(id: string): Promise<Job | null>;
  lease(id: string, leaseToken: string, expiresAt: Date): Promise<Job>;
  start(id: string, leaseToken: string): Promise<Job>;
  complete(id: string, leaseToken: string, result: string): Promise<Job>;
  expireLeases(now: Date): Promise<number>;
}

export class StateConflictError extends Error {
  constructor(message: string) { super(message); this.name = "StateConflictError"; }
}

export class InputValidationError extends Error {
  constructor(message: string) { super(message); this.name = "InputValidationError"; }
}
