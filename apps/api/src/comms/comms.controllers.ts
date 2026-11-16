import {
  BadGatewayException, BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { RequireFeature, TenantGuard, TenantRoles } from '../common/guards';
import { unseal } from '../common/crypto';
import { audit, normalizePhone, parse, phoneSchema } from '../common/util';
import { IntegrationsService } from '../integrations/integrations.service';
import { intakeLead } from '../tenant/lead-intake';
import { actorIn, leadArgs, leadIn, Scope, visibleLead as seeLead } from '../common/scope';

type Creds = { config: Record<string, string>; secrets: Record<string, string> };
type CallStatus = 'ringing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'missed';
type CallEvent = { callId: string; status?: CallStatus; direction?: 'inbound' | 'outbound'; from?: string; to?: string; duration?: number; recordingUrl?: string };

const CALLING = ['exotel', 'twilio', 'knowlarity', 'myoperator'];
/** Recordings and call outcomes: leadership any call; a team leader their
 *  team's; everyone else calls they placed or on their own leads (PRD §5). */
const CALLS_ALL = ['owner', 'admin', 'sales_manager'];
function mayHandleCall(req: Request, c: { user_id: string | null; owner_id: string | null }, includeOwnLeads: boolean) {
  const u = req.tenantUser!, s: Scope = req.scope!;
  if (u.imp || CALLS_ALL.includes(u.role)) return true;
  const mine = (id: string | null) => !!id && (s.kind === 'team' ? s.actors!.includes(id) : id === u.sub);
  return mine(c.user_id) || (includeOwnLeads && mine(c.owner_id));
}
const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'missed']);
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const xml = (s: string) => s.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
const originOf = (req: Request) => `${req.protocol}://${req.get('host')}`;

// =====================================================================
// Adapters: one shape for every provider.
interface Adapter {
  originate?(c: Creds, p: { agent: string; customer: string; callbackUrl: string; record: boolean }): Promise<string>;
  parse(b: Record<string, any>): CallEvent | null;
  recordingAuth(c: Creds): string;
  verify?(c: Creds, url: string, b: Record<string, any>, sig: string): boolean;
}

async function postForm(url: string, auth: string, form: Record<string, string>) {
  let res: globalThis.Response;
  try {
    res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  } catch { throw new BadGatewayException('The calling provider could not be reached. Try again in a minute.'); }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new BadGatewayException(data?.message ?? data?.RestException?.Message ?? `The calling provider refused the call (${res.status})`);
  return data;
}

