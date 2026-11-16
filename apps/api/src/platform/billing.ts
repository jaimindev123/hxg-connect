import {
  BadGatewayException, BadRequestException, Body, Controller, Get, HttpCode, Injectable, NotFoundException,
  OnModuleDestroy, OnModuleInit, Param, Post, Put, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import { Db } from '../db/db.service';
import { PlatformGuard, PlatformRoles, TenantGuard, TenantRoles } from '../common/guards';
import { parse } from '../common/util';
import { IntegrationsService } from '../integrations/integrations.service';
import { LOGO_DATA_URI } from './brand';

const r2 = (n: number) => Math.round(n * 100) / 100;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

const settingsSchema = z.object({
  legal_name: z.string().trim().max(200).default(''),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN').nullable().default(null),
  state_code: z.string().regex(/^\d{2}$/, 'Two-digit GST state code, e.g. 07 for Delhi').default('07'),
  address: z.string().trim().max(500).default(''),
  invoice_prefix: z.string().trim().regex(/^[A-Z0-9]{1,6}$/, 'Up to 6 capital letters or digits').default('HXG'),
  sac: z.string().regex(/^\d{6}$/).default('997331'),        // confirm with your CA
  due_days: z.number().int().min(0).max(60).default(7),
  grace_days: z.number().int().min(1).max(90).default(15),
  bank_details: z.string().trim().max(500).default(''),
});
export type BillingSettings = z.infer<typeof settingsSchema>;

/** Indian financial year for a date: 2026-10-04 → "2026-27". */
const fyOf = (d: string) => { const [y, m] = d.split('-').map(Number); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

@Injectable()
export class BillingService {
  constructor(private readonly db: Db, private readonly integrations: IntegrationsService) {}

  async settings(): Promise<BillingSettings> {
    const r = await this.db.platform(`SELECT value FROM platform.settings WHERE key = 'billing'`);
    return settingsSchema.parse(r.rows[0]?.value ?? {});
  }

  /** Invoices are legal documents: none go out until the seller's name,
   *  address and GST state have been entered and saved by a person. */
  async ready() {
    const s = await this.settings();
    return s.legal_name.length > 1 && s.address.length > 4;
  }

  async saveSettings(body: unknown, actor: string) {
    const s = parse(settingsSchema.extend({
      legal_name: z.string().trim().min(2, 'Your registered business name, as it should appear on invoices').max(200),
      address: z.string().trim().min(5, 'Your registered address, as it should appear on invoices').max(500),
    }), body);
    await this.db.platform(
      `INSERT INTO platform.settings (key, value, updated_by) VALUES ('billing', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(s), actor]);
    return s;
  }

  /** Bill every paying client for a month, in advance. Safe to re-run:
   *  one live invoice per client per month, and numbers stay gapless
   *  because the counter moves in the same transaction as the insert. */
  async generate(month?: string) {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : istToday().slice(0, 7);
    const start = `${m}-01`;
    const end = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const s = await this.settings();
    if (!(await this.ready())) {
      throw new BadRequestException({ code: 'billing_details_missing', message: 'Add your business name, address and GST details under GST settings first. No invoices were issued.' });
    }
    const issued = istToday();
    const tenants = (await this.db.platform(
      `SELECT d.id, d.name, d.plan_name, d.price_per_user, d.owner_email, COALESCE(u.users, 0)::int AS users
       FROM platform.tenant_directory d LEFT JOIN platform_tenant_usage() u ON u.tenant_id = d.id
       WHERE d.status IN ('active','past_due') AND d.price_per_user > 0`)).rows;
    let created = 0, skipped = 0;
    for (const t of tenants) {
      const ok = await this.db.platformTx(async tx => {
        if ((await tx.query(`SELECT 1 FROM platform.invoices WHERE tenant_id = $1 AND period_start = $2 AND status <> 'void'`, [t.id, start])).rowCount) return false;
        const p = (await tx.query(`SELECT * FROM platform.billing_profiles WHERE tenant_id = $1`, [t.id])).rows[0];
        const seats = Math.max(1, t.users);
        const subtotal = r2(seats * Number(t.price_per_user));
        // Place of supply: the client's state; same state as you = CGST + SGST, else IGST.
        const buyerState = p?.state_code ?? s.state_code;
        const intra = buyerState === s.state_code;
        const taxed = !!s.gstin;
        const cgst = taxed && intra ? r2(subtotal * 0.09) : 0, sgst = cgst, igst = taxed && !intra ? r2(subtotal * 0.18) : 0;
        const fy = fyOf(issued);
        const seq = (await tx.query(
          `INSERT INTO platform.invoice_counters (fy, last) VALUES ($1, 1)
           ON CONFLICT (fy) DO UPDATE SET last = platform.invoice_counters.last + 1 RETURNING last`, [fy])).rows[0].last;
        const number = `${s.invoice_prefix}/${fy.slice(2)}/${String(seq).padStart(4, '0')}`;
        await tx.query(
          `INSERT INTO platform.invoices (tenant_id, number, period_start, period_end, plan_name, seats, unit_price, subtotal, cgst, sgst, igst, total,
             buyer, seller, issued_on, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, $15::date + $16::int)`,
          [t.id, number, start, end, t.plan_name, seats, t.price_per_user, subtotal, cgst, sgst, igst, r2(subtotal + cgst + sgst + igst),
           { legal_name: p?.legal_name ?? t.name, gstin: p?.gstin ?? null, state_code: buyerState, address: p?.address ?? '', email: p?.email ?? t.owner_email },
           { legal_name: s.legal_name, gstin: s.gstin, state_code: s.state_code, address: s.address, sac: s.sac, bank_details: s.bank_details },
           issued, s.due_days]);
        return true;
      }).catch((e: any) => { if (e?.code === '23505') return false; throw e; });
      ok ? created++ : skipped++;
    }
    return { month: m, created, skipped };
  }

  /** Overdue → past due; overdue beyond the grace period → suspended (with
   *  billing_hold so payment lifts it); fully paid → back to active. */
  async dunning() {
    const s = await this.settings();
    const overdue = (days: number) => `EXISTS (SELECT 1 FROM platform.invoices i WHERE i.tenant_id = t.id AND i.status = 'due' AND i.due_date < current_date - ${days})`;
    const pastDue = (await this.db.platform(`UPDATE tenants t SET status = 'past_due', updated_at = now() WHERE t.status = 'active' AND ${overdue(0)} RETURNING id`)).rows;
    const suspended = (await this.db.platform(
      `UPDATE tenants t SET status = 'suspended', billing_hold = true, updated_at = now() WHERE t.status = 'past_due' AND ${overdue(s.grace_days)} RETURNING id`)).rows;
    const cleared = (await this.db.platform(`UPDATE tenants t SET status = 'active', updated_at = now() WHERE t.status = 'past_due' AND NOT ${overdue(0)} RETURNING id`)).rows;
    for (const [rows, action] of [[pastDue, 'billing.past_due'], [suspended, 'billing.suspended'], [cleared, 'billing.cleared']] as const)
      for (const r of rows) await this.db.platform(`INSERT INTO platform.audit_log (action, tenant_id, detail) VALUES ($1, $2, '{}')`, [action, r.id]);
    return { past_due: pastDue.length, suspended: suspended.length, cleared: cleared.length };
  }

  /** Idempotent: a replayed Razorpay webhook or a double click changes nothing. */
  async markPaid(invoiceId: string, reference: string, razorpayPaymentId: string | null, actor: string | null) {
    return this.db.platformTx(async tx => {
      const inv = (await tx.query(
        `UPDATE platform.invoices SET status = 'paid', paid_at = now(), paid_reference = $2, razorpay_payment_id = $3
         WHERE id = $1 AND status = 'due' RETURNING tenant_id, number, total`, [invoiceId, reference, razorpayPaymentId])).rows[0];
      if (!inv) return false;
      const stillOverdue = (await tx.query(
        `SELECT 1 FROM platform.invoices WHERE tenant_id = $1 AND status = 'due' AND due_date < current_date LIMIT 1`, [inv.tenant_id])).rowCount;
      if (!stillOverdue) await tx.query(
        `UPDATE tenants SET status = 'active', billing_hold = false, updated_at = now()
         WHERE id = $1 AND (status = 'past_due' OR (status = 'suspended' AND billing_hold))`, [inv.tenant_id]);
      await tx.query(`INSERT INTO platform.audit_log (actor_id, action, tenant_id, detail) VALUES ($1, 'invoice.paid', $2, $3)`,
        [actor, inv.tenant_id, { number: inv.number, total: inv.total, reference }]);
      return true;
    });
  }

  async payLink(invoiceId: string, tenantId?: string) {
    const inv = (await this.db.platform(`SELECT * FROM platform.invoices WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2)`, [invoiceId, tenantId ?? null])).rows[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'due') throw new BadRequestException(`This invoice is ${inv.status}`);
    if (inv.payment_link_url) return { url: inv.payment_link_url };
    const rzp = await this.integrations.credentials('platform', null, 'razorpay_billing');
    if (!rzp?.enabled) throw new BadRequestException({ code: 'online_payment_unavailable',
      message: 'Online payment isn\'t set up yet. Please pay by bank transfer using the details on the invoice.' });
    let res: globalThis.Response;
    try {
      res = await fetch(`${config.providerBase.razorpay}/v1/payment_links`, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${rzp.config.key_id}:${rzp.secrets.key_secret}`).toString('base64')}` },
        body: JSON.stringify({ amount: Math.round(Number(inv.total) * 100), currency: 'INR', accept_partial: false,
          reference_id: inv.number.replace(/\//g, '-'), description: `HXG Connect ${inv.plan_name}, ${inv.period_start} to ${inv.period_end}`,
          customer: { name: inv.buyer.legal_name, email: inv.buyer.email }, notify: { email: true }, reminder_enable: true,
          notes: { invoice_id: inv.id, tenant_id: inv.tenant_id } }) });
    } catch { throw new BadGatewayException('Razorpay could not be reached. Try again shortly.'); }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadGatewayException(data?.error?.description ?? 'Razorpay refused the request');
    await this.db.platform(`UPDATE platform.invoices SET payment_link_url = $2 WHERE id = $1`, [inv.id, data.short_url]);
    return { url: data.short_url };
  }

  html(inv: any) {
    const b = inv.buyer, s = inv.seller, money = (n: unknown) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const tax = Number(inv.igst) > 0 ? `<tr><td>IGST @ 18%</td><td>${money(inv.igst)}</td></tr>`
      : Number(inv.cgst) > 0 ? `<tr><td>CGST @ 9%</td><td>${money(inv.cgst)}</td></tr><tr><td>SGST @ 9%</td><td>${money(inv.sgst)}</td></tr>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>
      body{font:14px/1.5 'IBM Plex Sans',system-ui,sans-serif;color:#111111;max-width:760px;margin:32px auto;padding:0 24px}
      h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px;border-bottom:1px solid #DDDDDD;text-align:left}
      td:last-child,th:last-child{text-align:right}.grid{display:flex;justify-content:space-between;gap:24px;margin-top:20px}.muted{color:#555555}
      .total td{font-weight:700;border-top:2px solid #111111}.stamp{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:600;background:${inv.status === 'paid' ? '#FFFFFF;color:#111111;border:1px solid #111111' : '#111111;color:#FFFFFF'}}
      @media print{.noprint{display:none}}</style></head><body>
      <img src="${LOGO_DATA_URI}" alt="HXG Connect" style="height:56px">
      <div class="grid"><div><h1>${s.gstin ? 'Tax invoice' : 'Invoice'}</h1><div class="muted">${esc(inv.number)}, issued ${esc(inv.issued_on)}</div></div>
        <div><span class="stamp">${inv.status === 'paid' ? `Paid ${esc(String(inv.paid_at).slice(0, 10))}` : `Due ${esc(inv.due_date)}`}</span></div></div>
      <div class="grid"><div><b>From</b><br>${esc(s.legal_name || 'HXG Global LLP')}<br><span class="muted">${esc(s.address)}</span>${s.gstin ? `<br>GSTIN ${esc(s.gstin)}` : ''}</div>
        <div><b>Billed to</b><br>${esc(b.legal_name)}<br><span class="muted">${esc(b.address)}</span>${b.gstin ? `<br>GSTIN ${esc(b.gstin)}` : ''}<br>Place of supply: state ${esc(b.state_code)}</div></div>
      <table><tr><th>Description</th><th>SAC</th><th>Amount</th></tr>
        <tr><td>HXG Connect ${esc(inv.plan_name)} plan, ${inv.seats} user${inv.seats === 1 ? '' : 's'} × ${money(inv.unit_price)}<br><span class="muted">${esc(inv.period_start)} to ${esc(inv.period_end)}</span></td><td>${esc(s.sac)}</td><td>${money(inv.subtotal)}</td></tr></table>
      <table><tr><td>Taxable value</td><td>${money(inv.subtotal)}</td></tr>${tax}<tr class="total"><td>Total</td><td>${money(inv.total)}</td></tr></table>
      ${inv.status === 'due' && s.bank_details ? `<p class="muted" style="margin-top:24px"><b>Bank transfer:</b> ${esc(s.bank_details)}. Please quote ${esc(inv.number)}.</p>` : ''}
      <p class="noprint" style="margin-top:32px"><button onclick="print()">Print or save as PDF</button></p></body></html>`;
  }
}

// =====================================================================
@Controller('platform/billing')
@UseGuards(PlatformGuard)
export class PlatformBillingController {
  constructor(private readonly billing: BillingService, private readonly db: Db) {}

  @Get('settings') async settings() { return { ...(await this.billing.settings()), ready: await this.billing.ready() }; }

  @Put('settings') @PlatformRoles('super_admin', 'admin_billing')
  save(@Body() body: unknown, @Req() req: Request) { return this.billing.saveSettings(body, req.platformUser!.sub); }

  @Post('run-invoices') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  run(@Body() body: { month?: string }) { return this.billing.generate(body?.month); }

  @Post('run-dunning') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  dunning() { return this.billing.dunning(); }

  @Get('invoices')
  async invoices(@Query('status') status?: string, @Query('tenant_id') tenantId?: string) {
    return (await this.db.platform(
      `SELECT i.id, i.number, i.tenant_id, d.name AS tenant, d.status AS tenant_status, i.period_start, i.seats, i.subtotal, i.total, i.status,
              i.issued_on, i.due_date, i.paid_at, i.paid_reference, (i.status = 'due' AND i.due_date < current_date) AS overdue
       FROM platform.invoices i JOIN platform.tenant_directory d ON d.id = i.tenant_id
       WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.tenant_id = $2)
       ORDER BY i.issued_on DESC, i.number DESC LIMIT 500`, [status ?? null, tenantId ?? null])).rows;
  }

  @Post('invoices/:id/mark-paid') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  async markPaid(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { reference } = parse(z.object({ reference: z.string().trim().min(3).max(120) }), body);
    if (!(await this.billing.markPaid(id, reference, null, req.platformUser!.sub))) throw new BadRequestException('Only unpaid invoices can be marked paid');
    return { id, status: 'paid' };
  }

  @Post('invoices/:id/void') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  async void(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), body);
    const r = await this.db.platform(`UPDATE platform.invoices SET status = 'void', void_reason = $2 WHERE id = $1 AND status = 'due' RETURNING tenant_id`, [id, reason]);
    if (!r.rowCount) throw new BadRequestException('Only unpaid invoices can be voided');
    await this.db.platform(`INSERT INTO platform.audit_log (actor_id, action, tenant_id, detail) VALUES ($1,'invoice.voided',$2,$3)`, [req.platformUser!.sub, r.rows[0].tenant_id, { id, reason }]);
    return { id, status: 'void' };
  }

  @Get('invoices/:id/html')
  async html(@Param('id') id: string, @Res() res: Response) {
    const inv = (await this.db.platform(`SELECT * FROM platform.invoices WHERE id = $1`, [id])).rows[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    res.type('html').send(this.billing.html(inv));
  }
}

/** The client owner's side. Every query is pinned to the tenant in the
 *  verified token; a suspended owner can still reach these to pay. */
@Controller('billing')
@UseGuards(TenantGuard)
@TenantRoles('owner')
export class TenantBillingController {
  constructor(private readonly billing: BillingService, private readonly db: Db) {}

  @Get('profile')
  async profile(@Req() req: Request) {
    return (await this.db.platform(`SELECT legal_name, gstin, state_code, email, address FROM platform.billing_profiles WHERE tenant_id = $1`, [req.tenant!.id])).rows[0] ?? null;
  }

  @Put('profile')
  async saveProfile(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      legal_name: z.string().trim().min(2).max(200),
      gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN').optional().or(z.literal('').transform(() => undefined)),
      state_code: z.string().regex(/^\d{2}$/, 'Choose your state'),
      email: z.string().trim().toLowerCase().email(), address: z.string().trim().max(500).optional(),
    }).refine(v => !v.gstin || v.gstin.slice(0, 2) === v.state_code, { message: 'GSTIN starts with your state code', path: ['gstin'] }), body);
    await this.db.platform(
      `INSERT INTO platform.billing_profiles (tenant_id, legal_name, gstin, state_code, email, address) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, state_code = EXCLUDED.state_code,
         email = EXCLUDED.email, address = EXCLUDED.address, updated_at = now()`,
      [req.tenant!.id, b.legal_name, b.gstin ?? null, b.state_code, b.email, b.address ?? null]);
    return { ...b, gstin: b.gstin ?? null };
  }

  @Get('invoices')
  async invoices(@Req() req: Request) {
    return (await this.db.platform(
      `SELECT id, number, period_start, period_end, plan_name, seats, total, status, issued_on, due_date, paid_at,
              (status = 'due' AND due_date < current_date) AS overdue
       FROM platform.invoices WHERE tenant_id = $1 AND status <> 'void' ORDER BY issued_on DESC, number DESC`, [req.tenant!.id])).rows;
  }

  @Post('invoices/:id/pay') @HttpCode(200)
  pay(@Param('id') id: string, @Req() req: Request) { return this.billing.payLink(id, req.tenant!.id); }

  @Get('invoices/:id/html')
  async html(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const inv = (await this.db.platform(`SELECT * FROM platform.invoices WHERE id = $1 AND tenant_id = $2`, [id, req.tenant!.id])).rows[0];
    if (!inv) throw new NotFoundException('Invoice not found');
    res.type('html').send(this.billing.html(inv));
  }
}

/** Razorpay → your billing account. Signed with the billing webhook secret. */
@Controller('webhooks/platform')
export class PlatformBillingWebhookController {
  constructor(private readonly billing: BillingService, private readonly integrations: IntegrationsService) {}

  @Post('razorpay')
  async razorpay(@Req() req: Request, @Res() res: Response) {
    const rzp = await this.integrations.credentials('platform', null, 'razorpay_billing');
    const secret = rzp?.secrets.webhook_secret;
    const sig = String(req.headers['x-razorpay-signature'] ?? '');
    const raw = (req as any).rawBody as Buffer | undefined;
    const want = secret && raw ? Buffer.from(createHmac('sha256', secret).update(raw).digest('hex')) : null;
    if (!want || !/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqual(want, Buffer.from(sig))) { res.sendStatus(403); return; }
    const body = req.body as any;
    if (body?.event === 'payment_link.paid') {
      const notes = body?.payload?.payment_link?.entity?.notes ?? {};
      const pay = body?.payload?.payment?.entity;
      if (notes.invoice_id && pay?.id) await this.billing.markPaid(notes.invoice_id, `Razorpay ${pay.id}`, pay.id, null).catch(() => false);
    }
    res.sendStatus(200);
  }
}

/** Invoices on the 1st (idempotent, so daily checks are safe); dunning hourly. */
@Injectable()
export class BillingScheduler implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly billing: BillingService) {}
  onModuleInit() {
    if (process.env.BILLING_SCHEDULER === 'off') return;
    this.timers.push(setInterval(() => { if (istToday().endsWith('-01')) this.billing.generate().catch(() => undefined); }, 6 * 3600e3));
    this.timers.push(setInterval(() => this.billing.dunning().catch(() => undefined), 3600e3));
    this.timers.forEach(t => t.unref());
  }
  onModuleDestroy() { this.timers.forEach(clearInterval); }
}
