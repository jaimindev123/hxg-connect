import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { PartnerRoute, RequireFeature, TenantGuard, TenantRoles } from '../common/guards';
import { signTenant } from '../common/tokens';
import { audit, normalizePhone, parse, phoneSchema } from '../common/util';
import { originOf } from '../integrations/integrations.controllers';
import { Mailer, workspaceUrl } from '../integrations/integrations.service';
import { intakeLead, parseBudget } from './lead-intake';
import { mapPropertyType } from './capture.controllers';

const DUMMY = bcrypt.hashSync('timing-equalizer-not-a-real-password', 12);
const signCpInvite = (tid: string, cp: string) => jwt.sign({ tid, cp }, config.tenantJwtSecret, { audience: 'cp-invite', issuer: 'hxg-connect', expiresIn: '7d' });
const verifyCpInvite = (t: string) => jwt.verify(t, config.tenantJwtSecret, { audience: 'cp-invite', issuer: 'hxg-connect' }) as { tid: string; cp: string };

// =====================================================================
@Controller('channel-partners')
@UseGuards(TenantGuard)
@RequireFeature('cp_portal')
@TenantRoles('owner', 'admin', 'sales_manager')
export class StaffPartnersController {
  constructor(private readonly db: Db, private readonly mailer: Mailer) {}

  @Get()
  async list(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT cp.id, cp.firm_name, cp.contact_name, cp.email, cp.phone, cp.rera_number, cp.commission_pct, cp.protection_days, cp.status, cp.created_at,
              (SELECT count(*) FROM leads l WHERE l.cp_id = cp.id)::int AS leads,
              (SELECT count(*) FROM cp_commissions c WHERE c.cp_id = cp.id AND c.status <> 'cancelled')::int AS bookings,
              (SELECT COALESCE(sum(c.amount), 0) FROM cp_commissions c WHERE c.cp_id = cp.id AND c.status IN ('pending','approved'))::numeric AS owed
       FROM channel_partners cp ORDER BY cp.status = 'suspended', cp.firm_name`))).rows;
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot add partners');
    const b = parse(z.object({
      firm_name: z.string().trim().min(2).max(120), contact_name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email(), phone: phoneSchema.optional(), rera_number: z.string().trim().max(60).optional(),
      commission_pct: z.number().min(0).max(20).default(2), protection_days: z.number().int().min(1).max(365).default(60),
    }), body);
    const t = req.tenant!;
    const cp = await this.db.withTenant(t.id, async tx => {
      try {
        const r = (await tx.query(
          `INSERT INTO channel_partners (tenant_id, firm_name, contact_name, email, phone, rera_number, commission_pct, protection_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, firm_name, contact_name, email, status`,
          [t.id, b.firm_name, b.contact_name, b.email, b.phone ? normalizePhone(b.phone) : null, b.rera_number ?? null, b.commission_pct, b.protection_days])).rows[0];
        await audit(tx, req, 'partner.created', 'channel_partner', r.id, { firm: b.firm_name });
        return r;
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException(`${b.email} is already a partner`);
        throw e;
      }
    });
    const invite_link = `${workspaceUrl(t.subdomain, originOf(req))}/partner/invite#token=${signCpInvite(t.id, cp.id)}&ws=${t.subdomain}`;
    const mail = await this.mailer.sendInvite(b.email, b.contact_name, `${t.name} partner portal`, invite_link);
    return { ...cp, invite_link, invite_emailed: mail.sent };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ commission_pct: z.number().min(0).max(20).optional(), protection_days: z.number().int().min(1).max(365).optional(),
      status: z.enum(['active', 'suspended']).optional() }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const r = (await tx.query(
        `UPDATE channel_partners SET commission_pct = COALESCE($2, commission_pct), protection_days = COALESCE($3, protection_days),
           status = CASE WHEN $4::text IS NULL OR status = 'invited' THEN status ELSE $4 END
         WHERE id = $1 RETURNING id, commission_pct, protection_days, status`, [id, b.commission_pct ?? null, b.protection_days ?? null, b.status ?? null])).rows[0];
      if (!r) throw new NotFoundException('Partner not found');
      await audit(tx, req, 'partner.updated', 'channel_partner', id, b);
      return r;
    });
  }
}

@Controller('commissions')
@UseGuards(TenantGuard)
@RequireFeature('cp_portal')
export class CommissionsController {
  constructor(private readonly db: Db) {}