const ADAPTERS: Record<string, Adapter> = {
  exotel: {
    async originate(c, p) {
      const base = config.providerBase.exotel ?? `https://${c.config.subdomain}`;
      const d = await postForm(`${base}/v1/Accounts/${encodeURIComponent(c.config.account_sid)}/Calls/connect.json`,
        basic(c.config.api_key, c.secrets.api_token),
        { From: p.agent, To: p.customer, CallerId: c.config.caller_id, Record: p.record ? 'true' : 'false', StatusCallback: p.callbackUrl, 'StatusCallbackEvents[0]': 'terminal' });
      return String(d?.Call?.Sid ?? '');
    },
    parse(b) {
      if (!b.CallSid) return null;
      const raw = String(b.Status ?? b.DialCallStatus ?? b.CallType ?? '').toLowerCase();
      const status: CallStatus = raw === 'completed' ? 'completed' : raw.includes('busy') ? 'busy'
        : raw.includes('no-answer') || raw === 'incomplete' ? 'no_answer' : raw === 'failed' ? 'failed'
        : raw === 'call-attempt' ? 'missed' : 'in_progress';
      return { callId: String(b.CallSid), status, direction: b.CallFrom ? 'inbound' : undefined, from: b.CallFrom ?? b.From, to: b.CallTo ?? b.To,
        duration: Number(b.ConversationDuration ?? b.DialCallDuration ?? b.Duration) || undefined, recordingUrl: b.RecordingUrl || undefined };
    },
    recordingAuth: c => basic(c.config.api_key, c.secrets.api_token),
  },
  twilio: {
    async originate(c, p) {
      // Twilio rings the agent first, then <Dial>s the buyer with recording on.
      const twiml = `<Response><Dial callerId="${xml(c.config.from_number)}"${p.record ? ` record="record-from-answer-dual" recordingStatusCallback="${xml(p.callbackUrl)}"` : ''}><Number>${xml(p.customer)}</Number></Dial></Response>`;
      const d = await postForm(`${config.providerBase.twilio}/2010-04-01/Accounts/${c.config.account_sid}/Calls.json`,
        basic(c.config.account_sid, c.secrets.auth_token),
        { To: p.agent, From: c.config.from_number, Twiml: twiml, StatusCallback: p.callbackUrl, StatusCallbackEvent: 'completed' });
      return String(d?.sid ?? '');
    },
    parse(b) {
      if (!b.CallSid) return null;
      const map: Record<string, CallStatus> = { ringing: 'ringing', 'in-progress': 'in_progress', completed: 'completed', busy: 'busy', failed: 'failed', 'no-answer': 'no_answer', canceled: 'no_answer' };
      const rec = b.RecordingUrl ? (/\.\w{3,4}$/.test(b.RecordingUrl) ? b.RecordingUrl : `${b.RecordingUrl}.mp3`) : undefined;
      return { callId: String(b.CallSid), status: b.CallStatus ? map[String(b.CallStatus)] : undefined,
        direction: b.Direction === 'inbound' ? 'inbound' : b.Direction ? 'outbound' : undefined,
        from: b.From, to: b.To, duration: Number(b.CallDuration ?? b.RecordingDuration) || undefined, recordingUrl: rec };
    },
    recordingAuth: c => basic(c.config.account_sid, c.secrets.auth_token),
    // X-Twilio-Signature: base64 HMAC-SHA1 of the full URL + sorted params.
    verify(c, url, b, sig) {
      const data = url + Object.keys(b).sort().map(k => k + b[k]).join('');
      const want = Buffer.from(createHmac('sha1', c.secrets.auth_token).update(data).digest('base64'));
      const got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got);
    },
  },
};
// Knowlarity / MyOperator: incoming and missed calls are logged from their
// webhooks; click-to-call through them is not wired yet (see README).
const generic: Adapter = {
  parse(b) {
    const id = b.call_id ?? b.uuid ?? b.callid ?? b.call_uuid;
    if (!id) return null;
    const raw = String(b.call_status ?? b.status ?? '').toLowerCase();
    return { callId: String(id), direction: 'inbound', from: b.caller_number ?? b.customer_number ?? b.from, to: b.k_number ?? b.to,
      status: raw.includes('miss') || raw.includes('no') ? 'missed' : raw.includes('busy') ? 'busy' : 'completed',
      duration: Number(b.call_duration ?? b.duration) || undefined, recordingUrl: b.call_recording ?? b.recording_url ?? undefined };
  },
  recordingAuth: () => '',
};
ADAPTERS.knowlarity = generic;
ADAPTERS.myoperator = generic;

const visibleLead = (tx: Tx, req: Request, leadId: string) =>
  seeLead(tx, req.scope!, leadId, { cols: 'l.id, l.name, l.primary_phone, l.owner_id, l.tags' });

// =====================================================================
@Controller()
@UseGuards(TenantGuard)
export class ProfileController {
  constructor(private readonly db: Db) {}

  /** Your own mobile number: click-to-call rings it first. */
  @Patch('me')
  async update(@Body() body: unknown, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot edit profiles');
    const b = parse(z.object({ phone: phoneSchema.nullable().optional(), name: z.string().trim().min(2).max(120).optional() }), body);
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `UPDATE users SET phone = CASE WHEN $2 THEN $3 ELSE phone END, name = COALESCE($4, name) WHERE id = $1 RETURNING id, name, phone`,
      [req.tenantUser!.sub, b.phone !== undefined, b.phone ? normalizePhone(b.phone) : null, b.name ?? null]))).rows[0];
  }
}

