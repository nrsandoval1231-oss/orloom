import pg from "pg";
import { readFile } from "node:fs/promises";
let password="";
const poolHolder={pool:null};
let phase="secret-read";
try {
  password=(await readFile("/run/secrets/pg-password-test","utf8")).trim();
  phase="postgres-connect";
  const host=process.env.ORLOOM_PG_HOST;
  if(host!=="172.19.0.2") throw new Error("unexpected disposable endpoint");
  const pool=new pg.Pool({connectionString:`postgresql://mission_app:${password}@${host}:5432/mission_proof`,max:2,connectionTimeoutMillis:3000});
  poolHolder.pool=pool;
  const result=await pool.query("SELECT current_user,current_database(),pg_backend_pid() AS pid");
  process.stdout.write(`diagnostic_connect=PASS role=${result.rows[0].current_user} database=${result.rows[0].current_database} backend_pid=${result.rows[0].pid}
`);
} catch(error) {
  const code=typeof error?.code==="string"&&/^[A-Za-z0-9_]+$/.test(error.code)?error.code.toUpperCase():"unavailable";
  const kind=error instanceof Error?error.name:"unknown";
  process.stdout.write(`diagnostic_connect=FAIL phase=${phase} kind=${/^[A-Za-z]+$/.test(kind)?kind:"unknown"} code=${code}
`);
  process.exitCode=1;
} finally {
  password="";
  if(poolHolder.pool) await poolHolder.pool.end().catch(()=>undefined);
}
