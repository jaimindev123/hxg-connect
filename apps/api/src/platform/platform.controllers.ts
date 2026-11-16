import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param,
  Patch, Post, Put, Query, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { PlatformGuard, PlatformRoles } from '../common/guards';
import { parse } from '../common/util';
import { signPlatform, signTenant } from '../common/tokens';
import { seal, unseal } from '../common/crypto';
import { hashBackup, newBackupCodes, newSecret, otpauthUri, verify as verifyTotp } from '../common/totp';
import { ProvisioningService, provisionSchema } from './provisioning.service';

// A real bcrypt hash of a random string: comparing against it when the email
// doesn't exist keeps login timing identical, so emails can't be enumerated.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 12);

const logAction = (db: Db, actor: string, action: string, tenantId: string | null, detail: object = {}) =>
  db.platform(`INSERT INTO platform.audit_log (actor_id, action, tenant_id, detail) VALUES ($1,$2,$3,$4)`,
    [actor, action, tenantId, detail]);

// ===================================================================
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly db: Db) {}

  @Post('login') @HttpCode(200)
  async login(@Body() body: unknown) {
    const { email, password, code } = parse(z.object({ email: z.string().email(), password: z.string().min(1), code: z.string().trim().max(20).optional() }), body);
    const u = (await this.db.platform(
      `SELECT id, name, role, password_hash, status, totp_secret_enc, totp_enabled_at, totp_last_step, totp_backup FROM platform.users WHERE email = $1`, [email])).rows[0];

    const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || u.status !== 'active') throw new UnauthorizedException('Invalid email or password');

    // Second step, only once the password is right, so it reveals nothing to a guesser.
    if (u.totp_enabled_at) {
      if (!code) throw new UnauthorizedException({ code: 'two_factor_required', message: 'Enter the 6-digit code from your authenticator app' });
      const step = verifyTotp(unseal(u.totp_secret_enc).secret ?? '', code, Number(u.totp_last_step));
      const backup = (u.totp_backup as string[]).indexOf(hashBackup(code));
      if (step !== null) {
        await this.db.platform(`UPDATE platform.users SET totp_last_step = $2 WHERE id = $1`, [u.id, step]);
      } else if (backup >= 0) {
        await this.db.platform(`UPDATE platform.users SET totp_backup = totp_backup - $2::int WHERE id = $1`, [u.id, backup]);
        await logAction(this.db, u.id, 'platform.backup_code_used', null, { left: u.totp_backup.length - 1 });
      } else {
        await logAction(this.db, u.id, 'platform.two_factor_failed', null);
        throw new UnauthorizedException({ code: 'two_factor_invalid', message: 'That code is not right, or has already been used. Wait for the next one and try again.' });
      }
    }

    await logAction(this.db, u.id, 'platform.login', null);
    return { token: signPlatform({ sub: u.id, role: u.role, name: u.name }), role: u.role, name: u.name };
  }
}

// ===================================================================
@Controller('platform/plans')
@UseGuards(PlatformGuard)
export class PlansController {
  constructor(private readonly db: Db) {}

  @Get()
  async list() {
    return (await this.db.platform(
      `SELECT code, name, price_per_user, currency, billing_cycle, limits, features, is_public
       FROM platform.plans ORDER BY price_per_user = 0, price_per_user`)).rows;
  }

  @Put(':code') @PlatformRoles('super_admin')
  async upsert(@Param('code') code: string, @Body() body: unknown, @Req() req: Request) {
    const p = parse(z.object({
      name: z.string().min(2),
      price_per_user: z.number().min(0),
      limits: z.record(z.number().int().min(0)),
      features: z.record(z.boolean()),
      is_public: z.boolean().default(true),
    }), body);
    const r = await this.db.platform(
      `INSERT INTO platform.plans (code, name, price_per_user, limits, features, is_public)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, price_per_user=EXCLUDED.price_per_user,
         limits=EXCLUDED.limits, features=EXCLUDED.features, is_public=EXCLUDED.is_public
       RETURNING code, name, price_per_user, limits, features`,
      [code, p.name, p.price_per_user, p.limits, p.features, p.is_public]);
    await logAction(this.db, req.platformUser!.sub, 'plan.upserted', null, { code });
    return r.rows[0];
  }
}