  @Get() @TenantRoles('owner', 'admin', 'sales_manager', 'finance')
  async list(@Req() req: Request, @Query('status') status?: string) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT c.*, cp.firm_name, l.name AS buyer, u.unit_no, t.name AS tower, p.name AS project
       FROM cp_commissions c JOIN channel_partners cp ON cp.id = c.cp_id JOIN leads l ON l.id = c.lead_id
       JOIN bookings b ON b.id = c.booking_id JOIN units u ON u.id = b.unit_id JOIN towers t ON t.id = u.tower_id JOIN projects p ON p.id = u.project_id
       WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.created_at DESC LIMIT 500`, [status ?? null]))).rows;
  }

  @Post(':id/approve') @HttpCode(200) @TenantRoles('owner', 'admin', 'sales_manager')
  approve(@Param('id') id: string, @Req() req: Request) {
    return this.move(req, id, 'pending', 'approved', `approved_by = $2, approved_at = now()`, [req.tenantUser!.sub]);
  }

  @Post(':id/pay') @HttpCode(200) @TenantRoles('owner', 'admin', 'finance')
  async pay(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { reference } = parse(z.object({ reference: z.string().trim().min(3).max(120) }), body);
    return this.move(req, id, 'approved', 'paid', `paid_reference = $2, paid_at = now()`, [reference]);
  }

  private async move(req: Request, id: string, from: string, to: string, set: string, extra: unknown[]) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot change commissions');
    return this.db.withTenant(req.tenant!.id, async tx => {
      const r = (await tx.query(`UPDATE cp_commissions SET status = '${to}', ${set} WHERE id = $1 AND status = '${from}' RETURNING id, status, amount`, [id, ...extra])).rows[0];
      if (!r) throw new BadRequestException(`Only ${from} commissions can be marked ${to}`);
      await audit(tx, req, `commission.${to}`, 'commission', id, { amount: r.amount });
      return r;
    });
  }
}

/** Called when a booking is made: a protected partner lead earns commission. */
export async function commissionOnBooking(tx: Tx, tenantId: string, lead: any, booking: { id: string; agreed_price: number }) {
  if (!lead.cp_id || !lead.cp_protected_until || new Date(lead.cp_protected_until) < new Date()) return;
  const cp = (await tx.query(`SELECT commission_pct FROM channel_partners WHERE id = $1`, [lead.cp_id])).rows[0];
  if (!cp) return;
  const amount = Math.round(booking.agreed_price * Number(cp.commission_pct)) / 100;
  await tx.query(`INSERT INTO cp_commissions (tenant_id, cp_id, booking_id, lead_id, base_amount, pct, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, lead.cp_id, booking.id, lead.id, booking.agreed_price, cp.commission_pct, amount]);
}

// =====================================================================
@Controller('partner/auth')
export class PartnerAuthController {
  constructor(private readonly db: Db) {}

  @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request) {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), body);
    if (!req.tenantHint) throw new BadRequestException('Open the developer\'s partner portal address to sign in');
    const t = (await this.db.appNoTenant('SELECT id, status, features FROM resolve_tenant($1)', [req.tenantHint])).rows[0];
    if (!t || !t.features?.cp_portal || t.status === 'suspended' || t.status === 'churned') throw new UnauthorizedException('Invalid email or password');
    const cp = (await this.db.withTenant(t.id, tx => tx.query(`SELECT id, contact_name, password_hash, status FROM channel_partners WHERE email = $1`, [email]))).rows[0];
    const ok = await bcrypt.compare(password, cp?.password_hash ?? DUMMY);
    if (!cp || !ok) throw new UnauthorizedException('Invalid email or password');
    if (cp.status !== 'active') throw new ForbiddenException('This partner account is suspended. Contact the developer\'s sales team.');
    return { token: signTenant({ sub: cp.id, tid: t.id, role: 'channel_partner', name: cp.contact_name }) };
  }

  @Post('accept-invite') @HttpCode(200)
  async accept(@Body() body: unknown) {
    const b = parse(z.object({ token: z.string(), password: z.string().min(10, 'Use at least 10 characters') }), body);
    let inv;
    try { inv = verifyCpInvite(b.token); } catch { throw new UnauthorizedException('This invite link is invalid or has expired'); }
    const hash = await bcrypt.hash(b.password, 12);
    const cp = (await this.db.withTenant(inv.tid, tx => tx.query(
      `UPDATE channel_partners SET password_hash = $2, status = 'active' WHERE id = $1 AND status = 'invited' RETURNING id, contact_name`, [inv.cp, hash]))).rows[0];
    if (!cp) throw new BadRequestException('This invite was already used');
    return { token: signTenant({ sub: cp.id, tid: inv.tid, role: 'channel_partner', name: cp.contact_name }) };
  }
}

@Controller('partner')
@UseGuards(TenantGuard)
@PartnerRoute()
@RequireFeature('cp_portal')
export class PartnerPortalController {
  constructor(private readonly db: Db) {}

