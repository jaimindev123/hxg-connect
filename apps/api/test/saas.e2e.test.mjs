// End-to-end tests against a real Postgres. Each test tries to BREAK a
// boundary the SaaS model depends on. Re-runnable: every run uses fresh
// subdomains, so no DB reset is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pg from 'pg';

import http from 'node:http';
import { createHmac } from 'node:crypto';
const require = createRequire(import.meta.url);
let createApp;

const RUN = Math.random().toString(36).slice(2, 7);
const OWNER_URL = process.env.DATABASE_OWNER_URL ?? 'postgres://postgres:postgres@localhost:5432/hxg_connect';
const SUPER = { email: process.env.SUPER_ADMIN_EMAIL ?? 'founder@hxgconnect.com',
                password: process.env.SUPER_ADMIN_PASSWORD ?? 'change-me-now-please' };

let app, base, origin;
const S = {};   // shared state across the ordered tests

async function call(method, path, { token, tenant, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant'] = tenant;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const asDb = async (url, fn) => { const c = new pg.Client({ connectionString: url }); await c.connect();
  try { return await fn(c); } finally { await c.end(); } };

// Stand-in for Razorpay and Meta's Graph API, so key verification is
// exercised for real (auth headers, status mapping) without real accounts.
let mock, lastLink, lastTwilio, lastWa, waN = 0, twN = 0, mockBase;
const RZP_GOOD = 'Basic ' + Buffer.from('rzp_test_GoodKey123:good-secret').toString('base64');
function startMock() {
  mock = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const TW = 'Basic ' + Buffer.from('AC' + 'a'.repeat(32) + ':tw-token-123456').toString('base64');
    const readBody = fn => { let raw = ''; req.on('data', c => (raw += c)); req.on('end', () => fn(raw)); };
    if (req.method === 'POST' && /\/Calls\.json$/.test(req.url)) return readBody(raw => {
      lastTwilio = Object.fromEntries(new URLSearchParams(raw));
      req.headers.authorization === TW ? send(201, { sid: `CA${123 + twN++}` }) : send(401, { message: 'auth' }); });
    if (req.url === '/recordings/open.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('ID3-open')); }
    if (req.url === '/recordings/RE1.mp3') {
      if (req.headers.authorization !== TW) return send(401, {});
      res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('ID3-fake-audio'));
    }
    if (req.method === 'POST' && /^\/v20\.0\/\d+\/messages$/.test(req.url)) return readBody(raw => {
      lastWa = JSON.parse(raw); send(200, { messages: [{ id: `wamid.OUT${++waN}` }] }); });
    if (/^\/v20\.0\/\d+\/message_templates/.test(req.url)) return send(200, { data: [
      { name: 'site_visit_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, your visit to {{2}} is on {{3}}.' }] },
      { name: 'diwali_offer', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Festive prices at {{1}}' }] }] });
    if (req.url === '/v1/payment_links' && req.method === 'POST') {
      let raw = ''; req.on('data', c => (raw += c));
      return req.on('end', () => { lastLink = JSON.parse(raw);
        req.headers.authorization === RZP_GOOD ? send(200, { id: 'plink_T3st', short_url: 'https://rzp.io/i/T3st' }) : send(401, { error: { description: 'bad keys' } }); });
    }
    if (req.url.startsWith('/v1/payments')) return req.headers.authorization === RZP_GOOD ? send(200, { items: [] }) : send(401, { error: {} });
    const good = req.headers.authorization === 'Bearer EAAG-good';
    if (req.url.startsWith('/v20.0/') && req.url.endsWith('?fields=name')) return good ? send(200, { id: '1234567', name: 'Client A Realty' }) : send(400, { error: { code: 190 } });
    if (/^\/v20\.0\/9\d+$/.test(req.url)) return good ? send(200, { id: req.url.slice(7), field_data: [
      { name: 'full_name', values: ['Kavita Rao'] }, { name: 'phone_number', values: ['+919845012345'] },
      { name: 'email', values: ['kavita@example.com'] }, { name: 'city', values: ['Bengaluru'] }] }) : send(400, { error: { code: 190 } });
    if (req.url.startsWith('/v20.0/')) return req.headers.authorization === 'Bearer EAAG-good'
      ? send(200, { display_phone_number: '+91 98100 00000', verified_name: 'Client A Realty' })
      : send(400, { error: { code: 190, message: 'expired' } });
    send(404, {});
  });
  return new Promise(r => mock.listen(0, '127.0.0.1', r));
}

before(async () => {
  await startMock();
  const m = `http://127.0.0.1:${mock.address().port}`;
  process.env.RAZORPAY_API_BASE = m;
  process.env.WHATSAPP_GRAPH_BASE = m;
  process.env.TWILIO_API_BASE = m;
  process.env.INBOUND_EMAIL_DOMAIN = 'leads.hxgconnect.test';
  process.env.INBOUND_EMAIL_SECRET = 'inbound-secret-1';
  mockBase = m;
  ({ createApp } = require('../dist/main.js'));
  app = await createApp();
  await app.listen(0);
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  base = `${origin}/api`;
});
after(async () => { await app.close(); mock.close(); });

// ------------------------------------------------------------------
test('super admin logs in; a wrong password does not', async () => {
  const bad = await call('POST', '/platform/auth/login', { body: { ...SUPER, password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/platform/auth/login', { body: SUPER });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'super_admin');
  S.superToken = ok.body.token;
});

test('super admin hires a support agent; support cannot provision clients', async () => {
  const email = `support-${RUN}@hxgconnect.com`;
  const c = await call('POST', '/platform/users', { token: S.superToken,
    body: { email, name: 'Rahul Support', role: 'admin_support', password: 'support-pass-123' } });
  assert.equal(c.status, 201);
  S.supportToken = (await call('POST', '/platform/auth/login',
    { body: { email, password: 'support-pass-123' } })).body.token;

  const p = await call('POST', '/platform/tenants', { token: S.supportToken,
    body: { name: 'Nope', subdomain: `nope-${RUN}`, plan_code: 'starter', owner: { name: 'X', email: 'x@x.com' } } });
  assert.equal(p.status, 403);
});

test('provisioning creates two isolated client workspaces', async () => {
  for (const [key, plan] of [['A', 'growth'], ['B', 'starter']]) {
    const sub = `${key.toLowerCase()}${RUN}`;
    const r = await call('POST', '/platform/tenants', { token: S.superToken, body: {
      name: `Client ${key} Realty`, subdomain: sub, plan_code: plan,
      owner: { name: `Owner ${key}`, email: `owner@${sub}.com` } } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    S[key] = { id: r.body.tenant.id, sub, invite: r.body.owner_invite_token };
  }
});

test('subdomains: duplicates rejected (409), reserved names rejected (400)', async () => {
  const owner = { name: 'Yash Patel', email: 'y@y.com' };
  const dup = await call('POST', '/platform/tenants', { token: S.superToken,
    body: { name: 'Copy', subdomain: S.A.sub, plan_code: 'starter', owner } });
  assert.equal(dup.status, 409);
  const reserved = await call('POST', '/platform/tenants', { token: S.superToken,
    body: { name: 'Sneaky', subdomain: 'admin', plan_code: 'starter', owner } });
  assert.equal(reserved.status, 400);
});

test('owners accept invites and log in to their own workspace only', async () => {
  for (const key of ['A', 'B']) {
    const r = await call('POST', '/auth/accept-invite', { body: { token: S[key].invite, password: 'owner-password-1' } });
    assert.equal(r.status, 200);
    const reuse = await call('POST', '/auth/accept-invite', { body: { token: S[key].invite, password: 'owner-password-2' } });
    assert.equal(reuse.status, 400, 'invite links are single use');
    const login = await call('POST', '/auth/login', { tenant: S[key].sub,
      body: { email: `owner@${S[key].sub}.com`, password: 'owner-password-1' } });
    assert.equal(login.status, 200);
    S[key].token = login.body.token;
  }
  // A's owner trying to log in on B's subdomain: user doesn't exist there.
  const cross = await call('POST', '/auth/login', { tenant: S.B.sub,
    body: { email: `owner@${S.A.sub}.com`, password: 'owner-password-1' } });
  assert.equal(cross.status, 401);
});

test('ISOLATION: client B cannot see, fetch, or collide with client A\'s leads', async () => {
  const a = await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub, body: {
    name: 'Rohit Mehra', phone: '98765 43210', source: 'facebook', budget_min: 8000000, budget_max: 9500000 } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  S.A.leadId = a.body.id;

  const listB = await call('GET', '/leads', { token: S.B.token, tenant: S.B.sub });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.data.length, 0, 'B sees zero leads');

  const peek = await call('GET', `/leads/${S.A.leadId}`, { token: S.B.token, tenant: S.B.sub });
  assert.equal(peek.status, 404, 'A\'s lead does not exist from B\'s point of view');

  const move = await call('POST', `/leads/${S.A.leadId}/notes`, { token: S.B.token, tenant: S.B.sub,
    body: { body: 'tampering' } });
  assert.equal(move.status, 404, 'B cannot write to A\'s lead either');

  // Same phone in another company is a separate person-relationship, not a duplicate.
  const sameNumber = await call('POST', '/leads', { token: S.B.token, tenant: S.B.sub,
    body: { name: 'Rohit M', phone: '+91 98765-43210' } });
  assert.equal(sameNumber.status, 201);
  assert.equal(sameNumber.body.duplicate_of, null);
});

test('dedupe: same number in another format is appended, never dropped', async () => {
  const again = await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Rohit', phone: '+91-9876543210', source: '99acres' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate_of, S.A.leadId);
  const lead = await call('GET', `/leads/${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub });
  assert.ok(lead.body.timeline.some(t => t.type === 're_enquiry'), 're-enquiry is on the timeline');
});

test('REALMS: platform tokens are useless on the CRM; tenant tokens are bound to their subdomain', async () => {
  const p = await call('GET', '/leads', { token: S.superToken, tenant: S.A.sub });
  assert.equal(p.status, 401, 'super admin token does not work as a CRM token');
  const swap = await call('GET', '/leads', { token: S.A.token, tenant: S.B.sub });
  assert.equal(swap.status, 401, 'A\'s token rejected on B\'s subdomain');
  const t = await call('GET', '/platform/tenants', { token: S.A.token });
  assert.equal(t.status, 401, 'client owner cannot reach the platform API');
});

test('DATABASE: isolation holds even if application code is wrong', async () => {
  // The platform role has no grant on leads at all.
  await asDb('postgres://hxg_platform:hxg_platform_dev@localhost:5432/hxg_connect', async c => {
    await assert.rejects(c.query('SELECT * FROM leads'), /permission denied/);
  });
  await asDb('postgres://hxg_app:hxg_app_dev@localhost:5432/hxg_connect', async c => {
    // Forgot to set tenant context → zero rows, not all rows (fail closed).
    assert.equal((await c.query('SELECT * FROM leads')).rowCount, 0);
    // Context set to A → only A's rows, even with a query asking for B's.
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [S.A.id]);
    const r = await c.query('SELECT tenant_id FROM leads');
    assert.ok(r.rowCount > 0 && r.rows.every(x => x.tenant_id === S.A.id));
    assert.equal((await c.query('SELECT * FROM leads WHERE tenant_id = $1', [S.B.id])).rowCount, 0);
    // And it cannot write a row into B while scoped to A.
    await assert.rejects(c.query(
      `INSERT INTO activities (tenant_id, type, body) VALUES ($1, 'note', 'smuggled')`, [S.B.id]),
      /row-level security/);
    await c.query('ROLLBACK');
  });
});

test('PLANS: field tracking is gated by plan, and an override unlocks it', async () => {
  const a = await call('GET', '/field/team/live', { token: S.A.token, tenant: S.A.sub });
  assert.equal(a.status, 200, 'Growth plan includes field tracking');
  const b = await call('GET', '/field/team/live', { token: S.B.token, tenant: S.B.sub });
  assert.equal(b.status, 403);
  assert.equal(b.body.code, 'feature_not_in_plan');

  await call('PATCH', `/platform/tenants/${S.B.id}/overrides`, { token: S.superToken,
    body: { features: { field_tracking: true } } });
  const b2 = await call('GET', '/field/team/live', { token: S.B.token, tenant: S.B.sub });
  assert.equal(b2.status, 200, 'contract override takes effect on the next request');
});

test('PLANS: Starter seat limit (5) blocks the 6th user with 402', async () => {
  for (let i = 1; i <= 4; i++) {
    const r = await call('POST', '/users', { token: S.B.token, tenant: S.B.sub,
      body: { name: `Exec ${i}`, email: `exec${i}@${S.B.sub}.com`, role: 'sales_executive' } });
    assert.equal(r.status, 201, `seat ${i + 1}`);
  }
  const sixth = await call('POST', '/users', { token: S.B.token, tenant: S.B.sub,
    body: { name: 'One Too Many', email: `extra@${S.B.sub}.com`, role: 'telecaller' } });
  assert.equal(sixth.status, 402);
  assert.equal(sixth.body.code, 'seat_limit_reached');
});

test('ROLES: a sales executive sees only leads assigned to them', async () => {
  const inv = await call('POST', '/users', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Arjun Rao', email: `arjun@${S.A.sub}.com`, role: 'sales_executive' } });
  const acc = await call('POST', '/auth/accept-invite', { body: { token: inv.body.invite_token, password: 'arjun-password-1' } });
  S.A.execToken = acc.body.token;
  S.A.execId = acc.body.user.id;

  const mine = await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Anita Shah', phone: '9811122233', source: 'walk_in' } });
  assert.equal(mine.status, 201);

  const list = await call('GET', '/leads', { token: S.A.execToken, tenant: S.A.sub });
  assert.deepEqual(list.body.data.map(l => l.name), ['Anita Shah'], 'auto-assigned lead only');
  const ownersLead = await call('GET', `/leads/${S.A.leadId}`, { token: S.A.execToken, tenant: S.A.sub });
  assert.equal(ownersLead.status, 404);
  const invite = await call('POST', '/users', { token: S.A.execToken, tenant: S.A.sub,
    body: { name: 'X', email: `x@${S.A.sub}.com`, role: 'telecaller' } });
  assert.equal(invite.status, 403, 'executives cannot invite users');
});

test('PIPELINE: moving to Lost requires a reason', async () => {
  const lead = await call('GET', `/leads/${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub });
  const lost = await asDb(OWNER_URL, c => c.query(
    `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND is_lost`, [lead.body.pipeline_id]));
  const noReason = await call('POST', `/leads/${S.A.leadId}/stage`, { token: S.A.token, tenant: S.A.sub,
    body: { stage_id: lost.rows[0].id } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'lost_reason_required');
});

test('SUPPORT ACCESS: consent first, read-only, revocable instantly', async () => {
  const req = await call('POST', '/platform/impersonation', { token: S.supportToken,
    body: { tenant_id: S.A.id, reason: 'Client reports lead export shows wrong budgets' } });
  assert.equal(req.status, 201);
  const sid = req.body.id;

  const full = await call('POST', '/platform/impersonation', { token: S.supportToken,
    body: { tenant_id: S.A.id, reason: 'I would like write access please', mode: 'full' } });
  assert.equal(full.status, 403, 'only super admin may request write access');

  const early = await call('POST', `/platform/impersonation/${sid}/token`, { token: S.supportToken });
  assert.equal(early.status, 403, 'no token before the client says yes');

  const pending = await call('GET', '/support-access', { token: S.A.token, tenant: S.A.sub });
  assert.ok(pending.body.some(p => p.id === sid && p.status === 'pending'));
  const otherClient = await call('POST', `/support-access/${sid}/approve`, { token: S.B.token, tenant: S.B.sub });
  assert.equal(otherClient.status, 404, 'client B cannot approve access to client A');
  assert.equal((await call('POST', `/support-access/${sid}/approve`, { token: S.A.token, tenant: S.A.sub })).status, 200);

  const t = await call('POST', `/platform/impersonation/${sid}/token`, { token: S.supportToken });
  assert.equal(t.status, 200);
  const sup = t.body.token;

  const read = await call('GET', '/leads', { token: sup, tenant: S.A.sub });
  assert.equal(read.status, 200, 'support can read');
  const me = await call('GET', '/me', { token: sup, tenant: S.A.sub });
  assert.equal(me.body.support_session.mode, 'read_only', 'UI can show a support banner');
  const write = await call('POST', '/leads', { token: sup, tenant: S.A.sub, body: { name: 'X', phone: '9000000000' } });
  assert.equal(write.status, 403);
  assert.equal(write.body.code, 'read_only_session');
  const wrongClient = await call('GET', '/leads', { token: sup, tenant: S.B.sub });
  assert.equal(wrongClient.status, 401, 'support token only works for the approved client');

  assert.equal((await call('POST', `/support-access/${sid}/end`, { token: S.A.token, tenant: S.A.sub })).status, 200);
  const after = await call('GET', '/leads', { token: sup, tenant: S.A.sub });
  assert.equal(after.status, 401, 'ended session dies on the next request, not at expiry');
});

test('SUSPENSION: a suspended client is locked out immediately; data survives restore', async () => {
  const s = await call('POST', `/platform/tenants/${S.B.id}/suspend`, { token: S.superToken,
    body: { reason: 'Invoice 90 days overdue' } });
  assert.equal(s.status, 200);
  const me = await call('GET', '/me', { token: S.B.token, tenant: S.B.sub });
  assert.equal(me.status, 403);
  assert.equal(me.body.code, 'workspace_suspended');
  const login = await call('POST', '/auth/login', { tenant: S.B.sub,
    body: { email: `owner@${S.B.sub}.com`, password: 'owner-password-1' } });
  assert.equal(login.status, 200, 'the owner can still sign in, to pay');
  assert.equal((await call('GET', '/leads', { token: login.body.token, tenant: S.B.sub })).status, 403, 'but not use the CRM');

  await call('POST', `/platform/tenants/${S.B.id}/restore`, { token: S.superToken });
  const back = await call('GET', '/leads', { token: S.B.token, tenant: S.B.sub });
  assert.equal(back.status, 200);
  assert.equal(back.body.data.length, 1, 'nothing was lost while suspended');
});

test('TRIAL: an expired trial can read but not write (402)', async () => {
  await asDb(OWNER_URL, c => c.query(
    `UPDATE tenants SET status = 'trial', trial_ends_at = now() - interval '1 day' WHERE id = $1`, [S.A.id]));
  assert.equal((await call('GET', '/leads', { token: S.A.token, tenant: S.A.sub })).status, 200);
  const w = await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub, body: { name: 'Late', phone: '9111111111' } });
  assert.equal(w.status, 402);
  assert.equal(w.body.code, 'trial_expired');
  const ext = await call('POST', `/platform/tenants/${S.A.id}/extend-trial`, { token: S.superToken, body: { days: 7 } });
  assert.equal(ext.status, 200);
  const w2 = await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub, body: { name: 'Late', phone: '9111111111' } });
  assert.equal(w2.status, 201, 'extension unlocks writes immediately');
});


test('FOLLOW-UPS: closing one without a next step is refused (no lead left hanging)', async () => {
  const due = new Date(Date.now() - 3600e3).toISOString();      // already overdue
  const f = await call('POST', '/follow-ups', { token: S.A.token, tenant: S.A.sub,
    body: { lead_id: S.A.leadId, type: 'call', due_at: due, note: 'Confirm Saturday visit' } });
  assert.equal(f.status, 201, JSON.stringify(f.body));

  const day = await call('GET', '/follow-ups/my-day', { token: S.A.token, tenant: S.A.sub });
  const item = day.body.find(x => x.id === f.body.id);
  assert.ok(item && item.overdue, 'overdue item is in My Day');

  const dash = await call('GET', '/dashboard/summary', { token: S.A.token, tenant: S.A.sub });
  assert.ok(dash.body.follow_ups.overdue >= 1);

  const bare = await call('POST', `/follow-ups/${f.body.id}/complete`, { token: S.A.token, tenant: S.A.sub,
    body: { outcome: 'Spoke, he is keen' } });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'next_action_required');

  const next = new Date(Date.now() + 86400e3).toISOString();
  const ok = await call('POST', `/follow-ups/${f.body.id}/complete`, { token: S.A.token, tenant: S.A.sub,
    body: { outcome: 'Spoke, he is keen', next: { type: 'site_visit', due_at: next } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.next.type, 'site_visit');

  const peek = await call('GET', `/follow-ups?lead_id=${S.A.leadId}`, { token: S.B.token, tenant: S.B.sub });
  assert.equal(peek.status, 404, 'from B, A\'s lead does not exist, so neither do its follow-ups');
});

test('BOARD: kanban returns every stage with counts, scoped by role', async () => {
  const p = await call('GET', '/pipelines', { token: S.A.token, tenant: S.A.sub });
  assert.equal(p.body[0].stages.length, 12);
  const board = await call('GET', `/pipelines/${p.body[0].id}/board`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(board.status, 200);
  assert.equal(board.body.reduce((n, s) => n + s.count, 0), 3);
  const execBoard = await call('GET', `/pipelines/${p.body[0].id}/board`, { token: S.A.execToken, tenant: S.A.sub });
  const execLeads = await call('GET', '/leads', { token: S.A.execToken, tenant: S.A.sub });
  const execTotal = execBoard.body.reduce((n, s) => n + s.count, 0);
  assert.equal(execTotal, execLeads.body.data.length, 'board and list agree');
  assert.ok(execTotal < 3, 'executive board excludes leads owned by others');
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function checkIn(token, tenant, fields, file = PNG, type = 'image/png') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (file) fd.append('selfie', new Blob([file], { type }), 'selfie.png');
  const res = await fetch(`${base}/field/check-ins`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant }, body: fd });
  return { status: res.status, body: await res.json() };
}

test('FIELD: selfie + GPS check-in lands in the manager\'s feed with a signed photo link', async () => {
  const me = await call('GET', '/me', { token: S.A.token, tenant: S.A.sub });
  const set = await call('PATCH', `/users/${S.A.execId}`, { token: S.A.token, tenant: S.A.sub,
    body: { manager_id: me.body.user.id } });
  assert.equal(set.status, 200);

  const now = new Date().toISOString();
  const noSelfie = await checkIn(S.A.execToken, S.A.sub, { type: 'day_start', lat: 28.66, lng: 77.37, captured_at: now }, null);
  assert.equal(noSelfie.status, 400);
  assert.equal(noSelfie.body.code, 'selfie_required');

  const fake = await checkIn(S.A.execToken, S.A.sub, { type: 'day_start', lat: 28.66, lng: 77.37, captured_at: now },
    Buffer.from('<script>alert(1)</script>'), 'image/png');
  assert.equal(fake.status, 400, 'a file that only claims to be an image is rejected');

  const good = await checkIn(S.A.execToken, S.A.sub,
    { type: 'day_start', lat: 28.6692, lng: 77.3732, accuracy_m: 9, captured_at: now, address: 'Indirapuram' });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.status, 'ok');
  assert.equal(good.body.manager_id, me.body.user.id, 'auto-routed to the manager');

  const vague = await checkIn(S.A.execToken, S.A.sub,
    { type: 'meeting', lat: 28.6, lng: 77.3, accuracy_m: 450, captured_at: now });
  assert.equal(vague.body.status, 'flagged');
  assert.equal(vague.body.flags.low_accuracy, true);

  const feed = await call('GET', '/field/check-ins', { token: S.A.token, tenant: S.A.sub });
  assert.equal(feed.body.length, 2);
  const img = await fetch(origin + feed.body[0].selfie_url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const tampered = await fetch(origin + feed.body[0].selfie_url.replace(/sig=[^&]+/, 'sig=forged'));
  assert.equal(tampered.status, 403, 'forged photo links are refused');

  const live = await call('GET', '/field/team/live', { token: S.A.token, tenant: S.A.sub });
  assert.equal(live.body.find(u => u.id === S.A.execId).state, 'in_field');

  const review = await call('POST', `/field/check-ins/${vague.body.id}/review`, { token: S.A.token, tenant: S.A.sub,
    body: { decision: 'approved', note: 'Basement of tower, GPS weak' } });
  assert.equal(review.status, 200);
  const execReview = await call('POST', `/field/check-ins/${good.body.id}/review`, { token: S.A.execToken, tenant: S.A.sub,
    body: { decision: 'approved' } });
  assert.equal(execReview.status, 403, 'operators cannot approve their own check-ins');
});


test('INTEGRATIONS: client admin saves Razorpay keys; secrets never come back, only a hint', async () => {
  const bad = await call('PUT', '/integrations/razorpay', { token: S.A.token, tenant: S.A.sub,
    body: { config: { key_id: 'live_wrong' }, secrets: { key_secret: 'x' } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.issues.some(i => i.path === 'config.key_id'), 'format is checked');

  const saved = await call('PUT', '/integrations/razorpay', { token: S.A.token, tenant: S.A.sub,
    body: { config: { key_id: 'rzp_test_GoodKey123' }, secrets: { key_secret: 'good-secret', webhook_secret: 'whsec-razor-123' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.secrets.key_secret, '••••cret');                   // last four only
  assert.equal(saved.body.secrets.webhook_secret, '••••-123');
  assert.ok(!JSON.stringify(saved.body).includes('good-secret'), 'plaintext secret never returned');
  assert.ok(saved.body.webhook.url.includes('/api/webhooks/razorpay/'));

  const raw = await asDb(OWNER_URL, c => c.query(`SELECT secrets_enc FROM integrations WHERE tenant_id = $1 AND provider = 'razorpay'`, [S.A.id]));
  assert.ok(raw.rows[0].secrets_enc.startsWith('v1.') && !raw.rows[0].secrets_enc.includes('good-secret'), 'encrypted at rest');

  const ok = await call('POST', '/integrations/razorpay/test', { token: S.A.token, tenant: S.A.sub });
  assert.equal(ok.body.status, 'connected');
  assert.match(ok.body.result.detail, /test-mode/);

  // Change ONE secret, leave the rest blank: key_id and webhook secret are kept.
  const wrong = await call('PUT', '/integrations/razorpay', { token: S.A.token, tenant: S.A.sub, body: { secrets: { key_secret: 'stale-secret' } } });
  assert.equal(wrong.body.config.key_id, 'rzp_test_GoodKey123');
  assert.equal(wrong.body.secrets.webhook_secret, '••••-123');
  const fail = await call('POST', '/integrations/razorpay/test', { token: S.A.token, tenant: S.A.sub });
  assert.equal(fail.body.status, 'error');
  assert.match(fail.body.last_error, /rejected/);
  await call('PUT', '/integrations/razorpay', { token: S.A.token, tenant: S.A.sub, body: { secrets: { key_secret: 'good-secret' } } });

  const exec = await call('GET', '/integrations', { token: S.A.execToken, tenant: S.A.sub });
  assert.equal(exec.status, 403, 'only owners and admins see integrations');
  const other = await call('GET', '/integrations', { token: S.B.token, tenant: S.B.sub });
  assert.equal(other.body.find(i => i.provider === 'razorpay').status, 'not_configured', 'B sees none of A\'s keys');
});

test('INTEGRATIONS: Razorpay webhooks are accepted only with a valid signature', async () => {
  const list = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  const path = new URL(list.body.find(i => i.provider === 'razorpay').webhook.url).pathname;
  const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { amount: 5000000 } } } });
  const sig = createHmac('sha256', 'whsec-razor-123').update(payload).digest('hex');
  const post = (body, signature) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature }, body });

  assert.equal((await post(payload, sig)).status, 200);
  assert.equal((await post(payload.replace('5000000', '1'), sig)).status, 403, 'tampered amount rejected');
  assert.equal((await fetch(`${origin}/api/webhooks/razorpay/not-a-real-key-not-a-real-key`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: payload })).status, 403);
  const stored = await asDb(OWNER_URL, c => c.query(
    `SELECT event_type FROM webhook_events WHERE tenant_id = $1 AND provider = 'razorpay'`, [S.A.id]));
  assert.deepEqual(stored.rows.map(r => r.event_type), ['payment.captured']);
});

