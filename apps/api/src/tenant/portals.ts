import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { Db } from '../db/db.service';
import { TenantGuard, TenantRoles } from '../common/guards';
import { intakeLead, leadInputSchema, parseBudget } from './lead-intake';
import { normalizePhone } from '../common/util';
import { mapPropertyType } from './capture.controllers';

/** Portals we recognise by sender domain or name. `id` is the lead source. */
export const PORTALS = [
  { id: '99acres', name: '99acres', match: /99acres/i },
  { id: 'magicbricks', name: 'MagicBricks', match: /magicbricks/i },
  { id: 'housing', name: 'Housing.com', match: /housing\.com|housing/i },
  { id: 'nobroker', name: 'NoBroker', match: /nobroker/i },
  { id: 'squareyards', name: 'Square Yards', match: /square ?yards/i },
  { id: 'commonfloor', name: 'CommonFloor', match: /commonfloor/i },
  { id: 'proptiger', name: 'PropTiger', match: /proptiger/i },
  { id: 'makaan', name: 'Makaan', match: /makaan/i },
  { id: 'other_portal', name: 'Other portal', match: /$^/ },
];
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Portals name their fields differently ("Mobile", "contact_no", "SenderMobile"…).
 *  Flatten one level of nesting and look fields up by normalised name. */
export function mapPortalPayload(portal: string, body: any) {
  const flat: Record<string, string> = {};
  const add = (o: any) => { for (const [k, v] of Object.entries(o ?? {})) if (v !== null && typeof v !== 'object') flat[norm(k)] = String(v).trim(); };
  add(body); for (const v of Object.values(body ?? {})) if (v && typeof v === 'object' && !Array.isArray(v)) add(v);
  const pick = (...keys: string[]) => keys.map(norm).map(k => flat[k]).find(Boolean);
  const phone = pick('mobile', 'phone', 'mobileno', 'mobilenumber', 'phonenumber', 'contact', 'contactno', 'contactnumber', 'sendermobile', 'buyermobile', 'customermobile');
  const project = pick('projectname', 'project', 'propertyname', 'property', 'listingname', 'societyname');
  const msg = pick('query', 'message', 'comments', 'comment', 'requirement', 'remarks');
  return {
    name: pick('name', 'buyername', 'contactname', 'customername', 'leadname', 'sendername', 'fullname') || `${PORTALS.find(p => p.id === portal)?.name ?? 'Portal'} enquiry`,
    phone: phone ?? '', email: pick('email', 'emailid', 'senderemail', 'buyeremail') || undefined,
    source: portal, budget_max: parseBudget(pick('budget', 'price', 'budgetmax')),
    property_type: mapPropertyType(pick('propertytype', 'requirement', 'unittype', 'configuration')),
    preferred_locations: [pick('locality', 'location', 'city')].filter(Boolean) as string[],
    tags: [], custom_fields: { portal, ...(project && { project }), ...(pick('leadid', 'responseid', 'enquiryid', 'queryid') && { portal_lead_id: pick('leadid', 'responseid', 'enquiryid', 'queryid') }) },
    note: [project && `Enquired about ${project}`, msg].filter(Boolean).join('. ') || undefined,
  };
}

const stripHtml = (h: string) => h.replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/[ \t]+/g, ' ');

