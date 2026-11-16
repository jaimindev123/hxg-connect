import {
  Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { PlatformGuard, PlatformRoles, TenantGuard, TenantRoles } from '../common/guards';
import { unseal } from '../common/crypto';
import { audit, parse } from '../common/util';
import { IntegrationsService, PlatformSettings, runtime } from './integrations.service';
import { findProvider } from './catalog';
import { applyPayment } from '../tenant/inventory.controllers';
import { config } from '../config';
import { intakeLead, leadInputSchema } from '../tenant/lead-intake';
import { mapPropertyType } from '../tenant/capture.controllers';
import { processWhatsApp } from '../comms/comms.controllers';

export const originOf = (req: Request) => `${req.protocol}://${req.get('host')}`;

/** Integrations that belong to a switchable module: hidden and refused when it's off. */
const NEEDS: Record<string, string> = { calling: 'telephony', whatsapp: 'whatsapp' };
const moduleOn = (req: Request, category?: string) => { const f = category && NEEDS[category]; return !f || !!req.tenant!.features?.[f]; };
function requireModule(req: Request, provider: string) {
  if (!moduleOn(req, findProvider('tenant', provider)?.category)) {
    throw new ForbiddenException({ code: 'feature_not_in_plan', message: 'This module is not included for your workspace' });
  }
}

// =====================================================================
@Controller('integrations')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin')
export class TenantIntegrationsController {
  constructor(private readonly svc: IntegrationsService, private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request) { return (await this.svc.list('tenant', req.tenant!.id, originOf(req))).filter(i => moduleOn(req, i.category)); }

  @Put(':provider')
  async save(@Param('provider') p: string, @Body() body: unknown, @Req() req: Request) {
    this.noSupport(req);
    requireModule(req, p);
    const r = await this.svc.save('tenant', req.tenant!.id, p, body, req.tenantUser!.sub, originOf(req));
    await this.db.withTenant(req.tenant!.id, tx => audit(tx, req, 'integration.saved', 'integration', undefined, { provider: p }));
    return r;
  }

  @Post(':provider/test') @HttpCode(200)
  async test(@Param('provider') p: string, @Req() req: Request) {
    this.noSupport(req);
    requireModule(req, p);
    return this.svc.test('tenant', req.tenant!.id, p, originOf(req));
  }

  @Delete(':provider') @HttpCode(204)
  async remove(@Param('provider') p: string, @Req() req: Request) {
    this.noSupport(req);
    await this.svc.remove('tenant', req.tenant!.id, p);
    await this.db.withTenant(req.tenant!.id, tx => audit(tx, req, 'integration.removed', 'integration', undefined, { provider: p }));
  }

  /** A client's keys are changed by the client. Even full-access support can't. */
  private noSupport(req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('HXG Connect support cannot change your integration keys');
  }
}

// =====================================================================
@Controller('platform/integrations')
@UseGuards(PlatformGuard)
export class PlatformIntegrationsController {
  constructor(private readonly svc: IntegrationsService, private readonly db: Db) {}

  @Get()
  list(@Req() req: Request) { return this.svc.list('platform', null, originOf(req)); }

  @Put(':provider') @PlatformRoles('super_admin', 'admin_billing')
  async save(@Param('provider') p: string, @Body() body: unknown, @Req() req: Request) {
    this.allowed(req, p);
    const r = await this.svc.save('platform', null, p, body, req.platformUser!.sub, originOf(req));
    await this.log(req, 'integration.saved', p);
    return r;
  }

  @Post(':provider/test') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  test(@Param('provider') p: string, @Req() req: Request) {
    this.allowed(req, p);
    return this.svc.test('platform', null, p, originOf(req));
  }

  @Delete(':provider') @HttpCode(204) @PlatformRoles('super_admin', 'admin_billing')
  async remove(@Param('provider') p: string, @Req() req: Request) {
    this.allowed(req, p);
    await this.svc.remove('platform', null, p);
    await this.log(req, 'integration.removed', p);
  }

  /** Billing staff manage the billing account; everything else is super admin. */
  private allowed(req: Request, provider: string) {
    if (req.platformUser!.role !== 'super_admin' && provider !== 'razorpay_billing') {
      throw new ForbiddenException('Only a super admin can change this integration');
    }
  }
  private log(req: Request, action: string, provider: string) {
    return this.db.platform(`INSERT INTO platform.audit_log (actor_id, action, detail) VALUES ($1,$2,$3)`,
      [req.platformUser!.sub, action, { provider }]);
  }
}

// =====================================================================
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

@Controller('platform/settings')
@UseGuards(PlatformGuard)
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettings, private readonly db: Db) {}

  @Get()
  get(@Req() req: Request) {
    return { base_domain: runtime.baseDomain, server_origin: originOf(req) };
  }

  @Put('domain') @PlatformRoles('super_admin')
  async setDomain(@Body() body: unknown, @Req() req: Request) {
    const { base_domain } = parse(z.object({
      base_domain: z.string().trim().toLowerCase().regex(DOMAIN, 'Enter a domain like hxgconnect.in, without https://').nullable(),
    }), body);
    await this.settings.setDomain(base_domain, req.platformUser!.sub);
    await this.db.platform(`INSERT INTO platform.audit_log (actor_id, action, detail) VALUES ($1,'settings.domain_changed',$2)`,
      [req.platformUser!.sub, { base_domain }]);
    return { base_domain: runtime.baseDomain };
  }
}

