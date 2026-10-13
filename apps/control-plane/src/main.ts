import { loadConfig } from "../../../packages/config/src/config.js";
import { MemoryJobStore } from "../../../packages/contracts/src/memory-store.js";
import { PostgresJobStore } from "../../../packages/contracts/src/postgres-store.js";
import { createControlPlane } from "./server.js";

const config = loadConfig(process.env);
let jobs;
try { jobs = config.mode === "cloud" ? await PostgresJobStore.connect(config.databaseUrl!) : new MemoryJobStore(); }
catch { process.stderr.write("Orloom cloud startup failed: database initialization or readiness check failed.\n"); process.exit(1); }
const server = createControlPlane(config, jobs);
const host = config.mode === "cloud" ? (process.env.ORLOOM_BIND ?? "0.0.0.0") : "127.0.0.1";
server.listen(config.port, host, () => process.stdout.write(`Orloom ${config.mode} control plane listening on ${host}:${config.port}\n`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => server.close(async () => { if (jobs instanceof PostgresJobStore) await jobs.close(); process.exit(0); }));
