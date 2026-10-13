import { loadConfig } from "../../../packages/config/src/config.js";
import { MemoryJobStore } from "../../../packages/contracts/src/memory-store.js";
import { PostgresJobStore } from "../../../packages/contracts/src/postgres-store.js";
import { createControlPlane } from "./server.js";
import { MemoryMissionStore } from "../../../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore } from "../../../packages/contracts/src/sql-mission-store.js";
import { startLeaseReconciler } from "../../../packages/governor/src/lease-reconciler.js";

const config = loadConfig(process.env);
let jobs;
let missions;
try { jobs = config.mode === "cloud" ? await PostgresJobStore.connect(config.databaseUrl!) : new MemoryJobStore(); }
catch { process.stderr.write("Orloom cloud startup failed: database initialization or readiness check failed.\n"); process.exit(1); }
try {
  missions = config.mode === "cloud" ? new SqlMissionStore(jobs as PostgresJobStore) : new MemoryMissionStore();
  await missions.configureCapacity(config.capacitySlots ?? 0, config.capacityEvidenceDigest ?? null, config.capacityEvidenceExpiresAt ?? null);
} catch { process.stderr.write("Orloom capacity configuration failed closed.\n"); process.exit(1); }
let stopLeaseReconciler: () => Promise<void>;
try {
  stopLeaseReconciler = await startLeaseReconciler(missions, { onError: () => process.stderr.write("Orloom lease reconciliation failed; claims will remain fail-closed.\n") });
} catch { process.stderr.write("Orloom lease reconciliation startup failed closed.\n"); process.exit(1); }
const server = createControlPlane(config, jobs, missions);
const host = config.mode === "cloud" ? (process.env.ORLOOM_BIND ?? "0.0.0.0") : "127.0.0.1";
server.listen(config.port, host, () => process.stdout.write(`Orloom ${config.mode} control plane listening on ${host}:${config.port}\n`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void stopLeaseReconciler().finally(() => server.close(async () => { if (jobs instanceof PostgresJobStore) await jobs.close(); process.exit(0); })); });
