import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException,
  HttpStatus, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { TenantGuard, TenantRoles } from '../common/guards';
import { audit, parse } from '../common/util';
import { signInvite, signTenant, verifyInvite } from '../common/tokens';
import { Mailer, workspaceUrl } from '../integrations/integrations.service';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { TEAM_PAGE_ROLES } from '../common/scope';

// Reset links carry a fingerprint of the current password hash, so a link stops
// working the moment it's used (or the password changes any other way).
const fp = (hash: string | null) => createHash('sha256').update(hash ?? 'none').digest('hex').slice(0, 16);
export const signReset = (tid: string, uid: string, hash: string | null) =>
  jwt.sign({ tid, uid, v: fp(hash) }, config.tenantJwtSecret, { audience: 'tenant-reset', issuer: 'hxg-connect', expiresIn: '1h' });
import { originOf } from '../integrations/integrations.controllers';

const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 12);

// ===================================================================
@Controller('auth')
export class TenantAuthController {
  constructor(private readonly db: Db, private readonly mailer: Mailer) {}

  /** Same reply whether or not the account exists. */
  @Post('forgot') @HttpCode(200)
  async forgot(@Body() body: unknown, @Req() req: Request) {
    const { email } = parse(z.object({ email: z.string().email() }), body);
    if (!req.tenantHint) throw new BadRequestException('Open your company workspace address first');
    const t = (await this.db.appNoTenant('SELECT id, status FROM resolve_tenant($1)', [req.tenantHint])).rows[0];
    if (t && t.status !== 'churned') {
      const u = (await this.db.withTenant(t.id, tx => tx.query(`SELECT id, name, password_hash FROM users WHERE email = $1 AND status = 'active'`, [email]))).rows[0];
      if (u) await this.mailer.sendReset(email, u.name, `${workspaceUrl(req.tenantHint, `${req.protocol}://${req.get('host')}`)}/reset#token=${signReset(t.id, u.id, u.password_hash)}&ws=${req.tenantHint}`);
    }
    return { ok: true, message: 'If that account exists, a reset link is on its way.' };
  }

  @Post('reset') @HttpCode(200)
  async reset(@Body() body: unknown) {
    const b = parse(z.object({ token: z.string(), password: z.string().min(10, 'Use at least 10 characters') }), body);
    let r: { tid: string; uid: string; v: string };
    try { r = jwt.verify(b.token, config.tenantJwtSecret, { audience: 'tenant-reset', issuer: 'hxg-connect' }) as any; }
    catch { throw new UnauthorizedException('This reset link is invalid or has expired'); }
    const hash = await bcrypt.hash(b.password, 12);
    const ok = await this.db.withTenant(r.tid, async tx => {
      const u = (await tx.query(`SELECT password_hash FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [r.uid])).rows[0];
      if (!u || fp(u.password_hash) !== r.v) return false;
      await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [r.uid, hash]);
      return true;
    });
    if (!ok) throw new BadRequestException('This reset link was already used. Ask for a new one.');
    return { ok: true };
  }

  /** Login happens on the client's subdomain: sunrise.hxgconnect.com */
  @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request) {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), body);
    if (!req.tenantHint) throw new BadRequestException('Open your company workspace URL to log in');

    const t = (await this.db.appNoTenant('SELECT id, name, status FROM resolve_tenant($1)', [req.tenantHint])).rows[0];
    if (!t) throw new NotFoundException({ code: 'workspace_not_found', message: 'No workspace at this address' });
    if (t.status === 'churned') throw new ForbiddenException({ code: 'workspace_suspended', message: 'This workspace is closed' });

    const u = (await this.db.withTenant(t.id, tx => tx.query(
      `SELECT u.id, u.name, u.password_hash, u.status, r.key AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`, [email]))).rows[0];

    const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || u.status !== 'active') throw new UnauthorizedException('Invalid email or password');
    // Suspended: only the owner gets in, and the guard limits them to billing.
    if (t.status === 'suspended' && u.role !== 'owner') {
      throw new ForbiddenException({ code: 'workspace_suspended', message: 'This workspace is suspended. Your account owner can restore it.' });
    }

    return {
      token: signTenant({ sub: u.id, tid: t.id, role: u.role, name: u.name }),
      user: { id: u.id, name: u.name, role: u.role },
      workspace: { id: t.id, name: t.name },
    };
  }

  /** Invited user sets a password and is logged straight in. */
  @Post('accept-invite') @HttpCode(200)
  async acceptInvite(@Body() body: unknown) {
    const b = parse(z.object({
      token: z.string(),
      password: z.string().min(10, 'Use at least 10 characters'),
    }), body);
    let inv;
    try { inv = verifyInvite(b.token); } catch { throw new UnauthorizedException('Invite link is invalid or expired'); }

    const hash = await bcrypt.hash(b.password, 12);
    const u = (await this.db.withTenant(inv.tid, tx => tx.query(
      `UPDATE users SET password_hash = $2, status = 'active'
       WHERE id = $1 AND status = 'invited'
       RETURNING id, name, (SELECT key FROM roles WHERE roles.id = users.role_id) AS role`,
      [inv.uid, hash]))).rows[0];
    if (!u) throw new BadRequestException('This invite was already used');

    return { token: signTenant({ sub: u.id, tid: inv.tid, role: u.role, name: u.name }), user: u };
  }
}

// ===================================================================
@Controller()
@UseGuards(TenantGuard)
export class MeController {
  /** The web/mobile app calls this on boot to decide which modules to show. */
  @Get('me')
  me(@Req() req: Request) {
    const u = req.tenantUser!, t = req.tenant!;
    return {
      user: { id: u.sub, name: u.name, role: u.role },
      workspace: { id: t.id, name: t.name, subdomain: t.subdomain, status: t.status, trial_ends_at: t.trial_ends_at },
      features: t.features,
      limits: t.limits,
      support_session: u.imp ? { mode: u.imp.mode } : null,   // drives the "support is viewing" banner
    };
  }
}

// ===================================================================
@Controller('users')
@UseGuards(TenantGuard)
export class UsersController {
  constructor(private readonly db: Db, private readonly mailer: Mailer) {}

  /** The Team page. Owner, admin and sales manager see everyone; a team
   *  leader sees themselves and the people who report to them; nobody else
   *  gets the staff list (names, emails, reporting lines). */
  @Get() @TenantRoles(...TEAM_PAGE_ROLES)
  async list(@Req() req: Request) {
    const s = req.scope!;
    const people = s.kind === 'team' ? s.actors : null;
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT u.id, u.name, u.email, u.status, r.key AS role, r.name AS role_name, u.created_at,
              u.manager_id, m.name AS manager_name
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN users m ON m.id = u.manager_id
       WHERE ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))
       ORDER BY u.created_at`, [people]))).rows;
  }

  /** For when email isn't set up yet: an admin copies the link to the person. */
  @Post(':id/reset-link') @HttpCode(200) @TenantRoles('owner', 'admin')
  async resetLink(@Param('id') id: string, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot reset passwords');
    const u = (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT u.id, u.password_hash, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.status = 'active'`, [id]))).rows[0];
    if (!u) throw new NotFoundException('Active user not found');
    if (u.role === 'owner' && req.tenantUser!.role !== 'owner') throw new ForbiddenException('Only the owner can reset the owner\'s password');
    await this.db.withTenant(req.tenant!.id, tx => audit(tx, req, 'user.reset_link', 'user', id));
    const t = req.tenant!;
    return { reset_link: `${workspaceUrl(t.subdomain, originOf(req))}/reset#token=${signReset(t.id, u.id, u.password_hash)}&ws=${t.subdomain}` };
  }

  @Post() @TenantRoles('owner', 'admin')
  async invite(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      name: z.string().trim().min(2),
      email: z.string().trim().toLowerCase().email(),
      role: z.string().refine(r => r !== 'owner', 'There is only one owner'),
      manager_id: z.string().uuid().optional(),
    }), body);
    const tenantId = req.tenant!.id;

    const created = await this.db.withTenant(tenantId, async tx => {
      // Seat limit from the plan (+ any contract override)
      const seats = (await tx.query(`SELECT count(*)::int AS n FROM users WHERE status <> 'inactive'`)).rows[0].n;
      const limit = req.tenant!.limits.users;
      if (limit !== undefined && seats >= limit) {
        throw new HttpException({
          code: 'seat_limit_reached', limit,
          message: `Your plan includes ${limit} users. Upgrade or deactivate someone to add more.`,
        }, HttpStatus.PAYMENT_REQUIRED);
      }

      const role = (await tx.query(`SELECT id FROM roles WHERE key = $1`, [b.role])).rows[0];
      if (!role) throw new BadRequestException(`Unknown role "${b.role}"`);

      const u = await tx.query(
        `INSERT INTO users (tenant_id, email, name, role_id, status, manager_id)
         VALUES ($1,$2,$3,$4,'invited',$5)
         ON CONFLICT (tenant_id, email) DO NOTHING RETURNING id, name, email, status, manager_id`,
        [tenantId, b.email, b.name, role.id, b.manager_id ?? null]);
      if (!u.rowCount) throw new BadRequestException(`${b.email} is already in this workspace`);

      await audit(tx, req, 'user.invited', 'user', u.rows[0].id, { email: b.email, role: b.role });
      return { ...u.rows[0], role: b.role, invite_token: signInvite({ tid: tenantId, uid: u.rows[0].id }) };
    });
    const t = req.tenant!;
    const invite_link = `${workspaceUrl(t.subdomain, originOf(req))}/invite#token=${created.invite_token}&ws=${t.subdomain}`;
    const mail = await this.mailer.sendInvite(b.email, b.name, t.name, invite_link);
    return { ...created, invite_link, invite_emailed: mail.sent, email_error: mail.error };
  }
}