/** Reads a forwarded portal email. Returns the lead, or why it couldn't. */
export function parsePortalEmail(e: { from: string; subject: string; text: string; html: string }) {
  const body = (e.text?.trim() ? e.text : stripHtml(e.html ?? '')).replace(/\r/g, '');
  const portal = PORTALS.find(p => p.match.test(`${e.from} ${e.subject}`))?.id ?? 'other_portal';
  const label = (re: RegExp) => body.match(re)?.[1]?.trim().replace(/\s{2,}/g, ' ');
  const phoneRaw = label(/(?:mobile|phone|contact(?:\s*(?:no|number))?|ph)\.?\s*(?:no\.?|number)?\s*[:\-]\s*([+\d][\d\s\-]{8,16}\d)/i)
    ?? body.match(/(?:\+?91[\s-]?|\b0)?\b([6-9]\d{4}[\s-]?\d{5})\b/)?.[0];
  const digits = (phoneRaw ?? '').replace(/\D/g, '').replace(/^(91|0)(?=[6-9]\d{9}$)/, '');
  if (!/^[6-9]\d{9}$/.test(digits)) return { portal, lead: null, reason: 'No Indian mobile number found in the email' };
  const name = label(/(?:^|\n)\s*(?:name|buyer(?:'s)? name|contact person|customer name|sender)\s*[:\-]\s*([^\n|]{2,60})/i)
    ?? body.match(/\n?\s*([A-Z][a-z]+(?: [A-Z][a-z]+){0,3}) (?:has )?(?:shown interest|responded|enquired|is interested)/)?.[1];
  const email = body.match(/[A-Za-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:99acres|magicbricks|housing|nobroker|squareyards|commonfloor|proptiger|makaan)\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  const project = label(/(?:project|property|listing|society)\s*(?:name)?\s*[:\-]\s*([^\n|]{2,80})/i);
  const msg = label(/(?:message|query|requirement|comments?|remarks)\s*[:\-]\s*([^\n]{2,300})/i);
  return { portal, reason: null, lead: {
    name: name || `${PORTALS.find(p => p.id === portal)!.name} enquiry`, phone: `+91${digits}`, email, source: portal,
    preferred_locations: [], tags: [], custom_fields: { portal, ...(project && { project }), via: 'email' },
    note: [project && `Enquired about ${project}`, msg].filter(Boolean).join('. ') || undefined,
  } };
}

/** One intake path for pushed, emailed and test portal leads, with a
 *  delivery log (webhook_events) the client can see. */
@Injectable()
export class PortalIntake {
  constructor(private readonly db: Db) {}

  async take(t: { tenant_id: string; enabled: boolean }, portal: string, type: string, raw: unknown, lead: unknown,
             channel: 'portal' | 'email' | 'connector',
             o: { provider?: string; off?: string; unreadable?: string; onFail?: object } = {}): Promise<{ ok: boolean; duplicate?: boolean; reason?: string }> {
    const provider = o.provider ?? 'property_portals';
    if (!t.enabled) return { ok: false, reason: o.off ?? 'Portal leads are switched off for this workspace' };
    const st = (await this.db.appNoTenant('SELECT * FROM tenant_state($1)', [t.tenant_id])).rows[0];
    const base = { ...(raw as object), portal };
    const failed = { ...base, ...o.onFail };                 // what arrived is kept only when someone has to look at it
    if (!st || ['suspended', 'churned'].includes(st.status)) {
      await this.store(t.tenant_id, type, { ...failed, reason: 'Workspace is not accepting leads' }, false, provider);
      return { ok: false, reason: 'Workspace is not accepting leads' };
    }
    const v = leadInputSchema.safeParse(lead);
    if (!v.success) {
      const reason = (raw as any)?.reason ?? o.unreadable ?? 'No usable name and mobile number in the request';
      await this.store(t.tenant_id, type, { ...failed, reason }, false, provider);
      return { ok: false, reason };
    }
    const summary = `${v.data.name}, ${normalizePhone(v.data.phone).replace(/\d(?=\d{4})/g, '•')}`;   // normalise first: portals send '+91-98123 45678'
    try {
      const r = await this.db.withTenant(t.tenant_id, tx => intakeLead(tx, { tenantId: t.tenant_id, limits: st.limits, actorId: null, channel }, v.data));
      await this.store(t.tenant_id, type, { ...base, summary, result: r.duplicate_of ? 'duplicate' : 'created' }, true, provider);
      return { ok: true, duplicate: !!r.duplicate_of };
    } catch {
      const reason = 'Could not be added (plan lead limit reached?)';
      await this.store(t.tenant_id, type, { ...failed, summary, reason }, false, provider);
      return { ok: false, reason };
    }
  }

  store(tenantId: string, type: string, payload: unknown, processed: boolean, provider = 'property_portals') {
    return this.db.withTenant(tenantId, tx => tx.query(
      `INSERT INTO webhook_events (tenant_id, provider, event_type, payload, processed_at) VALUES ($1, $5, $2, $3, CASE WHEN $4 THEN now() END)`,
      [tenantId, type, payload, processed, provider]));
  }
}

@Controller('webhooks')
export class PortalWebhooksController {
  constructor(private readonly db: Db, private readonly intake: PortalIntake) {}

  /** A portal pushes a lead to the client's address for that portal. The
   *  reply is what the portal's account manager checks when testing. */
  @Post('portal/:portal/:key')
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 0 } }))
  async push(@Param('portal') portal: string, @Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    if (!PORTALS.some(p => p.id === portal) || !/^[\w-]{24,64}$/.test(key)) { res.status(404).json({ status: 'failed', message: 'Unknown address' }); return; }
    const t = (await this.db.appNoTenant('SELECT * FROM webhook_target($1, $2)', ['property_portals', key])).rows[0];
    if (!t) { res.status(404).json({ status: 'failed', message: 'Unknown address' }); return; }
    const r = await this.intake.take(t, portal, `push:${portal}`, req.body, mapPortalPayload(portal, req.body), 'portal');
    if (r.ok) res.status(200).json({ status: 'success', message: r.duplicate ? 'Existing lead updated' : 'Lead added' });
    else res.status(422).json({ status: 'failed', message: r.reason });
  }

  /** Forwarded portal emails, posted by the inbound-mail service (SendGrid
   *  Inbound Parse, Mailgun routes or Postmark). Protected by a shared secret. */
  @Post('inbound-email')
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 10 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 } }))
  async email(@Query('secret') secret: string, @Req() req: Request, @Res() res: Response) {
    const want = Buffer.from(config.inboundEmailSecret ?? ''), got = Buffer.from(String(secret ?? ''));
    if (!want.length || want.length !== got.length || !timingSafeEqual(want, got)) { res.sendStatus(403); return; }
    const b = req.body as Record<string, any>;
    const pick = (...k: string[]) => k.map(x => b[x]).find(v => typeof v === 'string' && v) as string | undefined;
    const to = [pick('to', 'To', 'recipient', 'OriginalRecipient'), pick('envelope')].filter(Boolean).join(' ');
    const emailKey = to.toLowerCase().match(/([a-f0-9]{16,40})@/)?.[1];
    const t = emailKey ? (await this.db.appNoTenant('SELECT * FROM portal_email_target($1)', [emailKey])).rows[0] : null;
    if (!t) { res.sendStatus(200); return; }                      // unknown address: accept, so the sender stops retrying
    const mail = { from: pick('from', 'From', 'sender') ?? '', subject: pick('subject', 'Subject') ?? '',
      text: pick('text', 'TextBody', 'body-plain', 'stripped-text') ?? '', html: pick('html', 'HtmlBody', 'body-html') ?? '' };
    if (/forwarding-noreply@google\.com/i.test(mail.from)) {        // Gmail's "confirm forwarding" mail: show it to the client
      await this.intake.store(t.tenant_id, 'gmail_forwarding_confirmation', { subject: mail.subject, text: mail.text.slice(0, 2000) }, false);
    } else {
      const p = parsePortalEmail(mail);
      await this.intake.take(t, p.portal, 'email', { from: mail.from, subject: mail.subject, text: (mail.text || mail.html).slice(0, 20000), reason: p.reason }, p.lead, 'email');
    }
    res.sendStatus(200);
  }
}