@Controller('me')
@UseGuards(TenantGuard)
export class PasswordController {
  constructor(private readonly db: Db) {}
  @Patch('password')
  async change(@Body() body: unknown, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot change passwords');
    const b = parse(z.object({ current: z.string().min(1), password: z.string().min(10, 'Use at least 10 characters') }), body);
    const bcrypt = (await import('bcryptjs')).default;
    return this.db.withTenant(req.tenant!.id, async tx => {
      const u = (await tx.query(`SELECT password_hash FROM users WHERE id = $1`, [req.tenantUser!.sub])).rows[0];
      if (!u || !(await bcrypt.compare(b.current, u.password_hash ?? ''))) throw new BadRequestException({ code: 'wrong_password', message: 'Your current password is not right' });
      await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.tenantUser!.sub, await bcrypt.hash(b.password, 12)]);
      return { ok: true };
    });
  }
}

@Controller('calls')
@UseGuards(TenantGuard)
@RequireFeature('telephony')
export class CallsController {
  constructor(private readonly db: Db, private readonly integrations: IntegrationsService) {}

  @Post('click-to-call')
  async call(@Body() body: unknown, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot place calls');
    const { lead_id } = parse(z.object({ lead_id: z.string().uuid() }), body);
    const tid = req.tenant!.id;
    const { lead, agent, provider } = await this.db.withTenant(tid, async tx => {
      const lead = await visibleLead(tx, req, lead_id);
      const agent = (await tx.query(`SELECT phone FROM users WHERE id = $1`, [req.tenantUser!.sub])).rows[0]?.phone;
      const p = (await tx.query(`SELECT provider FROM integrations WHERE enabled AND provider = ANY($1) LIMIT 1`, [CALLING])).rows[0]?.provider;
      return { lead, agent, provider: p as string | undefined };
    });
    if (!provider) throw new BadRequestException({ code: 'calling_not_connected', message: 'Connect a calling provider in Settings > Integrations first' });
    if (!agent) throw new BadRequestException({ code: 'agent_phone_missing', message: 'Add your mobile number first. Your phone rings, then the buyer.' });
    const adapter = ADAPTERS[provider];
    if (!adapter.originate) throw new BadRequestException({ code: 'click_to_call_unsupported',
      message: `Click-to-call through ${provider === 'knowlarity' ? 'Knowlarity' : 'MyOperator'} isn't available yet. Calls placed from their app are still logged.` });
    const creds = (await this.integrations.credentials('tenant', tid, provider))!;
    const callId = await adapter.originate(creds, { agent, customer: lead.primary_phone,
      callbackUrl: `${originOf(req)}/api/webhooks/calls/${creds.config.webhook_key}`, record: req.tenant!.features.call_recording !== false });
    if (!callId) throw new BadGatewayException('The calling provider did not return a call id');
    return this.db.withTenant(tid, async tx => {
      const c = (await tx.query(
        `INSERT INTO calls (tenant_id, lead_id, user_id, provider, provider_call_id, direction, from_number, to_number)
         VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7) RETURNING *`,
        [tid, lead.id, req.tenantUser!.sub, provider, callId, agent, lead.primary_phone])).rows[0];
      await audit(tx, req, 'call.placed', 'lead', lead.id, { provider });
      return c;
    });
  }

