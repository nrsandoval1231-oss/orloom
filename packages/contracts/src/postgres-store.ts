import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { SqlExecutor, SqlJobStore } from "../../../packages/contracts/src/sql-store.js";

const { Pool } = pg;
export class PostgresJobStore extends SqlJobStore {
  private constructor(private readonly pool: InstanceType<typeof Pool>) { super(pool as unknown as SqlExecutor); }
  static async connect(databaseUrl: string) {
    const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    pool.on("error", () => { /* Never log driver messages or connection details. */ });
    const store = new PostgresJobStore(pool);
    try { await store.migrateAndReady(); return store; }
    catch { await pool.end(); throw new Error("PostgreSQL initialization or readiness failed"); }
  }
  async close() { await this.pool.end(); }

  async ready() {
    try { await this.pool.query("SELECT 1"); return true; }
    catch { return false; }
  }
  async query(text: string, params?: unknown[]) { return await this.pool.query(text, params) as unknown as { rows: Record<string, unknown>[]; rowCount: number | null }; }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work({ query: async (text, params) => await client.query(text, params) as unknown as { rows: Record<string, unknown>[]; rowCount: number | null } });
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async migrateAndReady() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TABLE IF NOT EXISTS orloom_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const migration = await readFile(resolve(process.cwd(), "db/migrations/001_initial.sql"), "utf8");
      await client.query(migration);
      await client.query("INSERT INTO orloom_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", ["001_initial"]);
      const missionMigration = await readFile(resolve(process.cwd(), "db/migrations/002_missions.sql"), "utf8");
      await client.query(missionMigration);
      await client.query("INSERT INTO orloom_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", ["002_missions"]);
      const recoveryMigration = await readFile(resolve(process.cwd(), "db/migrations/003_recovery.sql"), "utf8");
      await client.query(recoveryMigration);
      await client.query("INSERT INTO orloom_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", ["003_recovery"]);
      await client.query("SELECT 1");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