// ===================================================================
/** Where a client admin sees and decides HXG Connect support's access requests. */
@Controller('support-access')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin')
export class SupportAccessController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id,
      tx => tx.query('SELECT * FROM tenant_impersonation_requests()'))).rows;
  }

  @Post(':id/approve') @HttpCode(200)
  approve(@Param('id') id: string, @Req() req: Request) { return this.decide(id, true, req); }

  @Post(':id/reject') @HttpCode(200)
  reject(@Param('id') id: string, @Req() req: Request) { return this.decide(id, false, req); }

  @Post(':id/end') @HttpCode(200)
  async end(@Param('id') id: string, @Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const ok = (await tx.query('SELECT tenant_end_impersonation($1) AS ok', [id])).rows[0].ok;
      if (!ok) throw new NotFoundException('No active support session with that id');
      await audit(tx, req, 'support_access.ended', 'impersonation', id);
      return { id, status: 'ended' };
    });
  }

  private decide(id: string, approve: boolean, req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support cannot approve its own access');
    return this.db.withTenant(req.tenant!.id, async tx => {
      const ok = (await tx.query('SELECT tenant_decide_impersonation($1, $2, $3) AS ok',
        [id, approve, req.tenantUser!.sub])).rows[0].ok;
      if (!ok) throw new NotFoundException('No pending request with that id');
      await audit(tx, req, approve ? 'support_access.approved' : 'support_access.rejected', 'impersonation', id);
      return { id, status: approve ? 'approved' : 'rejected' };
    });
  }
}