  @Get()
  async list(@Req() req: Request, @Query('lead_id') leadId?: string) {
    const s = req.scope!;
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT c.id, c.lead_id, l.name AS lead_name, c.direction, c.status, c.duration_sec, c.disposition, c.disposition_note,
              c.started_at, c.ended_at, (c.recording_url IS NOT NULL AND $5::boolean) AS has_recording, u.name AS user_name, c.user_id
       FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN users u ON u.id = c.user_id
       WHERE ($1::uuid IS NULL OR c.lead_id = $1) AND (${leadIn('l', 2)} OR ${actorIn('c.user_id', 4)})
       ORDER BY c.started_at DESC LIMIT 100`, [leadId ?? null, ...leadArgs(s), s.actors, req.tenant!.features.call_recording !== false]))).rows;
  }

  /** Recordings stream through here with the provider's credentials, so the
   *  provider URL never reaches a browser, and every play is audited. */
  @Get(':id/recording')
  async recording(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    if (req.tenant!.features.call_recording === false) {
      throw new ForbiddenException({ code: 'feature_not_in_plan', feature: 'call_recording', message: 'Call recordings are turned off for this workspace' });
    }
    const tid = req.tenant!.id;
    const c = (await this.db.withTenant(tid, tx => tx.query(
      `SELECT c.provider, c.recording_url, c.user_id, l.owner_id FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, [id]))).rows[0];
    if (!c || !c.recording_url || !mayHandleCall(req, c, true)) {
      throw new NotFoundException('No recording you can play');
    }
    const creds = await this.integrations.credentials('tenant', tid, c.provider);
    const auth = creds ? ADAPTERS[c.provider].recordingAuth(creds) : '';
    let r: globalThis.Response;
    try { r = await fetch(c.recording_url, { headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(15000) }); }
    catch { throw new BadGatewayException('The recording could not be fetched right now'); }
    if (!r.ok) throw new BadGatewayException(`The provider refused the recording (${r.status})`);
    await this.db.withTenant(tid, tx => audit(tx, req, 'call.recording_played', 'call', id));
    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(await r.arrayBuffer()));
  }

  @Post(':id/disposition') @HttpCode(200)
  async disposition(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      disposition: z.enum(['interested', 'not_interested', 'call_back', 'not_reachable', 'wrong_number', 'switched_off']),
      note: z.string().trim().max(2000).optional(),
      next: z.object({ type: z.enum(['call', 'whatsapp', 'email', 'meeting', 'site_visit']), due_at: z.string().datetime({ offset: true }) }).optional(),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const c = (await tx.query(`SELECT c.*, l.owner_id FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, [id])).rows[0];
      if (!c || !mayHandleCall(req, c, false)) throw new NotFoundException('Call not found');
      await tx.query(`UPDATE calls SET disposition = $2, disposition_note = $3 WHERE id = $1`, [id, b.disposition, b.note ?? null]);
      if (c.lead_id) {
        await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'call',$3,$4,$5)`,
          [req.tenant!.id, c.lead_id, req.tenantUser!.sub, b.note ?? null, { disposition: b.disposition, duration: c.duration_sec, call_id: id }]);
        if (b.disposition === 'wrong_number') await tx.query(`UPDATE leads SET tags = array_append(tags, 'wrong_number') WHERE id = $1 AND NOT 'wrong_number' = ANY(tags)`, [c.lead_id]);
        if (b.next) await tx.query(`INSERT INTO follow_ups (tenant_id, lead_id, assigned_to, type, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$3)`,
          [req.tenant!.id, c.lead_id, req.tenantUser!.sub, b.next.type, b.next.due_at]);
        await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [c.lead_id]);
      }
      return { id, disposition: b.disposition };
    });
  }
}

// =====================================================================
/** Status callbacks for outbound calls, and incoming/missed calls. The URL's
 *  unguessable key finds the workspace; Twilio requests are also signed. */
@Controller('webhooks/calls')
export class CallWebhooksController {
  constructor(private readonly db: Db) {}

  @Post(':key')
  async event(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    let t: any = null;
    if (/^[\w-]{24,64}$/.test(key)) for (const p of CALLING) {
      t = (await this.db.appNoTenant('SELECT *, $1::text AS provider FROM webhook_target($1, $2)', [p, key])).rows[0];
      if (t) break;
    }
    if (!t) { res.sendStatus(404); return; }
    const adapter = ADAPTERS[t.provider];
    const b = (req.body ?? {}) as Record<string, any>;
    if (adapter.verify && !adapter.verify({ config: t.config, secrets: unseal(t.secrets_enc) }, `${originOf(req)}${req.originalUrl}`, b,
      String(req.headers['x-twilio-signature'] ?? ''))) { res.sendStatus(403); return; }
    const ev = adapter.parse(b);
    if (ev) await this.apply(t.tenant_id, t.provider, ev);
    res.status(200).type('text/xml').send('<Response/>');   // valid reply for Twilio and Exotel alike
  }

