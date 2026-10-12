import { randomUUID } from "node:crypto";
import { InputValidationError, Job, JobStore, StateConflictError } from "./job.js";

export interface SqlResult { rows: Record<string, unknown>[]; rowCount?: number | null; }
export interface SqlExecutor { query(text: string, params?: unknown[]): Promise<SqlResult>; }

const columns = `id, repository, task, status, lease_token, lease_expires_at, result, created_at, updated_at`;
function map(row: Record<string, unknown>): Job {
  return {
    id: String(row.id), repository: String(row.repository), task: String(row.task), status: row.status as Job["status"],
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(String(row.lease_expires_at)).toISOString(),
    result: row.result === null ? null : String(row.result), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export class SqlJobStore implements JobStore {
  constructor(private readonly db: SqlExecutor) {}
  async submit(input: { repository: string; task: string }) {
    if (!input.repository.trim() || input.repository.length > 256 || !input.task.trim() || input.task.length > 20000) throw new InputValidationError("repository and task are required and must fit the documented limits");
    const result = await this.db.query(`INSERT INTO jobs (id, repository, task, status) VALUES ($1,$2,$3,'queued') RETURNING ${columns}`, [randomUUID(), input.repository, input.task]);
    return map(result.rows[0]!);
  }
  async get(id: string) { const result = await this.db.query(`SELECT ${columns} FROM jobs WHERE id=$1`, [id]); return result.rows[0] ? map(result.rows[0]) : null; }
  async lease(id: string, leaseToken: string, expiresAt: Date) {
    if (expiresAt <= new Date()) throw new StateConflictError("Lease expiry must be in the future");
    const result = await this.db.query(`UPDATE jobs SET status='leased', lease_token=$2, lease_expires_at=$3, updated_at=now() WHERE id=$1 AND status='queued' RETURNING ${columns}`, [id, leaseToken, expiresAt.toISOString()]);
    if (!result.rows[0]) throw new StateConflictError("Job cannot be leased"); return map(result.rows[0]);
  }
  async start(id: string, leaseToken: string) {
    const result = await this.db.query(`UPDATE jobs SET status='running', updated_at=now() WHERE id=$1 AND status='leased' AND lease_token=$2 AND lease_expires_at>now() RETURNING ${columns}`, [id, leaseToken]);
    if (!result.rows[0]) throw new StateConflictError("Lease is stale, expired, or job is not leased"); return map(result.rows[0]);
  }
  async complete(id: string, leaseToken: string, value: string) {
    const result = await this.db.query(`UPDATE jobs SET status='succeeded', result=$3, lease_token=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>now() RETURNING ${columns}`, [id, leaseToken, value]);
    if (!result.rows[0]) throw new StateConflictError("Lease is stale, expired, or job is not running"); return map(result.rows[0]);
  }
  async expireLeases(now: Date) {
    const result = await this.db.query(`UPDATE jobs SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'queued' END, lease_token=NULL, lease_expires_at=NULL, updated_at=$1 WHERE status IN ('leased','running') AND lease_expires_at <= $1`, [now.toISOString()]);
    return result.rowCount ?? result.rows.length;
  }
}