test('INTEGRATIONS: WhatsApp keys verify against Meta, and the webhook handshake works', async () => {
  const body = { config: { phone_number_id: '1098765432101', waba_id: '2098765432101' }, secrets: { access_token: 'EAAG-expired', app_secret: 'meta-app-secret-1' } };
  await call('PUT', '/integrations/whatsapp_cloud', { token: S.A.token, tenant: S.A.sub, body });
  const expired = await call('POST', '/integrations/whatsapp_cloud/test', { token: S.A.token, tenant: S.A.sub });
  assert.match(expired.body.last_error, /expired/, 'expired Meta tokens get a specific message');

  await call('PUT', '/integrations/whatsapp_cloud', { token: S.A.token, tenant: S.A.sub, body: { secrets: { access_token: 'EAAG-good' } } });
  const ok = await call('POST', '/integrations/whatsapp_cloud/test', { token: S.A.token, tenant: S.A.sub });
  assert.equal(ok.body.status, 'connected');
  assert.match(ok.body.result.detail, /\+91 98100 00000/);

  const hook = ok.body.webhook;
  const u = new URL(hook.url);
  const hs = await fetch(`${origin}${u.pathname}?hub.mode=subscribe&hub.verify_token=${hook.verify_token}&hub.challenge=4242`);
  assert.equal(await hs.text(), '4242', 'Meta handshake answered');
  assert.equal((await fetch(`${origin}${u.pathname}?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1`)).status, 403);

  const msg = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {} }] }] });
  const sig = 'sha256=' + createHmac('sha256', 'meta-app-secret-1').update(msg).digest('hex');
  const r = await fetch(origin + u.pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: msg });
  assert.equal(r.status, 200);
  const forged = await fetch(origin + u.pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: msg });
  assert.equal(forged.status, 403);
});

test('INTEGRATIONS: one calling provider at a time; unverifiable providers say so honestly', async () => {
  await call('PUT', '/integrations/knowlarity', { token: S.A.token, tenant: S.A.sub,
    body: { config: { sr_number: '+918061234567' }, secrets: { api_key: 'kn-key-123456', authorization: 'kn-auth-123456' } } });
  const kt = await call('POST', '/integrations/knowlarity/test', { token: S.A.token, tenant: S.A.sub });
  assert.equal(kt.body.status, 'saved');
  assert.equal(kt.body.result.ok, null, 'no fake green tick');

  await call('PUT', '/integrations/twilio', { token: S.A.token, tenant: S.A.sub,
    body: { config: { account_sid: 'AC' + 'a'.repeat(32), from_number: '+14155550100' }, secrets: { auth_token: 'tw-token-123456' } } });
  const list = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  assert.equal(list.body.find(i => i.provider === 'twilio').enabled, true);
  assert.equal(list.body.find(i => i.provider === 'knowlarity').enabled, false, 'enabling Twilio switched Knowlarity off');
});