  private async apply(tenantId: string, provider: string, ev: CallEvent) {
    const st = (await this.db.appNoTenant('SELECT * FROM tenant_state($1)', [tenantId])).rows[0];
    if (!st || st.status === 'suspended' || st.status === 'churned') return;
    if (!st.features?.telephony) return;                         // calling switched off for this client: log nothing
    if (st.features?.call_recording === false) ev = { ...ev, recordingUrl: undefined };   // never store a recording
    await this.db.withTenant(tenantId, async tx => {
      const existing = (await tx.query(`SELECT * FROM calls WHERE provider = $1 AND provider_call_id = $2 FOR UPDATE`, [provider, ev.callId])).rows[0];
      if (existing) {
        const wasDone = TERMINAL.has(existing.status);
        await tx.query(
          `UPDATE calls SET status = COALESCE($2, status), duration_sec = COALESCE($3, duration_sec), recording_url = COALESCE($4, recording_url),
             ended_at = CASE WHEN $5 THEN COALESCE(ended_at, now()) ELSE ended_at END WHERE id = $1`,
          [existing.id, ev.status ?? null, ev.duration ?? null, ev.recordingUrl ?? null, !!ev.status && TERMINAL.has(ev.status)]);
        if (!wasDone && ev.status && TERMINAL.has(ev.status) && existing.lead_id) {
          await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'call',$3,$4,$5)`,
            [tenantId, existing.lead_id, existing.user_id, ev.status === 'completed' ? 'Outgoing call' : `Outgoing call: ${ev.status.replace('_', ' ')}`,
             { status: ev.status, duration: ev.duration, call_id: existing.id }]);
          await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [existing.lead_id]);
        }
        return;
      }
      if (!ev.from) return;
      // Incoming call: find the caller, or make them a lead. Nobody is lost.
      const from = normalizePhone(ev.from);
      let lead = (await tx.query(`SELECT l.id, l.owner_id FROM lead_phones p JOIN leads l ON l.id = p.lead_id WHERE p.phone = $1`, [from])).rows[0];
      if (!lead) {
        const r = await intakeLead(tx, { tenantId, limits: st.limits, actorId: null, channel: 'phone' },
          { name: `Caller ${from}`, phone: from, source: 'inbound_call', preferred_locations: [], tags: [], custom_fields: {} });
        lead = r.lead ?? (await tx.query(`SELECT id, owner_id FROM leads WHERE id = $1`, [r.duplicate_of])).rows[0];
      }
      const missed = ev.status ? ['no_answer', 'busy', 'missed', 'failed'].includes(ev.status) : false;
      await tx.query(
        `INSERT INTO calls (tenant_id, lead_id, user_id, provider, provider_call_id, direction, from_number, to_number, status, duration_sec, recording_url, ended_at)
         VALUES ($1,$2,$3,$4,$5,'inbound',$6,$7,$8,$9,$10, now()) ON CONFLICT DO NOTHING`,
        [tenantId, lead.id, lead.owner_id, provider, ev.callId, from, ev.to ?? null, missed ? 'missed' : ev.status ?? 'completed', ev.duration ?? null, ev.recordingUrl ?? null]);
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, body, meta) VALUES ($1,$2,'call',$3,$4)`,
        [tenantId, lead.id, missed ? 'Missed incoming call' : 'Incoming call', { status: missed ? 'missed' : ev.status, duration: ev.duration }]);
      if (missed) await tx.query(
        `INSERT INTO follow_ups (tenant_id, lead_id, assigned_to, type, due_at, note) VALUES ($1,$2,$3,'call',now(),'Missed call. Call back now.')`,
        [tenantId, lead.id, lead.owner_id]);
      await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [lead.id]);
    });
  }
}

// =====================================================================
const templateSchema = z.object({ name: z.string().min(1).max(120), language: z.string().min(2).max(10), params: z.array(z.string().max(500)).max(20).default([]) });

@Controller('whatsapp')
@UseGuards(TenantGuard)
@RequireFeature('whatsapp')
export class WhatsAppController {
  constructor(private readonly db: Db, private readonly integrations: IntegrationsService) {}

  private async creds(tid: string) {
    const c = await this.integrations.credentials('tenant', tid, 'whatsapp_cloud');
    if (!c?.enabled) throw new BadRequestException({ code: 'whatsapp_not_connected', message: 'Connect WhatsApp in Settings > Integrations first' });
    return c;
  }