/** Unauthenticated: the web app reads this before rendering. Nothing secret. */
@Controller('public')
export class PublicConfigController {
  constructor(private readonly db: Db) {}

  @Get('config')
  get() { return { base_domain: runtime.baseDomain }; }

  /** Caddy asks this before issuing an HTTPS certificate on demand, so
   *  certificates exist only for your domain, admin., and real workspaces.
   *  Blocked at the proxy for public traffic (see deploy/Caddyfile). */
  @Get('tls-allowed')
  async tlsAllowed(@Query('domain') domain: string, @Res() res: Response) {
    const d = String(domain ?? '').toLowerCase(), base = runtime.baseDomain;
    if (base && (d === base || d === `admin.${base}`)) { res.sendStatus(200); return; }
    if (base && d.endsWith(`.${base}`)) {
      const sub = d.slice(0, -(base.length + 1));
      if (/^[a-z0-9-]{3,32}$/.test(sub) && (await this.db.appNoTenant('SELECT 1 FROM resolve_tenant($1)', [sub])).rowCount) { res.sendStatus(200); return; }
    }
    res.sendStatus(403);
  }
}

// =====================================================================
/** Provider webhooks: no session, so the signature is the only proof. The
 *  unguessable key in the URL finds the client; the client's own secret
 *  checks the signature. Events are stored now and processed in later
 *  milestones (payment confirmations, inbound WhatsApp). */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly db: Db) {}

  /** Meta's one-time handshake when you add the webhook URL. */
  @Get('whatsapp/:key')
  async whatsappVerify(@Param('key') key: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const t = await this.target('whatsapp_cloud', key);
    if (t && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === t.config.verify_token) {
      res.type('text/plain').send(q['hub.challenge'] ?? '');
      return;
    }
    res.sendStatus(403);
  }

  @Post('whatsapp/:key')
  async whatsapp(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const t = await this.target('whatsapp_cloud', key);
    const secret = t && unseal(t.secrets_enc).app_secret;
    const sig = String(req.headers['x-hub-signature-256'] ?? '').replace(/^sha256=/, '');
    if (!t || !secret || !this.valid(secret, (req as any).rawBody, sig)) { res.sendStatus(403); return; }
    const body = req.body as any;
    const eventId = await this.store(t, 'whatsapp_cloud', body?.entry?.[0]?.changes?.[0]?.field ?? 'unknown', body);
    if (eventId) {
      await processWhatsApp(this.db, t.tenant_id, body).catch(() => undefined);   // event stays stored for replay if this fails
      await this.db.withTenant(t.tenant_id, tx => tx.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [eventId]));
    }
    res.sendStatus(200);
  }

  @Post('razorpay/:key')
  async razorpay(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const t = await this.target('razorpay', key);
    const secret = t && unseal(t.secrets_enc).webhook_secret;
    const sig = String(req.headers['x-razorpay-signature'] ?? '');
    if (!t || !secret || !this.valid(secret, (req as any).rawBody, sig)) { res.sendStatus(403); return; }
    const body = req.body as any;
    const eventId = await this.store(t, 'razorpay', body?.event ?? 'unknown', body);
    if (eventId && body?.event === 'payment_link.paid') await this.settleLink(t.tenant_id, eventId, body);
    res.sendStatus(200);
  }

  // ---------- lead sources ----------
  @Get('facebook/:key')
  async facebookVerify(@Param('key') key: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const t = await this.target('facebook_leads', key);
    if (t && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === t.config.verify_token) {
      res.type('text/plain').send(q['hub.challenge'] ?? ''); return;
    }
    res.sendStatus(403);
  }

  /** Meta sends only a leadgen id; fetch the answers with the client's Page token. */
  @Post('facebook/:key')
  async facebook(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const t = await this.target('facebook_leads', key);
    const secrets = t ? unseal(t.secrets_enc) : {};
    const sig = String(req.headers['x-hub-signature-256'] ?? '').replace(/^sha256=/, '');
    if (!t || !secrets.app_secret || !this.valid(secrets.app_secret, (req as any).rawBody, sig)) { res.sendStatus(403); return; }
    const body = req.body as any;
    const eventId = await this.store(t, 'facebook_leads', 'leadgen', body);
    if (!eventId) { res.sendStatus(200); return; }
    for (const entry of body?.entry ?? []) for (const ch of entry?.changes ?? []) {
      const id = ch?.field === 'leadgen' ? String(ch?.value?.leadgen_id ?? '') : '';
      if (!/^\d{5,25}$/.test(id)) continue;
      try {
        const r = await fetch(`${config.providerBase.graph}/v20.0/${id}`, {
          headers: { authorization: `Bearer ${secrets.page_access_token}` }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const lead: any = await r.json();
        const f: Record<string, string> = Object.fromEntries((lead.field_data ?? []).map((x: any) => [x.name, String(x.values?.[0] ?? '')]));
        await this.intake(t.tenant_id, 'facebook', {
          name: f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' '), phone: f.phone_number,
          email: f.email || undefined, source: 'facebook', property_type: mapPropertyType(f.property_type ?? f.requirement),
          preferred_locations: f.city ? [f.city] : [],
          custom_fields: { fb_leadgen_id: id, fb_form_id: ch.value?.form_id, fb_ad_id: ch.value?.ad_id },
        });
      } catch { /* stored in webhook_events for replay */ }
    }
    await this.db.withTenant(t.tenant_id, tx => tx.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [eventId]));
    res.sendStatus(200);
  }

  /** Google Ads lead forms post the answers directly, with our key inside. */
  @Post('google/:key')
  async google(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const t = await this.target('google_ads_leads', key);
    const body = req.body as any;
    const given = Buffer.from(String(body?.google_key ?? ''));
    const want = Buffer.from(String(t?.config?.verify_token ?? ''));
    if (!t || !want.length || given.length !== want.length || !timingSafeEqual(given, want)) { res.sendStatus(403); return; }
    const eventId = await this.store(t, 'google_ads_leads', body?.is_test ? 'test_lead' : 'lead', body);
    if (eventId) {
      const col: Record<string, string> = Object.fromEntries((body.user_column_data ?? []).map((c: any) => [c.column_id, String(c.string_value ?? '')]));
      await this.intake(t.tenant_id, 'google_ads', {
        name: col.FULL_NAME || [col.FIRST_NAME, col.LAST_NAME].filter(Boolean).join(' '), phone: col.PHONE_NUMBER,
        email: col.EMAIL || undefined, source: 'google_ads', preferred_locations: col.CITY ? [col.CITY] : [],
        tags: body.is_test ? ['test'] : [],
        custom_fields: { gclid: body.gcl_id, google_campaign_id: body.campaign_id, google_form_id: body.form_id },
      }).catch(() => undefined);
      await this.db.withTenant(t.tenant_id, tx => tx.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [eventId]));
    }
    res.sendStatus(200);
  }

  private async intake(tenantId: string, channel: 'facebook' | 'google_ads', raw: unknown) {
    const st = (await this.db.appNoTenant('SELECT * FROM tenant_state($1)', [tenantId])).rows[0];
    if (!st || st.status === 'suspended' || st.status === 'churned') return;
    const v = leadInputSchema.safeParse(raw);
    if (!v.success) return;                       // kept in webhook_events for a human to look at
    await this.db.withTenant(tenantId, tx => intakeLead(tx, { tenantId, limits: st.limits, actorId: null, channel }, v.data));
  }

  private async target(provider: string, key: string) {
    if (!/^[\w-]{24,64}$/.test(key)) return null;
    return (await this.db.appNoTenant('SELECT * FROM webhook_target($1, $2)', [provider, key])).rows[0] ?? null;
  }

  private valid(secret: string, raw: Buffer | undefined, sig: string) {
    if (!raw || !/^[0-9a-f]{64}$/.test(sig)) return false;
    const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
    return timingSafeEqual(want, Buffer.from(sig));
  }

  private async store(t: any, provider: string, type: string, payload: unknown): Promise<number | null> {
    if (!t.enabled) return null;                  // acknowledged, ignored
    return (await this.db.withTenant(t.tenant_id, tx => tx.query(
      `INSERT INTO webhook_events (tenant_id, provider, event_type, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
      [t.tenant_id, provider, type, payload]))).rows[0].id;
  }

  /** A paid payment link becomes a receipt on the right instalment. Safe to
   *  replay: the Razorpay payment id is unique in the payments table. */
  private async settleLink(tenantId: string, eventId: number, body: any) {
    const notes = body?.payload?.payment_link?.entity?.notes ?? {};
    const pay = body?.payload?.payment?.entity;
    if (!pay?.id || !notes.schedule_id || !notes.booking_id || notes.tenant_id !== tenantId) return;
    await this.db.withTenant(tenantId, async tx => {
      await applyPayment(tx, { tenantId, bookingId: notes.booking_id, scheduleId: notes.schedule_id,
        amount: Number(pay.amount) / 100, mode: 'razorpay', reference: pay.id, razorpayPaymentId: pay.id }).catch(() => false);
      await tx.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [eventId]);
    });
  }
}