  private async me(tx: Tx, req: Request) {
    const cp = (await tx.query(`SELECT * FROM channel_partners WHERE id = $1`, [req.tenantUser!.sub])).rows[0];
    if (!cp || cp.status !== 'active') throw new ForbiddenException('This partner account is not active');
    return cp;
  }

  @Get('me')
  async profile(@Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const cp = await this.me(tx, req);
      return { id: cp.id, firm_name: cp.firm_name, contact_name: cp.contact_name, commission_pct: cp.commission_pct,
        protection_days: cp.protection_days, developer: req.tenant!.name };
    });
  }

  /** Partners see only the buyers they registered, and only what they need. */
  @Get('leads')
  async leads(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, async tx => { await this.me(tx, req); return tx.query(
      `SELECT l.id, l.name, l.primary_phone, s.name AS stage, l.status, l.cp_protected_until, l.created_at,
              EXISTS (SELECT 1 FROM bookings b WHERE b.lead_id = l.id AND b.status <> 'cancelled') AS booked
       FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id WHERE l.cp_id = $1 ORDER BY l.created_at DESC`, [req.tenantUser!.sub]); })).rows;
  }

  /** Register a buyer. A buyer already with the developer, or protected by
   *  another partner, is refused with the same message either way, so a
   *  partner can't use this to discover who owns whom. */
  @Post('leads')
  async register(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      name: z.string().trim().min(2).max(160), phone: phoneSchema, email: z.string().trim().toLowerCase().email().optional(),
      budget: z.string().trim().max(40).optional(), requirement: z.string().trim().max(80).optional(), note: z.string().trim().max(2000).optional(),
    }), body);
    const tid = req.tenant!.id;
    const phone = normalizePhone(b.phone);
    return this.db.withTenant(tid, async tx => {
      const cp = await this.me(tx, req);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tid}:${phone}`]);
      const until = new Date(Date.now() + cp.protection_days * 864e5);
      const existing = (await tx.query(
        `SELECT l.id, l.cp_id, l.cp_protected_until, EXISTS (SELECT 1 FROM bookings bk WHERE bk.lead_id = l.id AND bk.status <> 'cancelled') AS booked
         FROM lead_phones p JOIN leads l ON l.id = p.lead_id WHERE p.phone = $1`, [phone])).rows[0];
      if (existing) {
        const lapsed = existing.cp_id && existing.cp_id !== cp.id && new Date(existing.cp_protected_until) < new Date() && !existing.booked;
        if (!lapsed) throw new ConflictException({ code: 'already_registered',
          message: existing.cp_id === cp.id ? 'You have already registered this buyer.' : 'This buyer is already registered with the developer.' });
        // Previous partner's protection ran out without a booking: re-attribute.
        await tx.query(`UPDATE leads SET cp_id = $2, cp_protected_until = $3, last_activity_at = now() WHERE id = $1`, [existing.id, cp.id, until]);
        await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, body, meta) VALUES ($1,$2,'system',$3,$4)`,
          [tid, existing.id, `Registered by ${cp.firm_name} after the previous partner's protection expired`, { cp_id: cp.id }]);
        return { id: existing.id, status: 'registered', protected_until: until };
      }
      const r = await intakeLead(tx, { tenantId: tid, limits: req.tenant!.limits, actorId: null, channel: 'manual' }, {
        name: b.name, phone, email: b.email, source: 'channel_partner', budget_max: parseBudget(b.budget),
        property_type: mapPropertyType(b.requirement), preferred_locations: [], tags: [], custom_fields: { channel_partner: cp.firm_name },
        note: b.note ? `From ${cp.firm_name}: ${b.note}` : undefined,
      });
      await tx.query(`UPDATE leads SET cp_id = $2, cp_protected_until = $3 WHERE id = $1`, [r.lead.id, cp.id, until]);
      return { id: r.lead.id, status: 'registered', protected_until: until };
    });
  }

  @Get('commissions')
  async commissions(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, async tx => { await this.me(tx, req); return tx.query(
      `SELECT c.id, c.amount, c.pct, c.base_amount, c.status, c.paid_reference, c.paid_at, c.created_at, l.name AS buyer, u.unit_no, t.name AS tower, p.name AS project
       FROM cp_commissions c JOIN leads l ON l.id = c.lead_id JOIN bookings b ON b.id = c.booking_id JOIN units u ON u.id = b.unit_id
       JOIN towers t ON t.id = u.tower_id JOIN projects p ON p.id = u.project_id WHERE c.cp_id = $1 ORDER BY c.created_at DESC`, [req.tenantUser!.sub]); })).rows;
  }
}