  @Get('templates')
  async templates(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(`SELECT * FROM wa_templates ORDER BY status <> 'APPROVED', name`))).rows;
  }

  /** Pull templates (and their approval status) from Meta. */
  @Post('templates/sync') @HttpCode(200) @TenantRoles('owner', 'admin', 'sales_manager')
  async sync(@Req() req: Request) {
    const c = await this.creds(req.tenant!.id);
    let r: globalThis.Response;
    try { r = await fetch(`${config.providerBase.graph}/v20.0/${c.config.waba_id}/message_templates?limit=200&fields=name,language,status,category,components`,
      { headers: { authorization: `Bearer ${c.secrets.access_token}` }, signal: AbortSignal.timeout(10000) }); }
    catch { throw new BadGatewayException('Meta could not be reached'); }
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new BadGatewayException(data?.error?.message ?? `Meta refused the request (${r.status})`);
    await this.db.withTenant(req.tenant!.id, async tx => {
      for (const t of data.data ?? []) {
        const text = (t.components ?? []).find((x: any) => x.type === 'BODY')?.text ?? '';
        const params = new Set((text.match(/\{\{\d+\}\}/g) ?? [])).size;
        await tx.query(
          `INSERT INTO wa_templates (tenant_id, name, language, category, status, body, params) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, name, language) DO UPDATE SET category = EXCLUDED.category, status = EXCLUDED.status,
             body = EXCLUDED.body, params = EXCLUDED.params, synced_at = now()`,
          [req.tenant!.id, t.name, t.language, t.category ?? null, t.status, text, params]);
      }
    });
    return { synced: (data.data ?? []).length };
  }

  @Get('conversations')
  async conversations(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT * FROM (SELECT DISTINCT ON (m.lead_id) m.lead_id, l.name AS lead_name, l.primary_phone, m.body, m.direction, m.created_at, m.template_name
         FROM wa_messages m JOIN leads l ON l.id = m.lead_id WHERE ${leadIn('l', 1)}
         ORDER BY m.lead_id, m.created_at DESC) x ORDER BY created_at DESC LIMIT 200`, leadArgs(req.scope!)))).rows;
  }

  @Get('messages')
  async thread(@Query('lead_id') leadId: string, @Req() req: Request) {
    if (!leadId) throw new BadRequestException('lead_id is required');
    return this.db.withTenant(req.tenant!.id, async tx => {
      const l = await visibleLead(tx, req, leadId);
      const msgs = (await tx.query(
        `SELECT m.*, u.name AS sent_by_name FROM wa_messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.lead_id = $1 ORDER BY m.created_at`, [leadId])).rows;
      const lastIn = [...msgs].reverse().find(m => m.direction === 'in');
      const open = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() < 24 * 3600e3;
      return { messages: msgs, window_open: open, opted_out: (l.tags ?? []).includes('whatsapp_opt_out') };
    });
  }

  /** Free text only inside Meta's 24-hour customer-service window; outside
   *  it, an approved template. Opted-out buyers get nothing. */
  @Post('messages')
  async send(@Body() body: unknown, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot send messages');
    const b = parse(z.object({ lead_id: z.string().uuid(), text: z.string().trim().min(1).max(4096).optional(), template: templateSchema.optional() })
      .refine(v => !!v.text !== !!v.template, 'Send either text or a template'), body);
    const tid = req.tenant!.id;
    const c = await this.creds(tid);
    const lead = await this.db.withTenant(tid, async tx => {
      const l = await visibleLead(tx, req, b.lead_id);
      if ((l.tags ?? []).includes('whatsapp_opt_out')) throw new BadRequestException({ code: 'opted_out', message: `${l.name} replied STOP. WhatsApp messages to them are blocked.` });
      if (b.text) {
        const lastIn = (await tx.query(`SELECT created_at FROM wa_messages WHERE lead_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [l.id])).rows[0];
        if (!lastIn || Date.now() - new Date(lastIn.created_at).getTime() >= 24 * 3600e3) {
          throw new BadRequestException({ code: 'outside_24h_window', message: 'They haven\'t messaged in the last 24 hours, so WhatsApp only allows an approved template.' });
        }
      } else {
        const t = (await tx.query(`SELECT status, params FROM wa_templates WHERE name = $1 AND language = $2`, [b.template!.name, b.template!.language])).rows[0];
        if (!t || t.status !== 'APPROVED') throw new BadRequestException({ code: 'template_not_approved', message: 'That template isn\'t approved by Meta. Sync templates and pick an approved one.' });
        if (b.template!.params.length !== t.params) throw new BadRequestException({ code: 'template_params', message: `This template needs ${t.params} value${t.params === 1 ? '' : 's'}` });
      }
      return l;
    });
    const payload = b.text ? { type: 'text', text: { body: b.text, preview_url: true } } : {
      type: 'template', template: { name: b.template!.name, language: { code: b.template!.language },
        components: b.template!.params.length ? [{ type: 'body', parameters: b.template!.params.map(p => ({ type: 'text', text: p })) }] : [] } };
    let r: globalThis.Response;
    try { r = await fetch(`${config.providerBase.graph}/v20.0/${c.config.phone_number_id}/messages`, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${c.secrets.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: lead.primary_phone.replace('+', ''), ...payload }) }); }
    catch { throw new BadGatewayException('Meta could not be reached. The message was not sent.'); }
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new BadGatewayException(data?.error?.message ?? `Meta refused the message (${r.status})`);
    return this.db.withTenant(tid, async tx => {
      const m = (await tx.query(
        `INSERT INTO wa_messages (tenant_id, lead_id, direction, wa_message_id, kind, body, template_name, status, sent_by)
         VALUES ($1,$2,'out',$3,$4,$5,$6,'sent',$7) RETURNING *`,
        [tid, lead.id, data?.messages?.[0]?.id ?? null, b.text ? 'text' : 'template', b.text ?? null, b.template?.name ?? null, req.tenantUser!.sub])).rows[0];
      await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [lead.id]);
      return m;
    });
  }
}