// ===================================================================
@Controller('platform/tenants')
@UseGuards(PlatformGuard)
export class TenantsController {
  constructor(private readonly db: Db, private readonly provisioning: ProvisioningService) {}

  /** Client directory. Usage comes from platform_tenant_usage(): counts only. */
  @Get()
  async list(@Query('status') status?: string, @Query('plan') plan?: string, @Query('q') q?: string) {
    const r = await this.db.platform(
      `SELECT d.id, d.name, d.subdomain, d.status, d.plan_code, d.plan_name, d.trial_ends_at,
              d.owner_email, d.created_at, d.limits, d.features,
              COALESCE(u.users, 0)::int AS users, COALESCE(u.leads, 0)::int AS leads,
              (COALESCE(u.users, 0) * d.price_per_user)::numeric AS mrr
       FROM platform.tenant_directory d
       LEFT JOIN platform_tenant_usage() u ON u.tenant_id = d.id
       WHERE ($1::text IS NULL OR d.status = $1)
         AND ($2::text IS NULL OR d.plan_code = $2)
         AND ($3::text IS NULL OR d.name ILIKE '%' || $3 || '%' OR d.subdomain ILIKE '%' || $3 || '%')
       ORDER BY d.created_at DESC`,
      [status ?? null, plan ?? null, q ?? null]);
    return r.rows;
  }

