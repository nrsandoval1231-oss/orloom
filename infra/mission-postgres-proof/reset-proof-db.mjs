import { readFile } from 'node:fs/promises';
import pg from './node_modules/pg/lib/index.js';

const { Client } = pg;
const host = process.env.ORLOOM_PG_HOST;
if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host || '')) throw new Error('invalid host');
const password = (await readFile('/run/secrets/pg-password-test', 'utf8')).trim();
const client = new Client({ host, port: 5432, user: 'mission_proof', password, database: 'mission_proof', connectionTimeoutMillis: 3000 });
try {
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO mission_proof');
  console.log('disposable_db_schema_reset=ok');
} finally {
  await client.end().catch(() => {});
}