/** Called from the signed WhatsApp webhook: inbound messages and delivery receipts. */
export async function processWhatsApp(db: Db, tenantId: string, body: any) {
  const st = (await db.appNoTenant('SELECT * FROM tenant_state($1)', [tenantId])).rows[0];
  if (!st || st.status === 'suspended' || st.status === 'churned' || !st.features?.whatsapp) return;
  const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
  await db.withTenant(tenantId, async tx => {
    for (const entry of body?.entry ?? []) for (const ch of entry?.changes ?? []) {
      const v = ch?.value ?? {};
      for (const m of v.messages ?? []) {
        if (!/^\d{8,15}$/.test(String(m.from ?? ''))) continue;
        const phone = `+${m.from}`;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? `[${m.type ?? 'message'}]`;
        let lead = (await tx.query(`SELECT l.id FROM lead_phones p JOIN leads l ON l.id = p.lead_id WHERE p.phone = $1`, [phone])).rows[0];
        if (!lead) {
          const name = String(v.contacts?.find((x: any) => x.wa_id === m.from)?.profile?.name ?? `WhatsApp ${phone}`).slice(0, 160);
          const r = await intakeLead(tx, { tenantId, limits: st.limits, actorId: null, channel: 'whatsapp' },
            { name, phone, source: 'whatsapp', preferred_locations: [], tags: [], custom_fields: {} }).catch(() => null);
          lead = r?.lead ?? (r?.duplicate_of ? { id: r.duplicate_of } : null);
          if (!lead) continue;
        }
        await tx.query(
          `INSERT INTO wa_messages (tenant_id, lead_id, direction, wa_message_id, kind, body, status) VALUES ($1,$2,'in',$3,$4,$5,'received')
           ON CONFLICT (tenant_id, wa_message_id) DO NOTHING`, [tenantId, lead.id, m.id, m.type === 'text' ? 'text' : 'media', text]);
        if (/^\s*(stop|unsubscribe)\s*$/i.test(text)) {
          await tx.query(`UPDATE leads SET tags = array_append(tags, 'whatsapp_opt_out') WHERE id = $1 AND NOT 'whatsapp_opt_out' = ANY(tags)`, [lead.id]);
        }
        await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [lead.id]);
      }
      for (const s of v.statuses ?? []) {
        if (!RANK[s.status]) continue;
        await tx.query(
          `UPDATE wa_messages SET status = $2, error = $3 WHERE wa_message_id = $1 AND direction = 'out'
             AND (CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END) < $4`,
          [s.id, s.status, s.errors?.[0]?.title ?? null, RANK[s.status]]);
      }
    }
  });
}