test('PLATFORM INTEGRATIONS: only the super admin manages email; keys stay hidden', async () => {
  const denied = await call('PUT', '/platform/integrations/smtp', { token: S.supportToken,
    body: { config: { host: 'smtp.example.com', port: '587', username: 'u', from_email: 'a@b.co' }, secrets: { password: 'p' } } });
  assert.equal(denied.status, 403);
  const saved = await call('PUT', '/platform/integrations/smtp', { token: S.superToken,
    body: { config: { host: '127.0.0.1', port: '2525', username: 'mailer', from_email: 'no-reply@hxgconnect.test' }, secrets: { password: 'smtp-pass-9876' } } });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes('smtp-pass-9876'));
  const t = await call('POST', '/platform/integrations/smtp/test', { token: S.superToken });
  assert.equal(t.body.status, 'error', 'unreachable mail server reported, not hidden');
  // While email is configured but failing, invitations still work by link.
  const inv = await call('POST', '/users', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Meera Kulkarni', email: `meera-${RUN}@${S.A.sub}.com`, role: 'telecaller' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.invite_emailed, false);
  assert.ok(inv.body.invite_link.includes('/invite#token='), 'link still provided');
  assert.equal((await call('DELETE', '/platform/integrations/smtp', { token: S.superToken })).status, 204);
});

test('DOMAIN: works with no domain; setting one in the console turns on subdomains live', async () => {
  const before = await call('GET', '/public/config');
  assert.equal(before.body.base_domain, null, 'no domain yet: workspace typed at sign-in');
  assert.equal((await call('PUT', '/platform/settings/domain', { token: S.supportToken, body: { base_domain: 'x.com' } })).status, 403);
  assert.equal((await call('PUT', '/platform/settings/domain', { token: S.superToken, body: { base_domain: 'https://bad' } })).status, 400);

  const set = await call('PUT', '/platform/settings/domain', { token: S.superToken, body: { base_domain: 'hxgconnect.test' } });
  assert.equal(set.body.base_domain, 'hxgconnect.test');
  // A request to sunrise-style host, with NO x-tenant header, resolves the workspace from the subdomain.
  const viaHost = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: app.getHttpServer().address().port, path: '/api/me',
      headers: { host: `${S.A.sub}.hxgconnect.test`, authorization: `Bearer ${S.A.token}` } },
      res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })); });
    r.on('error', reject); r.end();
  });
  assert.equal(viaHost.status, 200);
  assert.equal(viaHost.body.workspace.subdomain, S.A.sub);
  const wrongHost = await new Promise(resolve => {
    http.request({ host: '127.0.0.1', port: app.getHttpServer().address().port, path: '/api/me',
      headers: { host: `${S.B.sub}.hxgconnect.test`, authorization: `Bearer ${S.A.token}` } }, res => resolve(res.statusCode)).end();
  });
  assert.equal(wrongHost, 401, 'A\'s token refused on B\'s subdomain');

  await call('PUT', '/platform/settings/domain', { token: S.superToken, body: { base_domain: null } });
  assert.equal((await call('GET', '/public/config')).body.base_domain, null, 'removing it goes back to typed workspaces');
});


const sumPaise = rows => rows.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0);

test('INVENTORY: a tower generator lays out every unit with floor-rise pricing', async () => {
  const p = await call('POST', '/projects', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Sunrise Heights', city: 'Ghaziabad', locality: 'Indirapuram', rera_number: 'UPRERAPRJ1234' } });
  assert.equal(p.status, 201);
  S.A.projectId = p.body.id;
  assert.equal((await call('POST', '/projects', { token: S.A.token, tenant: S.A.sub, body: { name: 'Sunrise Heights' } })).status, 409);
  assert.equal((await call('POST', '/projects', { token: S.A.execToken, tenant: S.A.sub, body: { name: 'Exec Tower' } })).status, 403);

  const t = await call('POST', `/projects/${S.A.projectId}/towers`, { token: S.A.token, tenant: S.A.sub, body: {
    name: 'T2', floors: 12, floor_rise: 50000,
    layout: [{ unit_type: '2BHK', super_sqft: 1120, base_price: 6400000 }, { unit_type: '3BHK', super_sqft: 1450, facing: 'East', base_price: 8200000 }] } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(t.body.units_created, 24);
  S.A.towerId = t.body.id;
  const grid = await call('GET', `/towers/${S.A.towerId}/units`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(grid.body.length, 24);
  assert.equal(Number(grid.body.find(u => u.unit_no === '1202').base_price), 8750000, 'floor 12 = base + 11 × floor rise');
  S.A.unitId = grid.body.find(u => u.unit_no === '1002').id;                      // ₹86.5 L, inside Rohit's budget

  assert.equal((await call('GET', `/projects/${S.A.projectId}`, { token: S.B.token, tenant: S.B.sub })).status, 404, 'B cannot see A\'s project');

  const bad = await call('POST', `/projects/${S.A.projectId}/payment-plans`, { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Broken', milestones: [{ label: 'On booking', percent: 10 }, { label: 'Later', percent: 80 }] } });
  assert.equal(bad.status, 400, 'milestones must total 100%');
  const plan = await call('POST', `/projects/${S.A.projectId}/payment-plans`, { token: S.A.token, tenant: S.A.sub, body: { name: 'Construction linked',
    milestones: [{ label: 'On booking', percent: 10, due_days: 0 }, { label: 'Within 45 days', percent: 40, due_days: 45 }, { label: 'On possession', percent: 50, due_days: null }] } });
  assert.equal(plan.status, 201);
  S.A.planId = plan.body.id;
});

test('HOLDS: one buyer at a time; expired holds go back on sale', async () => {
  const anita = (await call('GET', '/leads', { token: S.A.execToken, tenant: S.A.sub })).body.data.find(l => l.name === 'Anita Shah');
  S.A.anitaId = anita.id;
  const h = await call('POST', `/units/${S.A.unitId}/hold`, { token: S.A.execToken, tenant: S.A.sub, body: { lead_id: anita.id, hours: 24 } });
  assert.equal(h.status, 200);
  assert.equal(h.body.status, 'hold');
  const clash = await call('POST', `/units/${S.A.unitId}/hold`, { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId } });
  assert.equal(clash.status, 409, 'someone else\'s live hold blocks a second buyer');

  await asDb(OWNER_URL, c => c.query(`UPDATE units SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [S.A.unitId]));
  const grid = await call('GET', `/towers/${S.A.towerId}/units`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(grid.body.find(u => u.id === S.A.unitId).status, 'available', 'expired hold shows as available immediately');
  const swept = await asDb(OWNER_URL, c => c.query('SELECT release_expired_holds() AS n'));
  assert.ok(swept.rows[0].n >= 1, 'sweeper releases it in the database too');

  const match = await call('GET', `/units/match?lead_id=${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub });
  assert.ok(match.body.some(u => u.id === S.A.unitId), 'unit offered to a lead whose budget fits');
});

test('BOOKINGS: booking locks the unit, builds a schedule that sums exactly, and wins the lead', async () => {
  const disc = await call('POST', '/bookings', { token: S.A.execToken, tenant: S.A.sub, body: {
    lead_id: S.A.anitaId, unit_id: S.A.unitId, payment_plan_id: S.A.planId, agreed_price: 8650000 * 0.9,
    applicant: { name: 'Anita Shah', phone: '9811122233' } } });
  assert.equal(disc.status, 403);
  assert.equal(disc.body.code, 'discount_needs_approval');

  const bk = await call('POST', '/bookings', { token: S.A.token, tenant: S.A.sub, body: {
    lead_id: S.A.leadId, unit_id: S.A.unitId, payment_plan_id: S.A.planId, agreed_price: 8612345.67,
    applicant: { name: 'Rohit Mehra', phone: '98765 43210', email: 'rohit@example.com' } } });
  assert.equal(bk.status, 201, JSON.stringify(bk.body));
  S.A.bookingId = bk.body.id;

  const d = await call('GET', `/bookings/${S.A.bookingId}`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(d.body.schedule.length, 3);
  assert.equal(sumPaise(d.body.schedule), 861234567, 'instalments add up to the agreed price to the paisa');
  assert.equal(d.body.schedule[2].due_date, null, 'possession instalment is due on demand');
  assert.equal((await call('GET', `/leads/${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub })).body.status, 'won');

  const twice = await call('POST', '/bookings', { token: S.A.token, tenant: S.A.sub, body: {
    lead_id: S.A.anitaId, unit_id: S.A.unitId, payment_plan_id: S.A.planId, agreed_price: 8650000,
    applicant: { name: 'Anita Shah', phone: '9811122233' } } });
  assert.equal(twice.status, 409, 'a booked unit cannot be booked again');
});

test('PAYMENTS: receipts, overpayment refused, and a Razorpay link settles exactly once', async () => {
  const d = await call('GET', `/bookings/${S.A.bookingId}`, { token: S.A.token, tenant: S.A.sub });
  const first = d.body.schedule[0];
  const over = await call('POST', `/bookings/${S.A.bookingId}/payments`, { token: S.A.token, tenant: S.A.sub,
    body: { schedule_id: first.id, amount: Number(first.amount) + 1, mode: 'neft' } });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'overpayment');
  const part = await call('POST', `/bookings/${S.A.bookingId}/payments`, { token: S.A.token, tenant: S.A.sub,
    body: { schedule_id: first.id, amount: 100000, mode: 'cheque', reference: 'HDFC 004512' } });
  assert.equal(part.status, 201);
  assert.equal((await call('POST', `/bookings/${S.A.bookingId}/payments`, { token: S.A.execToken, tenant: S.A.sub,
    body: { schedule_id: first.id, amount: 1, mode: 'cash' } })).status, 403, 'executives cannot record money');

  const link = await call('POST', `/bookings/${S.A.bookingId}/schedule/${first.id}/payment-link`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.equal(link.body.url, 'https://rzp.io/i/T3st');
  const leftPaise = Math.round((Number(first.amount) - 100000) * 100);
  assert.equal(lastLink.amount, leftPaise, 'link is for what is still due, in paise');
  assert.equal(lastLink.notes.schedule_id, first.id);

  const payload = JSON.stringify({ event: 'payment_link.paid', payload: {
    payment_link: { entity: { id: 'plink_T3st', notes: { tenant_id: S.A.id, booking_id: S.A.bookingId, schedule_id: first.id } } },
    payment: { entity: { id: `pay_${RUN}`, amount: leftPaise } } } });
  const list = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  const hook = new URL(list.body.find(i => i.provider === 'razorpay').webhook.url).pathname;
  const sig = createHmac('sha256', 'whsec-razor-123').update(payload).digest('hex');
  for (let i = 0; i < 2; i++) {
    const r = await fetch(origin + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: payload });
    assert.equal(r.status, 200);
  }
  const after = await call('GET', `/bookings/${S.A.bookingId}`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(after.body.schedule[0].status, 'paid');
  assert.equal(after.body.payments.filter(p => p.mode === 'razorpay').length, 1, 'webhook replay did not double-count');
});

test('SITE VISITS: they land in My Day, need a next step to close, and are verified by an on-site check-in', async () => {
  const at = new Date(Date.now() - 30 * 60e3).toISOString();
  const v = await call('POST', '/site-visits', { token: S.A.execToken, tenant: S.A.sub,
    body: { lead_id: S.A.anitaId, project_id: S.A.projectId, scheduled_at: at } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const day = await call('GET', '/follow-ups/my-day', { token: S.A.execToken, tenant: S.A.sub });
  assert.ok(day.body.some(f => f.type === 'site_visit' && f.lead_id === S.A.anitaId));

  const ci = await checkIn(S.A.execToken, S.A.sub, { type: 'site_visit_in', lat: 28.6411, lng: 77.3712, accuracy_m: 12, captured_at: new Date().toISOString() });
  assert.equal(ci.status, 201);
  const bare = await call('POST', `/site-visits/${v.body.id}/complete`, { token: S.A.execToken, tenant: S.A.sub, body: { outcome: 'completed', interest: 4 } });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'next_action_required');
  const ok = await call('POST', `/site-visits/${v.body.id}/complete`, { token: S.A.execToken, tenant: S.A.sub, body: {
    outcome: 'completed', interest: 4, notes: 'Liked T2 east-facing, wife wants a higher floor',
    next: { type: 'call', due_at: new Date(Date.now() + 864e5).toISOString() } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verified, true, 'matched to the executive\'s on-site selfie check-in');
  const lead = await call('GET', `/leads/${S.A.anitaId}`, { token: S.A.execToken, tenant: S.A.sub });
  assert.equal(lead.body.stage, 'Site Visit', 'lead moved forward to Site Visit');
  assert.deepEqual((await call('GET', '/site-visits?range=today', { token: S.B.token, tenant: S.B.sub })).body, []);
});

test('BOOKINGS: only managers cancel, and cancelling frees the unit', async () => {
  assert.equal((await call('POST', `/bookings/${S.A.bookingId}/cancel`, { token: S.A.execToken, tenant: S.A.sub, body: { reason: 'Buyer changed mind' } })).status, 403);
  const c = await call('POST', `/bookings/${S.A.bookingId}/cancel`, { token: S.A.token, tenant: S.A.sub, body: { reason: 'Loan rejected by bank' } });
  assert.equal(c.status, 200);
  const grid = await call('GET', `/towers/${S.A.towerId}/units`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(grid.body.find(u => u.id === S.A.unitId).status, 'available');
});


const findLead = async (q) => (await call('GET', `/leads?q=${encodeURIComponent(q)}&limit=50`, { token: S.A.token, tenant: S.A.sub })).body.data;

test('CAPTURE: website forms post with a key; replies never reveal who is already a lead', async () => {
  assert.equal((await call('POST', '/api-keys', { token: S.A.execToken, tenant: S.A.sub, body: { name: 'Site' } })).status, 403);
  const k = await call('POST', '/api-keys', { token: S.A.token, tenant: S.A.sub, body: { name: 'sunriseheights.in contact form' } });
  assert.equal(k.status, 201);
  assert.match(k.body.key, /^hxgk_[0-9a-f]{8}_/);
  S.A.apiKey = k.body.key; S.A.apiKeyId = k.body.id;
  assert.ok(!JSON.stringify((await call('GET', '/api-keys', { token: S.A.token, tenant: S.A.sub })).body).includes(S.A.apiKey), 'key shown once only');

  const pre = await fetch(`${base}/capture/leads`, { method: 'OPTIONS', headers: { origin: 'https://sunriseheights.in', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const post = (body, key = S.A.apiKey) => fetch(`${base}/capture/leads`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(key && { 'x-api-key': key }) }, body: JSON.stringify(body) });

  assert.equal((await post({ name: 'No Key', phone: '9000011111' }, null)).status, 401);
  const r1 = await post({ name: 'Pooja Bhatt', phone: '98100 77001', message: 'Is the 3BHK in T2 still available?', budget: '90 lakh', utm_campaign: 'diwali' });
  assert.equal(r1.status, 201);
  const pooja = (await findLead('Pooja Bhatt'))[0];
  assert.equal(pooja.source, 'website');
  assert.equal(Number(pooja.budget_max), 9000000, '"90 lakh" understood');
  const again = await post({ name: 'Pooja B', phone: '+91 98100 77001' });
  assert.deepEqual(await again.json(), { ok: true }, 'duplicate gets the identical reply');
  assert.equal((await findLead('77001')).length, 1, 'and no second lead');

  const bot = await post({ name: 'Spam Bot', phone: '9000022222', website: 'http://spam.example' });
  assert.equal(bot.status, 201);
  assert.equal((await findLead('Spam Bot')).length, 0, 'honeypot submission silently dropped');

  const html = await fetch(`${base}/capture/leads`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: S.A.apiKey, name: 'Harish Menon', phone: '9810077002', redirect: 'https://sunriseheights.in/thanks' }) });
  assert.equal(html.status, 303, 'plain HTML form gets sent to the thank-you page');
  assert.equal(html.headers.get('location'), 'https://sunriseheights.in/thanks');
  assert.equal((await findLead('Harish Menon')).length, 1);
  assert.equal((await call('GET', `/leads?q=Harish`, { token: S.B.token, tenant: S.B.sub })).body.data.length, 0, 'lands only in the key\'s workspace');
});

test('ASSIGNMENT: rules route by source and rotate fairly through the pool', async () => {
  const me = (await call('GET', '/me', { token: S.A.token, tenant: S.A.sub })).body.user.id;
  assert.equal((await call('POST', '/assignment-rules', { token: S.A.execToken, tenant: S.A.sub, body: { name: 'x', assignee_ids: [me] } })).status, 403);
  const r = await call('POST', '/assignment-rules', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Website enquiries', conditions: { sources: ['website'] }, assignee_ids: [S.A.execId, me] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const owners = [];
  for (const [i, n] of ['Ravi', 'Sunita', 'Aman'].entries()) {
    await fetch(`${base}/capture/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': S.A.apiKey },
      body: JSON.stringify({ name: `${n} Rotation`, phone: `98100880${i}0` }) });
    owners.push((await findLead(`${n} Rotation`))[0].owner_id);
  }
  assert.deepEqual(owners, [S.A.execId, me, S.A.execId], 'round-robin through the pool');
  const walkIn = await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub, body: { name: 'Walk In', phone: '9810099001', source: 'walk_in' } });
  assert.equal(walkIn.body.assigned_by, 'least loaded', 'no matching rule falls back to least loaded');
  await call('POST', `/api-keys/${S.A.apiKeyId}/revoke`, { token: S.A.token, tenant: S.A.sub });
  const dead = await fetch(`${base}/capture/leads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': S.A.apiKey }, body: '{"name":"X","phone":"9000033333"}' });
  assert.equal(dead.status, 401, 'revoked key stops working at once');
});

test('IMPORT: semicolon CSV with quotes, lakh/crore budgets, duplicates and bad rows reported by row number', async () => {
  const csv = '\uFEFFCustomer Name;Mobile No;Budget;Locality;Remarks\n' +
    'Sanjay Kapoor;98110 22334;80-95L;Vaishali;Wants 3BHK\n' +
    'Deepa Nair;+91 98110 55667;1.2 Cr;Noida;\n' +
    'Dup Person;98765 43210;;;\n' +
    'Bad Phone;12;;;\n' +
    '"Iyer; Ramesh";9811077889;55 lakh;"Indirapuram, Ghaziabad";"Said ""call after 6"""\n';
  const form = (extra = {}) => { const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'leads.csv');
    for (const [k, v] of Object.entries(extra)) fd.append(k, v); return fd; };
  const up = async (path, fd) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${S.A.token}`, 'x-tenant': S.A.sub }, body: fd }); return { status: r.status, body: await r.json() }; };

  const pv = await up('/imports/leads/preview', form());
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.total, 5);
  assert.deepEqual(pv.body.mapping, { name: 0, phone: 1, budget: 2, location: 3, note: 4 }, 'columns recognised from Indian header names');

  const im = await up('/imports/leads', form({ mapping: JSON.stringify(pv.body.mapping), default_source: 'expo_2026' }));
  assert.equal(im.status, 200, JSON.stringify(im.body));
  assert.equal(im.body.created, 3);
  assert.equal(im.body.duplicates, 1, 'Rohit\'s number appended to his timeline, not duplicated');
  assert.deepEqual(im.body.invalid.map(x => x.row), [5], 'bad phone reported as spreadsheet row 5');
  const sanjay = (await findLead('Sanjay Kapoor'))[0];
  assert.deepEqual([Number(sanjay.budget_min), Number(sanjay.budget_max)], [8000000, 9500000], '"80-95L" becomes a range');
  assert.equal(sanjay.source, 'expo_2026');
  const iyer = await call('GET', `/leads/${(await findLead('Iyer; Ramesh'))[0].id}`, { token: S.A.token, tenant: S.A.sub });
  assert.deepEqual(iyer.body.preferred_locations, ['Indirapuram', 'Ghaziabad']);
  assert.ok(iyer.body.timeline.some(t => t.body === 'Said "call after 6"'), 'quoted quotes survive');
});

test('FACEBOOK: signed lead webhook fetches the answers and creates the lead', async () => {
  const saved = await call('PUT', '/integrations/facebook_leads', { token: S.A.token, tenant: S.A.sub,
    body: { config: { page_id: '1234567' }, secrets: { page_access_token: 'EAAG-good', app_secret: 'fb-app-secret-1' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const t = await call('POST', '/integrations/facebook_leads/test', { token: S.A.token, tenant: S.A.sub });
  assert.match(t.body.result.detail, /Client A Realty/);
  const path = new URL(t.body.webhook.url).pathname;
  assert.equal(await (await fetch(`${origin}${path}?hub.mode=subscribe&hub.verify_token=${t.body.webhook.verify_token}&hub.challenge=77`)).text(), '77');

  const msg = JSON.stringify({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: '987654321012', form_id: '555', ad_id: '666' } }] }] });
  const sig = 'sha256=' + createHmac('sha256', 'fb-app-secret-1').update(msg).digest('hex');
  const forged = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '1'.repeat(64) }, body: msg });
  assert.equal(forged.status, 403);
  const ok = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: msg });
  assert.equal(ok.status, 200);
  const kavita = (await findLead('Kavita Rao'))[0];
  assert.ok(kavita, 'lead created from the Graph API answers');
  assert.equal(kavita.source, 'facebook');
});