/** Setup help for the client: delivery log, what needs review, test leads. */
@Controller('portal-leads')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin', 'sales_manager', 'crm_executive')
export class PortalReviewController {
  constructor(private readonly db: Db, private readonly intake: PortalIntake) {}

  @Get('review')
  async review(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT id, event_type, received_at, payload->>'portal' AS portal, payload->>'from' AS from, payload->>'subject' AS subject,
              payload->>'reason' AS reason, left(payload->>'text', 600) AS excerpt
       FROM webhook_events WHERE provider = 'property_portals' AND processed_at IS NULL ORDER BY received_at DESC LIMIT 50`))).rows;
  }

  @Get('deliveries')
  async deliveries(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT id, event_type, received_at, payload->>'portal' AS portal, payload->>'summary' AS summary,
              payload->>'result' AS result, payload->>'reason' AS reason, (processed_at IS NOT NULL) AS processed
       FROM webhook_events WHERE provider = 'property_portals' AND event_type <> 'gmail_forwarding_confirmation'
       ORDER BY received_at DESC LIMIT 25`))).rows;
  }

  /** Runs a sample lead through the same pipeline a real push uses. */
  @Post('test/:portal') @HttpCode(200)
  async test(@Param('portal') portal: string, @Req() req: Request) {
    const p = PORTALS.find(x => x.id === portal);
    if (!p) throw new NotFoundException('Unknown portal');
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot send test leads');
    const on = (await this.db.withTenant(req.tenant!.id, tx => tx.query(`SELECT enabled FROM integrations WHERE provider = 'property_portals'`))).rows[0];
    if (!on) throw new BadRequestException('Save the Property portals integration first');
    const sample = { name: `Test lead from ${p.name}`, mobile: '9000012345', project_name: 'Sample project', query: 'Test lead sent from HXG Connect settings' };
    const lead = { ...mapPortalPayload(portal, sample), tags: ['test'] };
    const r = await this.intake.take({ tenant_id: req.tenant!.id, enabled: on.enabled }, portal, `test:${portal}`, sample, lead, 'portal');
    return r.ok ? { status: 'success', message: r.duplicate ? 'Existing lead updated' : 'Lead added' } : { status: 'failed', message: r.reason };
  }
}
