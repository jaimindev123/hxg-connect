// Applies db/migrations/*.sql in order (once each), then seeds plans and the
// first Super Admin. Runs with the OWNER connection, never the runtime roles.
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OWNER_URL = process.env.DATABASE_OWNER_URL
  ?? 'postgres://postgres:postgres@localhost:5432/hxg_connect';

const client = new pg.Client({ connectionString: OWNER_URL });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const dir = join(here, '..', 'db', 'migrations');
for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
  const done = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
  if (done.rowCount) continue;
  const sql = await readFile(join(dir, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied  ${file}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED   ${file}: ${e.message}`);
    process.exit(1);
  }
}

// ---- Production guard rails. Refuse to start with anything from the repo.
const isProd = process.env.NODE_ENV === 'production';
const fail = msg => { console.error(`REFUSING TO START: ${msg}`); process.exit(1); };

// Runtime role passwords come from the connection URLs in .env, never from
// migration 001 (which is public in the repository).
for (const [role, key, devPassword] of [['hxg_app', 'DATABASE_APP_URL', 'hxg_app_dev'], ['hxg_platform', 'DATABASE_PLATFORM_URL', 'hxg_platform_dev']]) {
  const url = process.env[key];
  if (!url) { if (isProd) fail(`${key} must be set`); continue; }
  const pw = decodeURIComponent(new URL(url).password);
  if (isProd && (pw === devPassword || pw.length < 16)) fail(`${key} needs a strong password (16+ characters), not the development default`);
  const sql = (await client.query(`SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS q`, [role, pw])).rows[0].q;
  await client.query(sql);
}

// ---- Plans: starting tiers, created once. After that they belong to the
// console (Plans > Edit): a restart must never undo a price you changed.
const plans = [
  ['starter',    'Starter',     499, { users: 5,   leads: 50000 },
    { telephony: false, whatsapp: false, field_tracking: false, cp_portal: false }],
  ['growth',     'Growth',      999, { users: 25,  leads: 500000 },
    { telephony: true,  whatsapp: true,  field_tracking: true,  cp_portal: false }],
  ['pro',        'Pro',        1499, { users: 100, leads: 2000000 },
    { telephony: true,  whatsapp: true,  field_tracking: true,  cp_portal: true }],
  ['enterprise', 'Enterprise',    0, { users: 100000, leads: 100000000 },
    { telephony: true,  whatsapp: true,  field_tracking: true,  cp_portal: true }],
];
for (const [code, name, price, limits, features] of plans) {
  await client.query(
    `INSERT INTO platform.plans (code, name, price_per_user, limits, features, is_public)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO NOTHING`,
    [code, name, price, limits, features, code !== 'enterprise']);
}

// ---- First Super Admin (only if none exists).
const email = process.env.SUPER_ADMIN_EMAIL ?? 'founder@hxgconnect.com';
const password = process.env.SUPER_ADMIN_PASSWORD ?? 'change-me-now-please';
const exists = await client.query(
  `SELECT 1 FROM platform.users WHERE role = 'super_admin' LIMIT 1`);
if (!exists.rowCount) {
  if (isProd && (password === 'change-me-now-please' || password.length < 12)) fail('set SUPER_ADMIN_PASSWORD (12+ characters) for the first production start');
  await client.query(
    `INSERT INTO platform.users (email, name, password_hash, role)
     VALUES ($1, $3, $2, 'super_admin')`,
    [email, await bcrypt.hash(password, 12), (process.env.SUPER_ADMIN_NAME ?? '').trim() || 'Super Admin']);
  console.log(`seeded   super admin ${email}`);
}

await client.end();
console.log('database ready');