test('GOOGLE ADS: lead form webhook accepted only with the generated key', async () => {
  const saved = await call('PUT', '/integrations/google_ads_leads', { token: S.A.token, tenant: S.A.sub, body: {} });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const path = new URL(saved.body.webhook.url).pathname;
  const lead = (key) => ({ google_key: key, lead_id: 'TeSter-123', campaign_id: 991, form_id: 42, gcl_id: 'abc', is_test: false,
    user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Vikram Sethi' }, { column_id: 'PHONE_NUMBER', string_value: '+919811234567' }, { column_id: 'CITY', string_value: 'Noida' }] });
  const post = body => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(lead('wrong-key-wrong-key-12'))).status, 403);
  assert.equal((await post(lead(saved.body.webhook.verify_token))).status, 200);
  const v = (await findLead('Vikram Sethi'))[0];
  assert.equal(v.source, 'google_ads');
});


const twSign = (url, p) => createHmac('sha1', 'tw-token-123456').update(url + Object.keys(p).sort().map(k => k + p[k]).join('')).digest('base64');
async function twilioHook(params, forge = false) {
  const list = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  const url = origin + new URL(list.body.find(i => i.provider === 'twilio').webhook.url).pathname;
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': forge ? 'Zm9yZ2Vk' : twSign(url, params) },
    body: new URLSearchParams(params) });
}

test('CALLS: click-to-call rings the agent first, records, and the outcome is logged', async () => {
  const noPhone = await call('POST', '/calls/click-to-call', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId } });
  assert.equal(noPhone.status, 400);
  assert.equal(noPhone.body.code, 'agent_phone_missing');
  assert.equal((await call('PATCH', '/me', { token: S.A.token, tenant: S.A.sub, body: { phone: '98100 12345' } })).body.phone, '+919810012345');

  const c = await call('POST', '/calls/click-to-call', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.provider_call_id, 'CA123');
  assert.equal(lastTwilio.To, '+919810012345', 'the agent\'s phone rings first');
  assert.match(lastTwilio.Twiml, /<Number>\+919876543210<\/Number>/, 'then Twilio dials the buyer');
  assert.match(lastTwilio.Twiml, /record="record-from-answer-dual"/, 'with recording on');

  const done = { CallSid: 'CA123', CallStatus: 'completed', CallDuration: '185', Direction: 'outbound-api', RecordingUrl: `${mockBase}/recordings/RE1` };
  assert.equal((await twilioHook(done, true)).status, 403, 'unsigned status callback refused');
  assert.equal((await twilioHook(done)).status, 200);
  const calls = await call('GET', `/calls?lead_id=${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub });
  const logged = calls.body.find(x => x.id === c.body.id);
  assert.deepEqual([logged.status, logged.duration_sec, logged.has_recording], ['completed', 185, true]);

  const rec = await fetch(`${base}/calls/${c.body.id}/recording`, { headers: { authorization: `Bearer ${S.A.token}`, 'x-tenant': S.A.sub } });
  assert.equal(rec.status, 200);
  assert.equal(await rec.text(), 'ID3-fake-audio', 'streamed through the API with the provider\'s credentials');
  const peek = await fetch(`${base}/calls/${c.body.id}/recording`, { headers: { authorization: `Bearer ${S.A.execToken}`, 'x-tenant': S.A.sub } });
  assert.equal(peek.status, 404, 'an executive can\'t play someone else\'s call');

  const d = await call('POST', `/calls/${c.body.id}/disposition`, { token: S.A.token, tenant: S.A.sub,
    body: { disposition: 'call_back', note: 'In a meeting, call after 6', next: { type: 'call', due_at: new Date(Date.now() + 4 * 3600e3).toISOString() } } });
  assert.equal(d.status, 200);
});

test('CALLS: a missed call from a new number becomes a lead with a call-back in My Day, once', async () => {
  const missed = { CallSid: 'CA999', CallStatus: 'no-answer', Direction: 'inbound', From: '+919876500000', To: '+14155550100' };
  assert.equal((await twilioHook(missed)).status, 200);
  assert.equal((await twilioHook(missed)).status, 200, 'provider retry');
  const leads = await findLead('9876500000');
  assert.equal(leads.length, 1, 'one lead, even after the retry');
  assert.equal(leads[0].source, 'inbound_call');
  const fu = await asDb(OWNER_URL, c => c.query(`SELECT count(*)::int AS n FROM follow_ups WHERE lead_id = $1 AND note LIKE 'Missed call%' AND status = 'pending'`, [leads[0].id]));
  assert.equal(fu.rows[0].n, 1, 'exactly one call-back task');
});

test('WHATSAPP: templates outside 24 hours, free text inside, receipts, and STOP is honoured', async () => {
  const sync = await call('POST', '/whatsapp/templates/sync', { token: S.A.token, tenant: S.A.sub });
  assert.equal(sync.body.synced, 2);
  const text = await call('POST', '/whatsapp/messages', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId, text: 'Hi Rohit' } });
  assert.equal(text.body.code, 'outside_24h_window');
  const pending = await call('POST', '/whatsapp/messages', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId, template: { name: 'diwali_offer', language: 'en', params: ['T2'] } } });
  assert.equal(pending.body.code, 'template_not_approved');
  const short = await call('POST', '/whatsapp/messages', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId, template: { name: 'site_visit_reminder', language: 'en', params: ['Rohit'] } } });
  assert.equal(short.body.code, 'template_params');
  const tpl = await call('POST', '/whatsapp/messages', { token: S.A.token, tenant: S.A.sub,
    body: { lead_id: S.A.leadId, template: { name: 'site_visit_reminder', language: 'en', params: ['Rohit', 'Sunrise Heights', 'Saturday 11 am'] } } });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
  assert.equal(lastWa.to, '919876543210');
  assert.equal(lastWa.template.components[0].parameters[2].text, 'Saturday 11 am');

  const list = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  const hook = origin + new URL(list.body.find(i => i.provider === 'whatsapp_cloud').webhook.url).pathname;
  const deliver = async payload => { const raw = JSON.stringify(payload);
    return fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'meta-app-secret-1').update(raw).digest('hex') }, body: raw }); };
  const msg = (id, body, extra = {}) => ({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '919876543210', id, type: 'text', text: { body } }], ...extra } }] }] });
  assert.equal((await deliver(msg(`wamid.IN1${RUN}`, 'Is T2 still available?', { statuses: [{ id: tpl.body.wa_message_id, status: 'delivered' }] }))).status, 200);

  const thread = await call('GET', `/whatsapp/messages?lead_id=${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(thread.body.window_open, true, 'their reply opens the 24-hour window');
  assert.equal(thread.body.messages.find(m => m.wa_message_id === tpl.body.wa_message_id).status, 'delivered');
  assert.equal((await call('POST', '/whatsapp/messages', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId, text: 'Yes, 1002 is open. Visit Saturday?' } })).status, 201);

  await deliver(msg(`wamid.IN2${RUN}`, 'STOP'));
  const blocked = await call('POST', '/whatsapp/messages', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId, text: 'One last thing' } });
  assert.equal(blocked.body.code, 'opted_out');
  assert.equal((await call('GET', `/whatsapp/messages?lead_id=${S.A.leadId}`, { token: S.B.token, tenant: S.B.sub })).status, 403, 'B is on Starter (no WhatsApp), and the thread is A\'s anyway');
});


test('REPORTS: numbers add up, exports are safe to open, and roles and workspaces stay fenced', async () => {
  const walk = (await findLead('Walk In'))[0];
  const lost = (await call('GET', '/pipelines', { token: S.A.token, tenant: S.A.sub })).body[0].stages.find(st => st.is_lost);
  assert.equal((await call('POST', `/leads/${walk.id}/stage`, { token: S.A.token, tenant: S.A.sub, body: { stage_id: lost.id, note: 'Budget mismatch' } })).status, 201);
  assert.equal((await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub,
    body: { name: 'Formula Test', phone: '9810066601', source: '=HYPERLINK("http://evil.example")' } })).status, 201);

  assert.equal((await call('GET', '/reports', { token: S.A.token, tenant: S.A.sub })).body.length, 7);
  assert.deepEqual((await call('GET', '/reports', { token: S.A.execToken, tenant: S.A.sub })).body, [], 'executives see no team reports');
  assert.equal((await call('GET', '/reports/team', { token: S.A.execToken, tenant: S.A.sub })).status, 403);

  const r = async key => (await call('GET', `/reports/${key}`, { token: S.A.token, tenant: S.A.sub })).body;
  const src = await r('lead_sources');
  assert.equal(src.totals.leads, src.rows.reduce((n, x) => n + x.leads, 0), 'total equals the rows');
  assert.ok(src.rows.find(x => x.source === 'facebook').leads >= 1);
  const team = await r('team');
  const owner = team.rows.find(x => x.role === 'Owner');
  assert.equal(owner.calls, 1);
  assert.equal(owner.talk_min, 3.1, '185 seconds of talk time');
  const visits = await r('site_visits');
  assert.deepEqual([visits.rows[0].project, visits.rows[0].completed, visits.rows[0].verified], ['Sunrise Heights', 1, 1]);
  const coll = await r('collections');
  assert.ok(coll.totals.collected > 100000 && coll.totals.receipts >= 2, 'cheque and Razorpay receipts counted');
  assert.deepEqual((await r('lost_reasons')).rows, [{ reason: 'Budget mismatch', leads: 1, share: 1 }]);

  const csv = await fetch(`${base}/reports/lead_sources?format=csv`, { headers: { authorization: `Bearer ${S.A.token}`, 'x-tenant': S.A.sub } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel shows ₹ and Hindi names correctly');
  const text = bytes.subarray(3).toString('utf8');
  assert.ok(text.startsWith('Source,Leads'), 'header row');
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil.example"")"`), 'formula neutralised and quoted');
  assert.ok(!text.split('\r\n').some(line => line.startsWith('=')), 'no line can execute in Excel');
  const xlsx = await fetch(`${base}/reports/bookings?format=xlsx`, { headers: { authorization: `Bearer ${S.A.token}`, 'x-tenant': S.A.sub } });
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString(), 'PK', 'a real .xlsx (zip) file');

  assert.equal((await call('GET', '/reports/calls?from=2026-05-10&to=2026-01-01', { token: S.A.token, tenant: S.A.sub })).status, 400);
  assert.equal((await call('GET', '/reports/calls?from=2024-01-01&to=2026-01-01', { token: S.A.token, tenant: S.A.sub })).status, 400);
  const other = (await call('GET', '/reports/lead_sources', { token: S.B.token, tenant: S.B.sub })).body;
  assert.ok(!other.rows.some(x => x.source === 'facebook'), 'B\'s report has none of A\'s leads');
});