  @Post() @PlatformRoles('super_admin', 'admin_sales')
  provision(@Body() body: unknown, @Req() req: Request) {
    return this.provisioning.provision(parse(provisionSchema, body), req.platformUser!.sub, `${req.protocol}://${req.get('host')}`);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const t = (await this.db.platform(
      `SELECT d.*, COALESCE(u.users,0)::int AS users, COALESCE(u.leads,0)::int AS leads
       FROM platform.tenant_directory d LEFT JOIN platform_tenant_usage() u ON u.tenant_id = d.id
       WHERE d.id = $1`, [id])).rows[0];
    if (!t) throw new NotFoundException('Client not found');
    const sub = (await this.db.platform(
      `SELECT status, seats, gateway, current_period_end FROM platform.subscriptions
       WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    const f = (await this.db.platform(
      `SELECT t.feature_overrides, p.features AS plan_features FROM tenants t JOIN platform.plans p ON p.id = t.plan_id WHERE t.id = $1`, [id])).rows[0];
    return { ...t, subscription: sub ?? null, plan_features: f?.plan_features ?? {}, feature_overrides: f?.feature_overrides ?? {} };
  }

  @Post(':id/suspend') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  async suspend(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: z.string().min(5) }), body);
    return this.setStatus(id, 'suspended', req, { reason });
  }

  @Post(':id/restore') @HttpCode(200) @PlatformRoles('super_admin', 'admin_billing')
  restore(@Param('id') id: string, @Req() req: Request) {
    return this.setStatus(id, 'active', req);
  }

  @Post(':id/extend-trial') @HttpCode(200) @PlatformRoles('super_admin', 'admin_sales')
  async extendTrial(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { days } = parse(z.object({ days: z.number().int().min(1).max(60) }), body);
    const r = await this.db.platform(
      `UPDATE tenants SET status = 'trial',
         trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + make_interval(days => $2),
         updated_at = now()
       WHERE id = $1 AND status IN ('trial','active') RETURNING id, status, trial_ends_at`, [id, days]);
    if (!r.rowCount) throw new NotFoundException('Client not found or not on trial');
    await logAction(this.db, req.platformUser!.sub, 'tenant.trial_extended', id, { days });
    return r.rows[0];
  }

  @Patch(':id/plan') @PlatformRoles('super_admin', 'admin_sales', 'admin_billing')
  async changePlan(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { plan_code } = parse(z.object({ plan_code: z.string() }), body);
    const r = await this.db.platform(
      `UPDATE tenants SET plan_id = p.id, updated_at = now()
       FROM platform.plans p WHERE p.code = $2 AND tenants.id = $1
       RETURNING tenants.id, p.code AS plan_code`, [id, plan_code]);
    if (!r.rowCount) throw new NotFoundException('Client or plan not found');
    await logAction(this.db, req.platformUser!.sub, 'tenant.plan_changed', id, { plan_code });
    return r.rows[0];
  }

  /** Contract exceptions on top of the plan: extra seats, a feature trial, etc. */
  @Patch(':id/overrides') @PlatformRoles('super_admin', 'admin_sales')
  async overrides(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const o = parse(z.object({
      limits: z.record(z.number().int().min(0)).optional(),
      features: z.record(z.boolean()).optional(),
    }), body);
    const r = await this.db.platform(
      `UPDATE tenants SET limit_overrides = limit_overrides || $2, feature_overrides = feature_overrides || $3,
         updated_at = now() WHERE id = $1 RETURNING id, limit_overrides, feature_overrides`,
      [id, o.limits ?? {}, o.features ?? {}]);
    if (!r.rowCount) throw new NotFoundException('Client not found');
    await logAction(this.db, req.platformUser!.sub, 'tenant.overrides_changed', id, o);
    return r.rows[0];
  }

  private async setStatus(id: string, status: string, req: Request, detail: object = {}) {
    const r = await this.db.platform(
      `UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, name, status`, [id, status]);
    if (!r.rowCount) throw new NotFoundException('Client not found');
    await logAction(this.db, req.platformUser!.sub, `tenant.${status}`, id, detail);
    return r.rows[0];
  }
}

// ===================================================================
@Controller('platform/impersonation')
@UseGuards(PlatformGuard)
export class ImpersonationController {
  constructor(private readonly db: Db) {}

  /** Step 1: support asks. Nothing is accessible until the client approves. */
  @Post() @PlatformRoles('super_admin', 'admin_support')
  async request(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      tenant_id: z.string().uuid(),
      reason: z.string().trim().min(10, 'Give the client a real reason (10+ chars)'),
      mode: z.enum(['read_only', 'full']).default('read_only'),
    }), body);
    if (b.mode === 'full' && req.platformUser!.role !== 'super_admin') {
      throw new ForbiddenException('Only a super admin can request full (write) access');
    }
    const r = await this.db.platform(
      `INSERT INTO platform.impersonation_sessions (platform_user_id, tenant_id, reason, mode)
       VALUES ($1,$2,$3,$4) RETURNING id, status, mode, created_at`,
      [req.platformUser!.sub, b.tenant_id, b.reason, b.mode]);
    await logAction(this.db, req.platformUser!.sub, 'impersonation.requested', b.tenant_id,
      { session: r.rows[0].id, mode: b.mode });
    return r.rows[0];
  }

  @Get()
  async mine(@Req() req: Request) {
    const all = req.platformUser!.role === 'super_admin';
    return (await this.db.platform(
      `SELECT s.id, s.tenant_id, d.name AS tenant, s.reason, s.mode, s.status, s.expires_at, s.created_at
       FROM platform.impersonation_sessions s JOIN platform.tenant_directory d ON d.id = s.tenant_id
       WHERE $1 OR s.platform_user_id = $2 ORDER BY s.created_at DESC LIMIT 100`,
      [all, req.platformUser!.sub])).rows;
  }

  /** Step 3: after client approval, exchange for a short-lived tenant token. */
  @Post(':id/token') @HttpCode(200)
  async token(@Param('id') id: string, @Req() req: Request) {
    const s = (await this.db.platform(
      `SELECT id, tenant_id, mode, status, expires_at FROM platform.impersonation_sessions
       WHERE id = $1 AND platform_user_id = $2`, [id, req.platformUser!.sub])).rows[0];
    if (!s) throw new NotFoundException('Session not found');
    if (s.status !== 'approved' || new Date(s.expires_at) <= new Date()) {
      throw new ForbiddenException({ code: 'not_approved', message: `Session is ${s.status}` });
    }
    const ttl = Math.floor((new Date(s.expires_at).getTime() - Date.now()) / 1000);
    await logAction(this.db, req.platformUser!.sub, 'impersonation.started', s.tenant_id, { session: id });
    return {
      token: signTenant({
        sub: req.platformUser!.sub, tid: s.tenant_id, role: 'platform_support',
        name: `${req.platformUser!.name} (HXG Connect support)`, imp: { sid: s.id, mode: s.mode },
      }, ttl),
      mode: s.mode, expires_at: s.expires_at,
    };
  }
}

// ===================================================================
@Controller('platform/me')
@UseGuards(PlatformGuard)
export class PlatformMeController {
  constructor(private readonly db: Db) {}
  @Patch('password')
  async change(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ current: z.string().min(1), password: z.string().min(12, 'Platform passwords need 12+ characters') }), body);
    const u = (await this.db.platform(`SELECT password_hash FROM platform.users WHERE id = $1`, [req.platformUser!.sub])).rows[0];
    if (!u || !(await bcrypt.compare(b.current, u.password_hash))) throw new BadRequestException({ code: 'wrong_password', message: 'Your current password is not right' });
    await this.db.platform(`UPDATE platform.users SET password_hash = $2 WHERE id = $1`, [req.platformUser!.sub, await bcrypt.hash(b.password, 12)]);
    await logAction(this.db, req.platformUser!.sub, 'platform.password_changed', null);
    return { ok: true };
  }

  // ---- Two-step sign-in with an authenticator app ----
  private async me(req: Request) {
    return (await this.db.platform(
      `SELECT id, email, password_hash, totp_secret_enc, totp_enabled_at, jsonb_array_length(totp_backup) AS backup_left FROM platform.users WHERE id = $1`, [req.platformUser!.sub])).rows[0];
  }

  @Get('two-factor')
  async twoFactor(@Req() req: Request) {
    const u = await this.me(req);
    return { enabled: !!u.totp_enabled_at, enabled_at: u.totp_enabled_at, backup_codes_left: u.totp_enabled_at ? u.backup_left : 0 };
  }

  /** Step 1: a new secret to scan. Nothing changes at sign-in until it's confirmed with a code. */
  @Post('two-factor/setup') @HttpCode(200)
  async setup(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ password: z.string().min(1) }), body);
    const u = await this.me(req);
    if (!(await bcrypt.compare(b.password, u.password_hash))) throw new BadRequestException({ code: 'wrong_password', message: 'Your password is not right' });
    if (u.totp_enabled_at) throw new BadRequestException({ code: 'already_enabled', message: 'Two-step sign-in is already on. Turn it off first to move it to a new phone.' });
    const secret = newSecret();
    await this.db.platform(`UPDATE platform.users SET totp_secret_enc = $2 WHERE id = $1`, [u.id, seal({ secret })]);
    return { secret, uri: otpauthUri(secret, u.email) };
  }

  /** Step 2: prove the app works, then it's required at every sign-in. */
  @Post('two-factor/enable') @HttpCode(200)
  async enable(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ code: z.string().trim().min(6).max(10) }), body);
    const u = await this.me(req);
    const secret = unseal(u.totp_secret_enc).secret;
    if (!secret || u.totp_enabled_at) throw new BadRequestException({ code: 'not_set_up', message: 'Start the setup again' });
    const step = verifyTotp(secret, b.code);
    if (step === null) throw new BadRequestException({ code: 'two_factor_invalid', message: 'That code is not right. Check the time on your phone is set automatically, then try the next code.' });
    const codes = newBackupCodes();
    await this.db.platform(`UPDATE platform.users SET totp_enabled_at = now(), totp_last_step = $2, totp_backup = $3 WHERE id = $1`, [u.id, step, JSON.stringify(codes.hashed)]);
    await logAction(this.db, u.id, 'platform.two_factor_enabled', null);
    return { enabled: true, backup_codes: codes.plain };
  }

  @Post('two-factor/disable') @HttpCode(200)
  async disable(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ password: z.string().min(1) }), body);
    const u = await this.me(req);
    if (!(await bcrypt.compare(b.password, u.password_hash))) throw new BadRequestException({ code: 'wrong_password', message: 'Your password is not right' });
    await this.db.platform(`UPDATE platform.users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0, totp_backup = '[]' WHERE id = $1`, [u.id]);
    await logAction(this.db, u.id, 'platform.two_factor_disabled', null);
    return { enabled: false };
  }
}

// ===================================================================
/** Your own team: only the super admin hires and assigns platform roles. */
@Controller('platform/users')
@UseGuards(PlatformGuard)
@PlatformRoles('super_admin')
export class PlatformUsersController {
  constructor(private readonly db: Db) {}

  @Get()
  async list() {
    return (await this.db.platform(
      `SELECT id, email, name, role, status, created_at, (totp_enabled_at IS NOT NULL) AS two_factor FROM platform.users ORDER BY created_at`)).rows;
  }

  /** A colleague lost their phone: clear their two-step sign-in so they can set it up again. */
  @Post(':id/reset-two-factor') @HttpCode(200)
  async resetTwoFactor(@Param('id') id: string, @Req() req: Request) {
    if (id === req.platformUser!.sub) throw new BadRequestException('Turn off your own two-step sign-in from Settings');
    const r = await this.db.platform(
      `UPDATE platform.users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0, totp_backup = '[]' WHERE id = $1 RETURNING email`, [id]);
    if (!r.rowCount) throw new NotFoundException('No such staff member');
    await logAction(this.db, req.platformUser!.sub, 'platform_user.two_factor_reset', null, { email: r.rows[0].email });
    return { ok: true };
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      email: z.string().trim().toLowerCase().email(),
      name: z.string().trim().min(2),
      role: z.enum(['super_admin', 'admin_sales', 'admin_support', 'admin_billing']),
      password: z.string().min(12, 'Platform passwords need 12+ characters'),
    }), body);
    try {
      const r = await this.db.platform(
        `INSERT INTO platform.users (email, name, role, password_hash) VALUES ($1,$2,$3,$4)
         RETURNING id, email, name, role`,
        [b.email, b.name, b.role, await bcrypt.hash(b.password, 12)]);
      await logAction(this.db, req.platformUser!.sub, 'platform_user.created', null, { email: b.email, role: b.role });
      return r.rows[0];
    } catch (e: any) {
      if (e?.code === '23505') throw new BadRequestException(`${b.email} already exists`);
      throw e;
    }
  }
}

// ===================================================================
@Controller('platform/overview')
@UseGuards(PlatformGuard)
export class PlatformOverviewController {
  constructor(private readonly db: Db) {}

  @Get()
  async overview() {
    const r = (await this.db.platform(
      `SELECT count(*) FILTER (WHERE d.status = 'active')::int    AS active,
              count(*) FILTER (WHERE d.status = 'trial')::int     AS trials,
              count(*) FILTER (WHERE d.status = 'past_due')::int  AS past_due,
              count(*) FILTER (WHERE d.status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE d.status = 'trial' AND d.trial_ends_at < now() + interval '7 days')::int AS trials_ending,
              COALESCE(sum(u.users * d.price_per_user) FILTER (WHERE d.status IN ('active','past_due')), 0)::numeric AS mrr,
              COALESCE(sum(u.users), 0)::int AS seats,
              COALESCE(sum(u.leads), 0)::bigint AS leads
       FROM platform.tenant_directory d LEFT JOIN platform_tenant_usage() u ON u.tenant_id = d.id`)).rows[0];
    const recent = (await this.db.platform(
      `SELECT a.action, a.at, a.detail, pu.name AS actor, d.name AS tenant
       FROM platform.audit_log a LEFT JOIN platform.users pu ON pu.id = a.actor_id
       LEFT JOIN platform.tenant_directory d ON d.id = a.tenant_id
       WHERE a.action <> 'platform.login' ORDER BY a.at DESC LIMIT 15`)).rows;
    return { ...r, recent };
  }
}
