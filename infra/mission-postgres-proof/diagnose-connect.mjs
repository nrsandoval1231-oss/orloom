import { readFile } from 'node:fs/promises';
import pg from './node_modules/pg/lib/index.js';
const { Client } = pg;

const host = process.env.ORLOOM_PG_HOST || 'orloom-pg-proof-20261013-db';
const password = (await readFile('/run/secrets/pg-password-test', 'utf8')).trim();
const client = new Client({ host, port: 5432, user: 'mission_proof', password, database: 'mission_proof', connectionTimeoutMillis: 3000 });
try {
  await client.connect();
  const result = await client.query('SELECT 1 AS ready');
  console.log(`postgres_connect=ok query=${result.rows[0].ready}`);
} catch (error) {
  console.log(`postgres_connect=failed code=${error?.code || 'none'} name=${error?.name || 'unknown'}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