test('PARTNERS: the portal is fenced off, protection decides who gets the buyer, and commission follows the booking', async () => {
  assert.equal((await call('GET', '/channel-partners', { token: S.A.token, tenant: S.A.sub })).body.code, 'feature_not_in_plan', 'Pro feature');
  await call('PATCH', `/platform/tenants/${S.A.id}/overrides`, { token: S.superToken, body: { features: { cp_portal: true } } });
  assert.equal((await call('POST', '/channel-partners', { token: S.A.execToken, tenant: S.A.sub,
    body: { firm_name: 'Sneaky', contact_name: 'Sneaky', email: 'sneaky@x.com' } })).status, 403);
  const mk = async (firm, email) => {
    const r = await call('POST', '/channel-partners', { token: S.A.token, tenant: S.A.sub, body: { firm_name: firm, contact_name: `${firm} Owner`, email, commission_pct: 2 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const acc = await call('POST', '/partner/auth/accept-invite', { body: { token: new URLSearchParams(r.body.invite_link.split('#')[1]).get('token'), password: 'partner-pass-1' } });
    assert.equal(acc.status, 200);
    return { id: r.body.id, token: acc.body.token, email };
  };
  const p1 = await mk('Ravi Associates', `ravi-${RUN}@brokers.in`);
  const p2 = await mk('Kumar Realty', `kumar-${RUN}@brokers.in`);
  assert.equal((await call('POST', '/partner/auth/login', { tenant: S.A.sub, body: { email: p1.email, password: 'partner-pass-1' } })).status, 200);

  assert.equal((await call('GET', '/leads', { token: p1.token, tenant: S.A.sub })).status, 403, 'partner token refused on the CRM');
  assert.equal((await call('GET', '/me', { token: p1.token, tenant: S.A.sub })).status, 403);
  assert.equal((await call('GET', '/partner/leads', { token: S.A.token, tenant: S.A.sub })).status, 403, 'staff token refused on the portal');

  const reg = await call('POST', '/partner/leads', { token: p1.token, tenant: S.A.sub, body: { name: 'Neeraj Gupta', phone: '98111 44001', budget: '70 lakh', requirement: '2BHK flat' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const days = (new Date(reg.body.protected_until) - Date.now()) / 864e5;
  assert.ok(days > 59 && days <= 60, '60-day protection');
  const direct = await call('POST', '/partner/leads', { token: p1.token, tenant: S.A.sub, body: { name: 'Rohit', phone: '9876543210' } });
  assert.equal(direct.status, 409);
  const poach = await call('POST', '/partner/leads', { token: p2.token, tenant: S.A.sub, body: { name: 'Neeraj G', phone: '+91 98111 44001' } });
  assert.equal(poach.status, 409, 'protected buyer can\'t be poached');
  assert.equal(poach.body.message, direct.body.message, 'same reply either way: no hint who holds the buyer');

  await asDb(OWNER_URL, c => c.query(`UPDATE leads SET cp_protected_until = now() - interval '1 day' WHERE id = $1`, [reg.body.id]));
  const takeover = await call('POST', '/partner/leads', { token: p2.token, tenant: S.A.sub, body: { name: 'Neeraj G', phone: '9811144001' } });
  assert.equal(takeover.status, 201, 'lapsed protection: another partner may register');
  assert.equal(takeover.body.id, reg.body.id, 'same buyer, re-attributed, not duplicated');
  assert.equal((await call('GET', '/partner/leads', { token: p1.token, tenant: S.A.sub })).body.length, 0);
  assert.equal((await call('GET', '/partner/leads', { token: p2.token, tenant: S.A.sub })).body[0].name, 'Neeraj Gupta');

  const grid = (await call('GET', `/towers/${S.A.towerId}/units`, { token: S.A.token, tenant: S.A.sub })).body;
  const book = (leadId, unitNo, price, name, phone) => call('POST', '/bookings', { token: S.A.token, tenant: S.A.sub, body: {
    lead_id: leadId, unit_id: grid.find(u => u.unit_no === unitNo).id, payment_plan_id: S.A.planId, agreed_price: price, applicant: { name, phone } } });
  assert.equal((await book(reg.body.id, '1001', 6850000, 'Neeraj Gupta', '9811144001')).status, 201);
  const mine = (await call('GET', '/partner/commissions', { token: p2.token, tenant: S.A.sub })).body;
  assert.deepEqual([Number(mine[0].amount), mine[0].status], [137000, 'pending'], '2% of ₹68.5 L to the partner who held the buyer at booking');
  const cid = mine[0].id;
  assert.equal((await call('POST', `/commissions/${cid}/pay`, { token: S.A.token, tenant: S.A.sub, body: { reference: 'NEFT 991' } })).status, 400, 'approve before paying');
  assert.equal((await call('POST', `/commissions/${cid}/approve`, { token: S.A.token, tenant: S.A.sub })).status, 200);
  assert.equal((await call('POST', `/commissions/${cid}/pay`, { token: S.A.token, tenant: S.A.sub, body: { reference: 'NEFT UTR 4471' } })).status, 200);
  assert.equal((await call('GET', '/partner/commissions', { token: p2.token, tenant: S.A.sub })).body[0].status, 'paid');

  const reg2 = await call('POST', '/partner/leads', { token: p1.token, tenant: S.A.sub, body: { name: 'Farida Khan', phone: '98111 44002' } });
  const bk2 = await book(reg2.body.id, '1101', 6900000, 'Farida Khan', '9811144002');
  assert.equal((await call('POST', `/bookings/${bk2.body.id}/cancel`, { token: S.A.token, tenant: S.A.sub, body: { reason: 'Buyer withdrew' } })).status, 200);
  assert.equal((await call('GET', '/partner/commissions', { token: p1.token, tenant: S.A.sub })).body[0].status, 'cancelled', 'cancelled booking voids unpaid commission');

  await call('PATCH', `/channel-partners/${p1.id}`, { token: S.A.token, tenant: S.A.sub, body: { status: 'suspended' } });
  assert.equal((await call('POST', '/partner/auth/login', { tenant: S.A.sub, body: { email: p1.email, password: 'partner-pass-1' } })).status, 403);
  assert.equal((await call('GET', '/partner/leads', { token: p1.token, tenant: S.A.sub })).status, 403, 'suspension cuts off the portal, even for an already-issued token');
  assert.equal((await call('POST', '/partner/leads', { token: p1.token, tenant: S.A.sub, body: { name: 'New', phone: '9811144003' } })).status, 403, 'a suspended partner can\'t register buyers');
});


test('BILLING: GST invoices, a pay link, dunning to suspension, and payment brings the workspace back', async () => {
  const st = await call('PUT', '/platform/billing/settings', { token: S.superToken, body: { legal_name: 'HXG Connect Technologies Pvt Ltd',
    gstin: '07AAACE1234F1Z5', state_code: '07', address: 'Connaught Place, New Delhi', invoice_prefix: 'HXG', due_days: 7, grace_days: 15,
    bank_details: 'HDFC Bank, A/c 50200012345678, IFSC HDFC0000123' } });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal((await call('PUT', '/platform/billing/settings', { token: S.supportToken, body: {} })).status, 403);
  const blank = await call('PUT', '/platform/billing/settings', { token: S.superToken, body: { legal_name: '', address: '' } });
  assert.equal(blank.status, 400, 'GST settings can\'t be saved without the seller\'s name and address');
  assert.equal((await call('GET', '/platform/billing/settings', { token: S.superToken })).body.ready, true);
  await call('PUT', '/platform/integrations/razorpay_billing', { token: S.superToken,
    body: { config: { key_id: 'rzp_test_GoodKey123' }, secrets: { key_secret: 'good-secret', webhook_secret: 'whsec-platform-1' } } });
  await call('POST', `/platform/tenants/${S.A.id}/restore`, { token: S.superToken });          // trial over: paying client

  const bad = await call('PUT', '/billing/profile', { token: S.A.token, tenant: S.A.sub,
    body: { legal_name: 'Client A Realty LLP', gstin: '07ABCDE1234F1Z5', state_code: '09', email: 'accounts@clienta.in' } });
  assert.equal(bad.status, 400, 'a Delhi GSTIN can\'t be billed to Uttar Pradesh');
  assert.equal((await call('PUT', '/billing/profile', { token: S.A.token, tenant: S.A.sub,
    body: { legal_name: 'Client A Realty LLP', gstin: '09ABCDE1234F1Z5', state_code: '09', email: 'accounts@clienta.in', address: 'Sector 62, Noida' } })).status, 200);
  assert.equal((await call('GET', '/billing/invoices', { token: S.A.execToken, tenant: S.A.sub })).status, 403, 'billing is the owner\'s');

  assert.ok((await call('POST', '/platform/billing/run-invoices', { token: S.superToken, body: {} })).body.created >= 2);
  assert.equal((await call('POST', '/platform/billing/run-invoices', { token: S.superToken, body: {} })).body.created, 0, 're-running issues nothing twice');

  const invA = (await call('GET', '/billing/invoices', { token: S.A.token, tenant: S.A.sub })).body[0];
  assert.match(invA.number, /^HXG\/\d{2}-\d{2}\/\d{4}$/, 'GST-style serial within the financial year');
  assert.equal(Number(invA.total), 3536.46, '3 users × ₹999 + 18% IGST (Delhi to UP)');
  const page = async (token, ws, id) => (await fetch(`${base}/billing/invoices/${id}/html`, { headers: { authorization: `Bearer ${token}`, 'x-tenant': ws } }));
  const htmlA = await (await page(S.A.token, S.A.sub, invA.id)).text();
  assert.ok(htmlA.includes('Tax invoice') && htmlA.includes('GSTIN 09ABCDE1234F1Z5') && htmlA.includes('IGST @ 18%'));
  const invB = (await call('GET', '/billing/invoices', { token: S.B.token, tenant: S.B.sub })).body[0];
  assert.equal(Number(invB.total), 2944.10, '5 seats × ₹499 + 9% CGST + 9% SGST (no profile: billed in Delhi)');
  assert.ok((await (await page(S.B.token, S.B.sub, invB.id)).text()).includes('CGST @ 9%'));
  assert.equal((await page(S.B.token, S.B.sub, invA.id)).status, 404, 'B can\'t open A\'s invoice');

  const pay = await call('POST', `/billing/invoices/${invA.id}/pay`, { token: S.A.token, tenant: S.A.sub });
  assert.equal(pay.body.url, 'https://rzp.io/i/T3st');
  assert.equal(lastLink.amount, 353646, 'charged in paise on your own Razorpay account');

  await asDb(OWNER_URL, c => c.query(`UPDATE platform.invoices SET due_date = current_date - 3 WHERE id = $1`, [invA.id]));
  assert.ok((await call('POST', '/platform/billing/run-dunning', { token: S.superToken })).body.past_due >= 1);
  assert.equal((await call('GET', '/me', { token: S.A.token, tenant: S.A.sub })).body.workspace.status, 'past_due', 'past due: still working, with a banner');
  await asDb(OWNER_URL, c => c.query(`UPDATE platform.invoices SET due_date = current_date - 20 WHERE id = $1`, [invA.id]));
  assert.ok((await call('POST', '/platform/billing/run-dunning', { token: S.superToken })).body.suspended >= 1);
  assert.equal((await call('GET', '/leads', { token: S.A.execToken, tenant: S.A.sub })).body.code, 'workspace_suspended');
  assert.equal((await call('POST', '/auth/login', { tenant: S.A.sub, body: { email: `arjun@${S.A.sub}.com`, password: 'arjun-password-1' } })).status, 403);
  assert.equal((await call('GET', '/billing/invoices', { token: S.A.token, tenant: S.A.sub })).status, 200, 'the owner can still reach billing');
  assert.equal((await call('GET', '/leads', { token: S.A.token, tenant: S.A.sub })).status, 403, 'and nothing else');

  const payload = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { notes: { invoice_id: invA.id, tenant_id: S.A.id } } },
    payment: { entity: { id: `pay_bill_${RUN}`, amount: 353646 } } } });
  const hook = sig => fetch(`${base}/webhooks/platform/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: payload });
  assert.equal((await hook('0'.repeat(64))).status, 403);
  const sig = createHmac('sha256', 'whsec-platform-1').update(payload).digest('hex');
  assert.equal((await hook(sig)).status, 200);
  assert.equal((await hook(sig)).status, 200, 'replay is harmless');
  assert.equal((await call('GET', '/billing/invoices', { token: S.A.token, tenant: S.A.sub })).body[0].status, 'paid');
  assert.equal((await call('GET', '/leads', { token: S.A.execToken, tenant: S.A.sub })).status, 200, 'payment lifted the suspension automatically');

  assert.equal((await call('POST', `/platform/billing/invoices/${invB.id}/mark-paid`, { token: S.supportToken, body: { reference: 'UTR 1' } })).status, 403);
  assert.equal((await call('POST', `/platform/billing/invoices/${invB.id}/mark-paid`, { token: S.superToken, body: { reference: 'NEFT UTR HDFC000123' } })).status, 200);
  assert.equal((await call('POST', `/platform/billing/invoices/${invB.id}/mark-paid`, { token: S.superToken, body: { reference: 'again' } })).status, 400);
});


test('TLS GATE: certificates only for your domain, admin., and existing workspaces', async () => {
  const ask = async d => (await fetch(`${base}/public/tls-allowed?domain=${d}`)).status;
  assert.equal(await ask('hxgconnect.test'), 403, 'no domain configured: nothing is allowed');
  await call('PUT', '/platform/settings/domain', { token: S.superToken, body: { base_domain: 'hxgconnect.test' } });
  assert.equal(await ask('hxgconnect.test'), 200);
  assert.equal(await ask('admin.hxgconnect.test'), 200);
  assert.equal(await ask(`${S.A.sub}.hxgconnect.test`), 200, 'a real workspace gets a certificate');
  assert.equal(await ask('random-attacker-name.hxgconnect.test'), 403, 'made-up subdomains are refused');
  assert.equal(await ask('evil.example.com'), 403);
  await call('PUT', '/platform/settings/domain', { token: S.superToken, body: { base_domain: null } });
});


test('PASSWORDS: forgot never reveals accounts; reset links are single-use; change needs the current password', async () => {
  const f1 = await call('POST', '/auth/forgot', { tenant: S.A.sub, body: { email: `arjun@${S.A.sub}.com` } });
  const f2 = await call('POST', '/auth/forgot', { tenant: S.A.sub, body: { email: `nobody@${S.A.sub}.com` } });
  assert.deepEqual(f1.body, f2.body, 'identical reply for real and unknown accounts');
  assert.equal((await call('POST', `/users/${S.A.execId}/reset-link`, { token: S.A.execToken, tenant: S.A.sub })).status, 403, 'executives can\'t reset others');
  const link = (await call('POST', `/users/${S.A.execId}/reset-link`, { token: S.A.token, tenant: S.A.sub })).body.reset_link;
  const token = new URLSearchParams(link.split('#')[1]).get('token');
  assert.equal((await call('POST', '/auth/reset', { body: { token, password: 'arjun-new-pass-2026' } })).status, 200);
  assert.equal((await call('POST', '/auth/reset', { body: { token, password: 'second-use-attempt-1' } })).status, 400, 'link dies after one use');
  const login = await call('POST', '/auth/login', { tenant: S.A.sub, body: { email: `arjun@${S.A.sub}.com`, password: 'arjun-new-pass-2026' } });
  assert.equal(login.status, 200);
  assert.equal((await call('PATCH', '/me/password', { token: login.body.token, tenant: S.A.sub, body: { current: 'wrong-one', password: 'arjun-third-pass-1' } })).body.code, 'wrong_password');
  assert.equal((await call('PATCH', '/me/password', { token: login.body.token, tenant: S.A.sub, body: { current: 'arjun-new-pass-2026', password: 'arjun-password-1' } })).status, 200, 'restored for later tests');
  assert.equal((await call('PATCH', '/platform/me/password', { token: S.supportToken, body: { current: 'nope', password: 'whatever-long-1' } })).status, 400);
});


test('FEATURE SWITCHES: super admin turns calling, or just recordings, off for one client', async () => {
  const set = f => call('PATCH', `/platform/tenants/${S.A.id}/overrides`, { token: S.superToken, body: { features: f } });
  assert.equal((await call('POST', '/calls/click-to-call', { token: S.B.token, tenant: S.B.sub, body: { lead_id: S.A.leadId } })).body.code, 'feature_not_in_plan', 'Starter plan: no calling');
  assert.equal((await call('PATCH', `/platform/tenants/${S.A.id}/overrides`, { token: S.supportToken, body: { features: { telephony: false } } })).status, 403);

  const hookList = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  const hookUrl = origin + new URL(hookList.body.find(i => i.provider === 'twilio').webhook.url).pathname;   // captured while calling is on
  await set({ telephony: false });
  const d = (await call('GET', `/platform/tenants/${S.A.id}`, { token: S.superToken })).body;
  assert.deepEqual([d.features.telephony, d.plan_features.telephony], [false, true], 'their plan includes it; this client is switched off');
  assert.equal((await call('POST', '/calls/click-to-call', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId } })).body.code, 'feature_not_in_plan');
  const integ = await call('GET', '/integrations', { token: S.A.token, tenant: S.A.sub });
  assert.ok(!integ.body.some(i => i.category === 'calling'), 'calling providers hidden from their settings');
  assert.equal((await call('PUT', '/integrations/exotel', { token: S.A.token, tenant: S.A.sub, body: {} })).status, 403);
  const stray = { CallSid: 'CA777', CallStatus: 'no-answer', Direction: 'inbound', From: '+919876511111', To: '+14155550100' };
  const r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twSign(hookUrl, stray) }, body: new URLSearchParams(stray) });
  assert.equal(r.status, 200, 'provider gets a normal reply, so it stops retrying');
  assert.equal((await findLead('9876511111')).length, 0, 'a stray provider callback logs nothing');

  await set({ telephony: true, call_recording: false });
  const c = await call('POST', '/calls/click-to-call', { token: S.A.token, tenant: S.A.sub, body: { lead_id: S.A.leadId } });
  assert.equal(c.status, 201);
  assert.ok(!/record=/.test(lastTwilio.Twiml), 'call placed with recording off at the provider');
  assert.equal((await twilioHook({ CallSid: c.body.provider_call_id, CallStatus: 'completed', CallDuration: '20', Direction: 'outbound-api', RecordingUrl: `${mockBase}/recordings/RE1` })).status, 200);
  const stored = await asDb(OWNER_URL, q => q.query(`SELECT recording_url FROM calls WHERE id = $1`, [c.body.id]));
  assert.equal(stored.rows[0].recording_url, null, 'a recording the provider made anyway is never stored');
  assert.ok((await call('GET', `/calls?lead_id=${S.A.leadId}`, { token: S.A.token, tenant: S.A.sub })).body.every(x => !x.has_recording), 'old recordings hidden');
  const old = (await asDb(OWNER_URL, q => q.query(`SELECT id FROM calls WHERE tenant_id = $1 AND recording_url IS NOT NULL LIMIT 1`, [S.A.id]))).rows[0];
  assert.equal((await fetch(`${base}/calls/${old.id}/recording`, { headers: { authorization: `Bearer ${S.A.token}`, 'x-tenant': S.A.sub } })).status, 403, 'and not playable');
  await set({ telephony: true, call_recording: true });
});


test('PORTALS: pushed and forwarded portal enquiries become leads; unreadable ones wait for review', async () => {
  const saved = await call('PUT', '/integrations/property_portals', { token: S.A.token, tenant: S.A.sub, body: {} });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const to = saved.body.webhook.email;
  assert.match(to, /^[a-f0-9]{20}@leads\.hxgconnect\.test$/, 'a private forwarding address for this client');
  const pushUrl = p => origin + new URL(saved.body.webhook.url.replace('{portal}', p)).pathname;

  const r1 = await fetch(pushUrl('99acres'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead: {
    Name: 'Rahul Verma', 'Mobile No': '+91-98123 45678', Email: 'rahul@example.com', 'Project Name': 'Sunrise Heights', Query: '3BHK price?' } }) });
  assert.deepEqual([r1.status, (await r1.json()).message], [200, 'Lead added'], 'the reply an account manager checks');
  assert.equal((await findLead('Rahul Verma'))[0].source, '99acres', 'their field names, nested, still understood');
  const r2 = await fetch(pushUrl('magicbricks'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ contact_name: 'Rahul V', mobile: '9812345678' }) });
  assert.equal((await r2.json()).message, 'Existing lead updated');
  assert.equal((await findLead('9812345678')).length, 1, 'the same buyer from two portals stays one lead');
  const bad = await fetch(pushUrl('housing'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No Number' }) });
  assert.deepEqual([bad.status, (await bad.json()).status], [422, 'failed'], 'an unreadable push says so, so setup problems show up immediately');
  const tl = await call('POST', '/portal-leads/test/magicbricks', { token: S.A.token, tenant: S.A.sub });
  assert.equal(tl.body.status, 'success');
  assert.deepEqual((await findLead('Test lead from MagicBricks'))[0].tags, ['test'], 'test leads are tagged so they are easy to clear out');
  const log = (await call('GET', '/portal-leads/deliveries', { token: S.A.token, tenant: S.A.sub })).body;
  assert.ok(log.some(x => x.portal === '99acres' && x.result === 'created' && /Rahul Verma, \+•+5678/.test(x.summary)), 'delivery log, with the number masked');
  assert.ok(log.some(x => x.portal === 'housing' && !x.processed));
  assert.equal((await fetch(pushUrl('notaportal'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);

  const inbound = (fields, { json = false, secret = 'inbound-secret-1' } = {}) => fetch(`${base}/webhooks/inbound-email?secret=${secret}`, json
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) }
    : { method: 'POST', body: Object.entries(fields).reduce((f, [k, v]) => (f.append(k, v), f), new FormData()) });
  assert.equal((await inbound({ to, from: 'x', subject: 'x', text: 'x' }, { secret: 'wrong-secret-xyz' })).status, 403);
  assert.equal((await inbound({ to: `Sunrise Sales <${to}>`, from: '99acres <noreply@99acres.com>', subject: 'You have received a new response',
    text: 'Dear Advertiser,\nName: Sunita Iyer\nMobile: 9876501234\nEmail: sunita@example.com\nProject: Sunrise Heights\nMessage: Looking for a 2BHK on a higher floor\nRegards, 99acres' })).status, 200);
  assert.equal((await findLead('Sunita Iyer'))[0].source, '99acres', 'SendGrid-style forwarded email read');
  await inbound({ To: to, From: 'Housing.com <leads@housing.com>', Subject: 'New lead for your project',
    HtmlBody: '<table><tr><td>Name</td><td>: Arvind Rao</td></tr><tr><td>Phone</td><td>: +91 99001 22334</td></tr></table>' }, { json: true });
  assert.equal((await findLead('Arvind Rao'))[0]?.source, 'housing', 'Postmark-style HTML-only email read');

  await inbound({ to, from: 'MagicBricks <alerts@magicbricks.com>', subject: 'Someone viewed your listing', text: 'A buyer viewed your property today.' });
  await inbound({ to, from: 'Gmail Team <forwarding-noreply@google.com>', subject: '(#123456789) Gmail Forwarding Confirmation', text: 'Confirmation code: 123456789' });
  const rev = (await call('GET', '/portal-leads/review', { token: S.A.token, tenant: S.A.sub })).body;
  assert.ok(rev.some(x => x.portal === 'magicbricks' && /No Indian mobile/.test(x.reason)), 'an unreadable email is kept for review, not lost');
  assert.ok(rev.some(x => x.event_type === 'gmail_forwarding_confirmation' && /123456789/.test(x.excerpt)), 'Gmail\'s confirmation code is shown to the client');
  assert.equal((await call('GET', '/portal-leads/review', { token: S.B.token, tenant: S.B.sub })).body.length, 0, 'B sees none of it');
});

test('DIRECTORY: super admin sees usage counts, never lead rows', async () => {
  const d = await call('GET', `/platform/tenants?q=${RUN}`, { token: S.superToken });
  assert.equal(d.status, 200);
  const a = d.body.find(t => t.id === S.A.id);
  const all = await call('GET', '/leads?limit=200', { token: S.A.token, tenant: S.A.sub });
  assert.equal(a.leads, all.body.data.length, 'directory count matches the workspace');
  assert.equal(a.users, 3);
  assert.equal(a.plan_code, 'growth');
  assert.ok(!('name' in (a.leads_sample ?? {})), 'no lead content in the directory');
});

test('RATE LIMIT: the 11th sign-in attempt for one account gets 429', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await call('POST', '/auth/login', { tenant: S.A.sub, body: { email: `brute-${RUN}@x.com`, password: `guess${i}` } });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'rate_limited');
});

// ------------------------------------------------------------------
// VISIBILITY: one company, two sales teams (team one has a sub-team), a
// support agent and a marketing user. Every test below tries to see across
// a boundary the role presets and PRD §5 promise.
const V = {};
const as = who => ({ token: V[who], tenant: V.sub });
const names = async who => (await call('GET', '/leads?limit=200', as(who))).body.data.map(l => l.name).sort();
const soon = () => new Date(Date.now() + 3600e3).toISOString();

test('VISIBILITY: set up two teams, a sub-team, support and marketing', async () => {
  V.sub = `v${RUN}`;
  const r = await call('POST', '/platform/tenants', { token: S.superToken, body: {
    name: 'Client V Homes', subdomain: V.sub, plan_code: 'growth', owner: { name: 'Owner V', email: `owner@${V.sub}.com` } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  V.tid = r.body.tenant.id;
  const o = await call('POST', '/auth/accept-invite', { body: { token: r.body.owner_invite_token, password: 'owner-password-1' } });
  V.owner = o.body.token; V.ownerId = o.body.user.id;
  async function hire(key, name, role, manager) {
    const inv = await call('POST', '/users', { ...as('owner'), body: { name, email: `${key}@${V.sub}.com`, role, manager_id: manager ? V[`${manager}Id`] : undefined } });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const acc = await call('POST', '/auth/accept-invite', { body: { token: inv.body.invite_token, password: `${key}-password-1` } });
    V[key] = acc.body.token; V[`${key}Id`] = acc.body.user.id;
  }
  await hire('tl1', 'Meera Lead One', 'team_leader');
  await hire('tl2', 'Kabir Lead Two', 'team_leader');
  await hire('tlsub', 'Ishaan Sub Lead', 'team_leader', 'tl1');      // a team inside team one
  await hire('e1', 'Ravi Exec One', 'sales_executive', 'tl1');
  await hire('e2', 'Sana Exec Two', 'sales_executive', 'tl2');
  await hire('e1b', 'Dev Exec Sub', 'sales_executive', 'tlsub');
  await hire('sup', 'Nisha Support', 'support');
  await hire('mkt', 'Omar Marketing', 'marketing');

  const lead = async (name, phone, owner) => {
    const l = await call('POST', '/leads', { ...as('owner'), body: { name, phone, source: 'walk_in', budget_max: 6500000, owner_id: V[`${owner}Id`] } });
    assert.equal(l.status, 201, JSON.stringify(l.body));
    return l.body.id;
  };
  V.L1 = await lead('Buyer of Team One', '9810000001', 'e1');
  V.L2 = await lead('Buyer of Team Two', '9810000002', 'e2');
  V.L3 = await lead('Buyer of Sub Team', '9810000003', 'e1b');
  V.L4 = await lead('Buyer of Owner', '9810000004', 'owner');
  const nobody = await call('POST', '/leads', { ...as('owner'), body: { name: 'Ghost owner', phone: '9810000099', owner_id: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(nobody.status, 400, 'a lead can only be given to a live member of this workspace');
});

test('VISIBILITY: leads, board and dashboard follow the team, not the whole company', async () => {
  assert.deepEqual(await names('e1'), ['Buyer of Team One']);
  assert.deepEqual(await names('e2'), ['Buyer of Team Two']);
  assert.deepEqual(await names('tl1'), ['Buyer of Sub Team', 'Buyer of Team One'], 'team leader: their team, including the team under them');
  assert.deepEqual(await names('tlsub'), ['Buyer of Sub Team']);
  assert.deepEqual(await names('tl2'), ['Buyer of Team Two'], 'the other team leader sees nothing of team one');
  assert.equal((await names('owner')).length, 4);
  assert.equal((await names('mkt')).length, 4, 'marketing reads every lead (PRD: Read)');
  assert.deepEqual(await names('sup'), [], 'support sees booked customers only, and nobody has booked yet');

  for (const path of [`/leads/${V.L1}`, `/follow-ups?lead_id=${V.L1}`, `/whatsapp/messages?lead_id=${V.L1}`, `/units/match?lead_id=${V.L1}`]) {
    assert.equal((await call('GET', path, as('tl2'))).status, 404, `another team leader: ${path.split('?')[0]} is "not found"`);
    assert.equal((await call('GET', path, as('e2'))).status, 404, `another executive: ${path.split('?')[0]} is "not found"`);
    assert.equal((await call('GET', path, as('tl1'))).status, 200, `own team leader: ${path.split('?')[0]} opens`);
  }
  const note = await call('POST', `/leads/${V.L1}/notes`, { ...as('tl2'), body: { body: 'peeking' } });
  assert.equal(note.status, 404, 'nor can another team write on it');

  const pipe = (await call('GET', '/pipelines', as('owner'))).body[0].id;
  const onBoard = async who => (await call('GET', `/pipelines/${pipe}/board`, as(who))).body.reduce((n, st) => n + st.count, 0);
  assert.deepEqual([await onBoard('tl1'), await onBoard('tl2'), await onBoard('owner')], [2, 1, 4]);
  const dash = async who => (await call('GET', '/dashboard/summary', as(who))).body.leads.open;
  assert.deepEqual([await dash('tl1'), await dash('tl2'), await dash('e1b'), await dash('owner')], [2, 1, 1, 4]);
});

test('VISIBILITY: a follow-up handed to someone opens that lead for them, until it is done', async () => {
  const hand = await call('POST', '/follow-ups', { ...as('e1'), body: { lead_id: V.L1, type: 'call', due_at: soon(), assigned_to: V.e2Id, note: 'Prefers Tamil, please call' } });
  assert.equal(hand.status, 201, JSON.stringify(hand.body));
  assert.ok((await call('GET', '/follow-ups/my-day', as('e2'))).body.length >= 0);
  assert.equal((await call('GET', `/leads/${V.L1}`, as('e2'))).status, 200, 'the person handed the job can open the lead');
  assert.deepEqual(await names('e2'), ['Buyer of Team Two'], 'without it joining their lead list');
  const done = await call('POST', `/follow-ups/${hand.body.id}/complete`, { ...as('e2'),
    body: { outcome: 'Spoke in Tamil, wants a visit', next: { type: 'site_visit', due_at: soon(), assigned_to: V.e1Id } } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await call('GET', `/leads/${V.L1}`, as('e2'))).status, 404, 'job done, access ends');
});

test('VISIBILITY: calls, recordings and WhatsApp chats stay with the team', async () => {
  V.call1 = (await asDb(OWNER_URL, c => c.query(
    `INSERT INTO calls (tenant_id, lead_id, user_id, provider, provider_call_id, direction, status, duration_sec, recording_url)
     VALUES ($1,$2,$3,'twilio','CA-vis-1','outbound','completed',95,$4) RETURNING id`, [V.tid, V.L1, V.e1Id, `${mockBase}/recordings/open.mp3`]))).rows[0].id;
  await asDb(OWNER_URL, c => c.query(`INSERT INTO wa_messages (tenant_id, lead_id, direction, body, status) VALUES ($1,$2,'in','Is the 3BHK still available?','received')`, [V.tid, V.L1]));

  const callIds = async who => (await call('GET', '/calls', as(who))).body.map(x => x.id);
  assert.ok((await callIds('tl1')).includes(V.call1));
  assert.ok(!(await callIds('tl2')).includes(V.call1), 'another team leader does not see the call');
  assert.ok(!(await callIds('e2')).includes(V.call1));
  assert.equal((await call('GET', `/calls/${V.call1}/recording`, as('tl2'))).status, 404, 'or play its recording');
  const play = await fetch(`${base}/calls/${V.call1}/recording`, { headers: { authorization: `Bearer ${V.tl1}`, 'x-tenant': V.sub } });
  assert.equal(play.status, 200, 'their own team leader can');
  assert.equal((await call('POST', `/calls/${V.call1}/disposition`, { ...as('tl2'), body: { disposition: 'interested' } })).status, 404);
  assert.equal((await call('POST', `/calls/${V.call1}/disposition`, { ...as('tl1'), body: { disposition: 'interested' } })).status, 200);

  const chats = async who => (await call('GET', '/whatsapp/conversations', as(who))).body.map(x => x.lead_id);
  assert.deepEqual(await chats('tl1'), [V.L1]);
  assert.deepEqual(await chats('tl2'), [], 'another team\'s WhatsApp chats stay hidden');
});

test('VISIBILITY: unit holds hide other teams\' buyers; support sees customers once they book', async () => {
  const p = await call('POST', '/projects', { ...as('owner'), body: { name: 'Vista Greens', city: 'Noida' } });
  const t = await call('POST', `/projects/${p.body.id}/towers`, { ...as('owner'), body: { name: 'A', floors: 2, floor_rise: 0,
    layout: [{ unit_type: '2BHK', super_sqft: 1100, base_price: 6000000 }] } });
  const plan = await call('POST', `/projects/${p.body.id}/payment-plans`, { ...as('owner'), body: { name: 'Down payment',
    milestones: [{ label: 'On booking', percent: 100, due_days: 0 }] } });
  const unit = (await call('GET', `/towers/${t.body.id}/units`, as('owner'))).body[0];

  const h = await call('POST', `/units/${unit.id}/hold`, { ...as('e2'), body: { lead_id: V.L2, hours: 24 } });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const seen = async who => (await call('GET', `/towers/${t.body.id}/units`, as(who))).body.find(u => u.id === unit.id);
  const other = await seen('tl1');
  assert.deepEqual([other.status, other.hold_lead_name, other.hold_lead_id, other.hold_by_name], ['hold', null, null, 'Sana Exec Two'],
    'other teams see the unit is held, and by whom, but not for which buyer');
  assert.equal((await seen('tl2')).hold_lead_name, 'Buyer of Team Two');
  assert.equal((await call('POST', `/units/${unit.id}/hold`, { ...as('tl1'), body: { lead_id: V.L2 } })).status, 404, 'cannot hold for another team\'s buyer');

  const bk = await call('POST', '/bookings', { ...as('owner'), body: { lead_id: V.L2, unit_id: unit.id, payment_plan_id: plan.body.id,
    agreed_price: 6000000, applicant: { name: 'Buyer of Team Two', phone: '9810000002' } } });
  assert.equal(bk.status, 201, JSON.stringify(bk.body));
  assert.deepEqual(await names('sup'), ['Buyer of Team Two'], 'support now sees the customer, and only the customer');
  assert.equal((await call('GET', `/leads/${V.L1}`, as('sup'))).status, 404);
  const bookings = async who => (await call('GET', '/bookings', as(who))).body.length;
  assert.deepEqual([await bookings('tl1'), await bookings('tl2'), await bookings('sup'), await bookings('owner')], [0, 1, 1, 1]);
  assert.equal((await call('GET', `/bookings/${bk.body.id}`, as('tl1'))).status, 404);
  assert.equal((await call('GET', `/bookings/${bk.body.id}`, as('tl2'))).status, 200);
});

test('VISIBILITY: the Team page is for managers; a team leader sees only their team', async () => {
  for (const who of ['e1', 'sup', 'mkt']) assert.equal((await call('GET', '/users', as(who))).status, 403, `${who} gets no staff list`);
  assert.deepEqual((await call('GET', '/users', as('tl1'))).body.map(u => u.name).sort(),
    ['Dev Exec Sub', 'Ishaan Sub Lead', 'Meera Lead One', 'Ravi Exec One']);
  assert.deepEqual((await call('GET', '/users', as('tl2'))).body.map(u => u.name).sort(), ['Kabir Lead Two', 'Sana Exec Two']);
  assert.equal((await call('GET', '/users', as('owner'))).body.length, 9);

  const team = (await call('GET', '/reports/team', as('tl1'))).body.rows.map(r => r.name).sort();
  assert.deepEqual(team, ['Dev Exec Sub', 'Ishaan Sub Lead', 'Meera Lead One', 'Ravi Exec One'], 'team report covers the whole team');
  const sources = async who => (await call('GET', '/reports/lead_sources', as(who))).body.totals?.leads ?? 0;
  assert.deepEqual([await sources('tl1'), await sources('tl2'), await sources('mkt')], [2, 1, 4], 'a team leader\'s reports count their team\'s leads, not just their own');
});

test('VISIBILITY: field check-ins go to your own team leader only, and never under someone else\'s login', async () => {
  const at = new Date().toISOString();
  const ci = await checkIn(V.e1, V.sub, { type: 'day_start', lat: 28.57, lng: 77.32, accuracy_m: 8, captured_at: at, taken_by: V.e1Id });
  assert.equal(ci.status, 201, JSON.stringify(ci.body));
  const feed = async who => (await call('GET', '/field/check-ins', as(who))).body.map(c => c.id);
  assert.ok((await feed('tl1')).includes(ci.body.id));
  assert.ok(!(await feed('tl2')).includes(ci.body.id), 'the other team leader does not see it');
  assert.ok(!(await feed('mkt')).includes(ci.body.id), 'company-wide lead access does not mean company-wide selfies');
  assert.equal((await call('POST', `/field/check-ins/${ci.body.id}/review`, { ...as('tl2'), body: { decision: 'rejected' } })).status, 404);

  const wrong = await checkIn(V.e2, V.sub, { type: 'day_start', lat: 28.57, lng: 77.32, captured_at: at, taken_by: V.e1Id });
  assert.equal(wrong.status, 409, 'a check-in queued by Ravi cannot be sent under Sana\'s login');
  assert.equal(wrong.body.code, 'checkin_wrong_user');
});

test('VISIBILITY: team moves, role changes and deactivation apply on the next request', async () => {
  const move = await call('PATCH', `/users/${V.e2Id}`, { ...as('owner'), body: { manager_id: V.tl1Id } });
  assert.equal(move.status, 200);
  assert.deepEqual(await names('tl2'), [], 'Sana moved to team one: Kabir no longer sees her buyers');
  assert.ok((await names('tl1')).includes('Buyer of Team Two'));

  await call('PATCH', `/users/${V.tlsubId}`, { ...as('owner'), body: { role: 'sales_executive' } });
  assert.deepEqual(await names('tlsub'), [], 'demoted, with an old token, and already limited to their own leads');

  await call('PATCH', `/users/${V.e1bId}`, { ...as('owner'), body: { status: 'inactive' } });
  const gone = await call('GET', '/leads', as('e1b'));
  assert.equal(gone.status, 401, 'a deactivated person is signed out on their next click, not when the token expires');
  assert.equal(gone.body.code, 'account_inactive');
  const ghost = await call('POST', '/follow-ups', { ...as('owner'), body: { lead_id: V.L3, type: 'call', due_at: soon(), assigned_to: V.e1bId } });
  assert.equal(ghost.status, 400, 'and nobody can hand them work');
});

// ------------------------------------------------------------------
// LEAD CONNECTORS: each platform posts in its own shape. These payloads
// follow the platforms' documented formats.
const C = {};
const leadOf = async q => { const l = (await findLead(q))[0]; return l && (await call('GET', `/leads/${l.id}`, { token: S.A.token, tenant: S.A.sub })).body; };
const post = (source, body, headers = {}, qs = '') => fetch(C.url(source) + qs, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('CONNECTORS: WordPress and Elementor forms arrive whatever the fields are called', async () => {
  const saved = await call('PUT', '/integrations/lead_connectors', { token: S.A.token, tenant: S.A.sub, body: {} });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.webhook.url, /\/api\/webhooks\/in\/\{source\}\/[\w-]{24,}$/);
  C.url = s => origin + new URL(saved.body.webhook.url.replace('{source}', s)).pathname;

  // What the HXG Connect Leads plugin sends for a Contact Form 7 form.
  const wp = await post('wordpress', { plugin: 'contact-form-7', form_name: 'Book a site visit', page_url: 'https://sunriseheights.in/contact',
    utm_source: 'google', fields: { 'your-name': 'Anita Desai', 'your-email': 'Anita@Example.com', 'your-tel': '70201 55667', 'your-message': 'Need a 2BHK under 85L', 'acceptance-1': '1' } });
  assert.deepEqual([wp.status, (await wp.json()).message], [200, 'Lead added']);
  const a = await leadOf('Anita Desai');
  assert.deepEqual([a.source, a.primary_phone, a.email], ['wordpress', '+917020155667', 'anita@example.com']);
  assert.equal(a.custom_fields.formname, 'Book a site visit');
  assert.equal(a.custom_fields.utmsource, 'google');

  // Elementor Pro's own Webhook action with "Advanced data": bracketed form fields.
  const el = new URLSearchParams({ 'form[id]': 'a1b2c3', 'form[name]': 'Brochure form',
    'fields[name][id]': 'name', 'fields[name][type]': 'text', 'fields[name][title]': 'Name', 'fields[name][value]': 'Kiran Rao',
    'fields[field_9f2][id]': 'field_9f2', 'fields[field_9f2][type]': 'tel', 'fields[field_9f2][title]': 'Mobile No.', 'fields[field_9f2][value]': '07020011223',
    'fields[email][id]': 'email', 'fields[email][title]': 'Email', 'fields[email][value]': 'kiran@example.com',
    'meta[page_url][title]': 'Page URL', 'meta[page_url][value]': 'https://sunriseheights.in/brochure' });
  const r = await fetch(C.url('wordpress'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: el });
  assert.equal(r.status, 200, await r.clone().text());
  const k = await leadOf('Kiran Rao');
  assert.ok(k, 'the buyer\'s name, not the form\'s name ("Brochure form")');
  assert.equal(k.primary_phone, '+917020011223', 'found the number under a field called "Mobile No."');

  const none = await post('wordpress', { fields: { 'your-name': 'No Number', 'your-email': 'x@example.com' } });
  assert.deepEqual([none.status, (await none.json()).status], [422, 'failed'], 'the plugin is told when a lead can\'t be read');
});

test('CONNECTORS: Shopify customers and orders, signed, with retries ignored', async () => {
  const { createHmac } = await import('node:crypto');
  const secret = 'shpss_test_signing_secret';
  await call('PUT', '/integrations/lead_connectors', { token: S.A.token, tenant: S.A.sub, body: { secrets: { shopify_secret: secret } } });
  const sign = raw => createHmac('sha256', secret).update(raw).digest('base64');
  const customer = JSON.stringify({ id: 706405506930370000, email: 'meera@example.com', first_name: 'Meera', last_name: 'Nair', phone: '+917045012345',
    note: 'Asked about bulk pricing', tags: 'wholesale', addresses: [{ phone: '+911111111111', city: 'Kochi' }], default_address: { city: 'Kochi', phone: '+911111111111' } });
  const h = raw => ({ 'x-shopify-topic': 'customers/create', 'x-shopify-hmac-sha256': sign(raw), 'x-shopify-webhook-id': 'wh-0001' });

  assert.equal((await post('shopify', customer, { 'x-shopify-topic': 'customers/create' })).status, 401, 'unsigned post refused once the secret is saved');
  assert.equal((await post('shopify', customer, { ...h(customer), 'x-shopify-hmac-sha256': sign(customer + ' ') })).status, 401);
  const ok = await post('shopify', customer, h(customer));
  assert.deepEqual([ok.status, (await ok.json()).message], [200, 'Lead added']);
  const m = await leadOf('Meera Nair');
  assert.deepEqual([m.source, m.primary_phone, m.preferred_locations], ['shopify', '+917045012345', ['Kochi']]);
  const before = m.timeline?.length ?? m.activities?.length;
  assert.equal((await (await post('shopify', customer, h(customer))).json()).message, 'Already received', 'Shopify retried: nothing added twice');
  const after = await leadOf('Meera Nair');
  assert.equal(after.timeline?.length ?? after.activities?.length, before);

  const order = JSON.stringify({ id: 820982911946154500, name: '#1001', email: 'arjun@example.com', phone: null, total_price: '4999.00', currency: 'INR',
    customer: { first_name: 'Arjun', last_name: 'Menon', email: 'arjun@example.com', phone: null },
    billing_address: { name: 'Arjun Menon', phone: '70470 12345', city: 'Thrissur' },
    line_items: [{ title: 'Brass door handle', name: 'Brass door handle - Antique', quantity: 2 }] });
  const o = await post('shopify', order, { 'x-shopify-topic': 'orders/create', 'x-shopify-hmac-sha256': sign(order), 'x-shopify-webhook-id': 'wh-0002' });
  assert.equal(o.status, 200);
  const ar = await leadOf('Arjun Menon');
  assert.ok(ar, 'the customer is the lead, not order "#1001" or the product');
  assert.equal(ar.primary_phone, '+917047012345', 'phone taken from the billing address');

  const emailOnly = JSON.stringify({ id: 1, email: 'newsletter@example.com', first_name: 'News', last_name: 'Letter', phone: null });
  const held = await post('shopify', emailOnly, { 'x-shopify-topic': 'customers/create', 'x-shopify-hmac-sha256': sign(emailOnly), 'x-shopify-webhook-id': 'wh-0003' });
  assert.deepEqual([held.status, (await held.json()).status], [200, 'held'], 'answered 200 so Shopify keeps the webhook; the entry waits for review');
});

test('CONNECTORS: IndiaMART, JustDial, Typeform, Jotform and Tally in their own formats', async () => {
  const im = { CODE: 200, STATUS: 'SUCCESS', RESPONSE: { UNIQUE_QUERY_ID: '2012487827', QUERY_TYPE: 'W', QUERY_TIME: '2026-11-12 10:22:31',
    SENDER_NAME: 'Suresh Patel', SENDER_MOBILE: '+91-7098012345', SENDER_EMAIL: 'suresh@example.com', SUBJECT: 'Requirement for housekeeping trolleys',
    SENDER_COMPANY: 'Patel Hospitality', SENDER_CITY: 'Ahmedabad', SENDER_STATE: 'Gujarat', SENDER_MOBILE_ALT: '+91-9000000001', RECEIVER_MOBILE: '+91-9000000002',
    QUERY_PRODUCT_NAME: 'Housekeeping trolley', QUERY_MESSAGE: 'Need 20 units, share best price', QUERY_MCAT_NAME: 'Hotel trolleys', CALL_DURATION: '' } };
  const r = await post('indiamart', im);
  assert.deepEqual([r.status, (await r.json()).message], [200, 'Lead added']);
  const s = await leadOf('Suresh Patel');
  assert.deepEqual([s.source, s.primary_phone, s.custom_fields.company, s.custom_fields.enquired_about, s.custom_fields.enquirytype],
    ['indiamart', '+917098012345', 'Patel Hospitality', 'Housekeeping trolley', 'Direct enquiry'], 'the buyer\'s number, never the seller\'s own (RECEIVER_MOBILE)');
  assert.equal((await (await post('indiamart', im)).json()).message, 'Already received', 'IndiaMART retries by UNIQUE_QUERY_ID');

  const jd = await fetch(C.url('justdial') + '?' + new URLSearchParams({ leadid: 'JD778812', leadtype: 'company', prefix: 'Mr', name: 'Imran Khan',
    mobile: '7011122233', phone: '', email: 'imran@example.com', date: '2026-11-12', category: 'Estate Agents', city: 'Delhi', area: 'Dwarka', dncmobile: '0' }));
  assert.deepEqual([jd.status, await jd.text()], [200, 'RECEIVED'], 'JustDial delivers by GET and expects this word back');
  const i = await leadOf('Imran Khan');
  assert.deepEqual([i.source, i.primary_phone], ['justdial', '+917011122233']);

  const tf = await post('typeform', { event_id: '01HTF', event_type: 'form_response', form_response: { form_id: 'lT4Z3j', hidden: { utm_source: 'instagram' },
    definition: { title: 'Site visit request', fields: [{ id: 'f1', title: 'What is your full name?', type: 'short_text' }, { id: 'f2', title: 'Best number to reach you', type: 'phone_number' },
      { id: 'f3', title: 'Which project?', type: 'multiple_choice' }] },
    answers: [{ type: 'text', text: 'Divya Iyer', field: { id: 'f1', type: 'short_text' } }, { type: 'phone_number', phone_number: '+917000112233', field: { id: 'f2', type: 'phone_number' } },
      { type: 'choice', choice: { label: 'Sunrise Heights' }, field: { id: 'f3', type: 'multiple_choice' } }] } });
  assert.equal(tf.status, 200);
  const d = await leadOf('Divya Iyer');
  assert.deepEqual([d.source, d.primary_phone, d.custom_fields.utmsource], ['typeform', '+917000112233', 'instagram']);

  const jf = new FormData();
  jf.append('formTitle', 'Enquiry'); jf.append('submissionID', '5912345678901234567');
  jf.append('rawRequest', JSON.stringify({ q3_fullName: { first: 'Farah', last: 'Sheikh' }, q4_email: 'farah@example.com', q5_phoneNumber: { full: '(702) 000-7788' }, q6_message: 'Call after 6pm' }));
  const j = await fetch(C.url('jotform'), { method: 'POST', body: jf });
  assert.equal(j.status, 200, await j.clone().text());
  assert.equal((await leadOf('Farah Sheikh')).primary_phone, '+917020007788');

  const ty = await post('tally', { eventId: 'evt-9', eventType: 'FORM_RESPONSE', data: { formName: 'Callback', fields: [
    { key: 'question_1', label: 'Your name', type: 'INPUT_TEXT', value: 'Gaurav Joshi' }, { key: 'question_2', label: 'WhatsApp number', type: 'INPUT_PHONE_NUMBER', value: '+917065400011' },
    { key: 'question_3', label: 'Budget', type: 'INPUT_TEXT', value: '1.2 Cr' }] } });
  assert.equal(ty.status, 200);
  const g = await leadOf('Gaurav Joshi');
  assert.deepEqual([g.primary_phone, Number(g.budget_max)], ['+917065400011', 12000000]);
});

test('CONNECTORS: automation tools, custom sources, test leads, and a log only the owner company sees', async () => {
  const z = await post('zapier', { name: 'Lata Menon', email: 'lata@example.com', message: 'LinkedIn lead form' });
  assert.deepEqual([z.status, (await z.json()).message], [422, 'No mobile number found. A lead needs a name and a mobile number.'], 'whoever builds the Zap sees what is missing');
  assert.equal((await post('zapier', { 'Full Name': 'Lata Menon', 'Phone Number': '7044011223', Email: 'lata@example.com' })).status, 200);

  const cu = await post('custom', { customer_name: 'Rohit Bansal', contact_no: '7011100022', interested_in: 'Corner plot', budget: '95L' }, {}, '?source=Property Expo 2026');
  assert.equal(cu.status, 200);
  const rb = await leadOf('Rohit Bansal');
  assert.deepEqual([rb.source, Number(rb.budget_max), rb.property_type], ['property_expo_2026', 9500000, 'plot']);

  assert.equal((await post('notaplatform', { name: 'x', phone: '9311100023' })).status, 404);
  assert.equal((await fetch(C.url('zapier').replace(/.{6}$/, 'AAAAAA'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, 'a guessed address is unknown');
  const ping = await fetch(C.url('zapier'));
  assert.deepEqual([ping.status, (await ping.json()).status], [200, 'ready'], 'pasting the address in a browser shows it is live');

  const t = await call('POST', '/lead-connectors/test/indiamart', { token: S.A.token, tenant: S.A.sub });
  assert.equal(t.body.status, 'success', JSON.stringify(t.body));
  assert.deepEqual((await findLead('Test lead from IndiaMART'))[0].tags, ['test']);
  assert.equal((await call('POST', '/lead-connectors/test/indiamart', { token: S.A.execToken, tenant: S.A.sub })).status, 403);

  const src = (await call('GET', '/lead-connectors/sources', { token: S.A.token, tenant: S.A.sub })).body;
  assert.ok(src.length >= 15 && src.every(x => x.steps.length && x.name));
  const log = (await call('GET', '/lead-connectors/deliveries', { token: S.A.token, tenant: S.A.sub })).body;
  assert.ok(log.some(x => x.source === 'indiamart' && x.result === 'created' && /Suresh Patel, \+•+2345/.test(x.summary)), 'delivery log, number masked');
  const stuck = log.find(x => x.source === 'shopify' && !x.processed);
  assert.match(stuck.excerpt, /newsletter@example\.com/, 'what arrived is kept when it needs a person to look');
  assert.ok(!log.some(x => x.processed && x.excerpt), 'and not kept once the lead is in');
  assert.equal((await call('GET', '/lead-connectors/deliveries', { token: S.B.token, tenant: S.B.sub })).body.length, 0, 'B sees none of it');

  await call('PUT', '/integrations/lead_connectors', { token: S.A.token, tenant: S.A.sub, body: { enabled: false } });
  assert.equal((await post('zapier', { name: 'Off Switch', phone: '9311100024' })).status, 422, 'switched off: nothing comes in');
  assert.equal((await findLead('Off Switch')).length, 0);
});

test('CONNECTORS: the WordPress plugin\'s own code delivers Contact Form 7, WPForms and Elementor enquiries', async t => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('php', ['-v']).status !== 0) return t.skip('php is not installed');
  await call('PUT', '/integrations/lead_connectors', { token: S.A.token, tenant: S.A.sub, body: { enabled: true } });
  const here = new URL('.', import.meta.url).pathname;
  // Not spawnSync: the API under test runs in this process and has to answer the plugin.
  const { execFile } = await import('node:child_process');
  const stdout = await new Promise((ok, bad) => execFile('php', [`${here}wp-plugin-harness.php`,
    `${here}../../../integrations/wordpress/hxg-connect-leads/hxg-connect-leads.php`, C.url('wordpress')], (e, out, err) => (e ? bad(new Error(err || out)) : ok(out))));
  const log = JSON.parse(stdout).reverse();          // the plugin keeps newest first
  assert.deepEqual(log.map(r => [r.p, r.c, r.m]), [
    ['contact-form-7', 200, 'Lead added'], ['wpforms', 200, 'Lead added'], ['elementor', 200, 'Lead added'],
    ['ninja-forms', 422, 'No mobile number found. A lead needs a name and a mobile number.']], 'the WordPress admin sees why a form without a phone field fails');

  const p = await leadOf('Pooja Kulkarni');
  assert.deepEqual([p.source, p.primary_phone, p.custom_fields.formname, p.custom_fields.plugin], ['wordpress', '+917030044556', 'Brochure request', 'contact-form-7']);
  assert.ok(!JSON.stringify(p.custom_fields).includes('tok'), 'captcha tokens and hidden fields are not sent');
  assert.match(p.timeline.map(a => a.body).join(' '), /3BHK brochure please/, 'the message lands on the timeline, HTML stripped');
  assert.equal(Number((await leadOf('Tanvi Bhatt')).budget_max), 9000000);
  assert.equal((await leadOf('Nikhil Shetty')).primary_phone, '+917030044557');
});

test('CONNECTORS: the guide has a section for every platform the setup screen links to', async () => {
  const { readFile } = await import('node:fs/promises');
  const guide = await readFile(new URL('../../web/public/integration-guide.html', import.meta.url), 'utf8');
  const src = (await call('GET', '/lead-connectors/sources', { token: S.A.token, tenant: S.A.sub })).body;
  for (const s of src) assert.ok(guide.includes(`id="${s.id}"`), `guide section #${s.id}`);
});

test('TWO-STEP SIGN-IN: console staff need their authenticator code once it is on; codes and backup codes work once', async () => {
  const { codeAt, stepNow } = (await import('../dist/common/totp.js'));
  const email = `sec-${RUN}@hxg.test`, password = 'a-long-staff-password-1';
  const login = code => call('POST', '/platform/auth/login', { body: { email, password, ...(code && { code }) } });
  const made = await call('POST', '/platform/users', { token: S.superToken, body: { email, name: 'Sec Staff', role: 'admin_support', password } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const token = (await login()).body.token;

  assert.equal((await call('POST', '/platform/me/two-factor/setup', { token, body: { password: 'wrong' } })).status, 400);
  const setup = await call('POST', '/platform/me/two-factor/setup', { token, body: { password } });
  assert.match(setup.body.uri, /^otpauth:\/\/totp\/HXG%20Connect:.+secret=[A-Z2-7]{32}&issuer=HXG%20Connect/);
  assert.equal((await login()).status, 200, 'scanning the code changes nothing until it is confirmed');
  assert.equal((await call('POST', '/platform/me/two-factor/enable', { token, body: { code: '000000' } })).status, 400);
  const first = codeAt(setup.body.secret, stepNow());
  const on = await call('POST', '/platform/me/two-factor/enable', { token, body: { code: first } });
  assert.equal(on.body.backup_codes.length, 8);

  const need = await login();
  assert.deepEqual([need.status, need.body.code], [401, 'two_factor_required']);
  assert.equal((await login('123456')).body.code, 'two_factor_invalid');
  assert.equal((await login(first)).status, 401, 'a code that was already used is refused');
  assert.equal((await login(codeAt(setup.body.secret, stepNow() + 1))).status, 200);
  assert.equal((await login(on.body.backup_codes[0])).status, 200, 'a backup code gets you in without the phone');
  assert.equal((await login(on.body.backup_codes[0])).status, 401, 'but only once');
  assert.equal((await call('GET', '/platform/me/two-factor', { token })).body.backup_codes_left, 7);

  const staff = (await call('GET', '/platform/users', { token: S.superToken })).body.find(u => u.email === email);
  assert.equal(staff.two_factor, true);
  assert.equal((await call('POST', `/platform/users/${staff.id}/reset-two-factor`, { token })).status, 403, 'only the super admin can reset someone');
  assert.equal((await call('POST', `/platform/users/${staff.id}/reset-two-factor`, { token: S.superToken })).status, 200);
  assert.equal((await login()).status, 200, 'lost phone: after a reset the password alone works, until they set it up again');
});

test('EXPORT: managers download their leads as a spreadsheet; executives cannot; formulas are neutralised', async () => {
  await call('POST', '/leads', { token: S.A.token, tenant: S.A.sub, body: { name: '=HYPERLINK("http://evil","click")', phone: '7055500199' } });
  const r = await fetch(`${base}/leads/export`, { headers: { authorization: `Bearer ${S.A.token}`, 'x-tenant': S.A.sub } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /leads-\d{4}-\d{2}-\d{2}\.csv/);
  const raw = Buffer.from(await r.arrayBuffer()), csv = raw.toString('utf8');
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'byte-order mark, so Excel reads rupee signs and Hindi names');
  assert.ok(csv.includes('Name,Phone,Email,Stage,'));
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""click""\)",\+917055500199,/, 'a formula in a name is defused, the phone number stays readable');
  assert.equal((await fetch(`${base}/leads/export`, { headers: { authorization: `Bearer ${S.A.execToken}`, 'x-tenant': S.A.sub } })).status, 403);
  const b = await (await fetch(`${base}/leads/export`, { headers: { authorization: `Bearer ${S.B.token}`, 'x-tenant': S.B.sub } })).text();
  assert.ok(!b.includes('7055500199'), 'B\'s export has none of A\'s leads');
});
