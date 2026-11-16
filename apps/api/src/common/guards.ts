import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException, HttpException, HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Db } from '../db/db.service';
import { bearer, PlatformClaims, PlatformRole, TenantClaims, verifyPlatform, verifyTenant } from './tokens';
import { buildScope, Scope } from './scope';

// ---------- request shape -------------------------------------------
export interface TenantState {
  id: string;
  status: string;
  trial_ends_at: string | null;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  name: string;
  subdomain: string;
}

declare module 'express' {
  interface Request {
    tenantHint?: string;          // subdomain from Host or X-Tenant
    platformUser?: PlatformClaims;
    tenantUser?: TenantClaims;
    tenant?: TenantState;
    /** Whose data this person may see; built from their live role. */
    scope?: Scope;
  }
}

// ---------- decorators ----------------------------------------------
export const PlatformRoles = (...roles: PlatformRole[]) => SetMetadata('platformRoles', roles);
export const TenantRoles = (...roles: string[]) => SetMetadata('tenantRoles', roles);
/** Gate an endpoint on a plan feature, e.g. @RequireFeature('field_tracking') */
export const RequireFeature = (feature: string) => SetMetadata('feature', feature);
/** Channel-partner portal routes. Partner tokens work ONLY on these; staff tokens never do. */
export const PartnerRoute = () => SetMetadata('partnerRoute', true);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------- platform guard ------------------------------------------
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = bearer(req.headers.authorization);
    if (!token) throw new UnauthorizedException('Platform login required');

    try {
      req.platformUser = verifyPlatform(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired platform token');
    }

    const roles = this.reflector.getAllAndOverride<PlatformRole[]>('platformRoles',
      [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(req.platformUser.role)) {
      throw new ForbiddenException(`Requires one of: ${roles.join(', ')}`);
    }
    return true;
  }
}

// ---------- tenant guard --------------------------------------------
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = bearer(req.headers.authorization);
    if (!token) throw new UnauthorizedException('Login required');

    let claims: TenantClaims;
    try {
      claims = verifyTenant(token);          // platform tokens fail here: different secret + audience
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // 0. Partners and staff share the tenant realm but never each other's routes.
    const partnerRoute = this.reflector.getAllAndOverride<boolean>('partnerRoute', [ctx.getHandler(), ctx.getClass()]);
    if (claims.role === 'channel_partner' && !partnerRoute) throw new ForbiddenException('Partner accounts can only use the partner portal');
    if (partnerRoute && claims.role !== 'channel_partner') throw new ForbiddenException('This is the partner portal');

    // 1. A token minted for sunrise.hxgconnect.com must not work on metrohomes.hxgconnect.com
    if (req.tenantHint) {
      const r = await this.db.appNoTenant('SELECT id FROM resolve_tenant($1)', [req.tenantHint]);
      if (r.rows[0]?.id !== claims.tid) {
        throw new UnauthorizedException('This token does not belong to this workspace');
      }
    }

    // 2. Live tenant status — suspension takes effect on the very next request
    const s = await this.db.appNoTenant('SELECT * FROM tenant_state($1)', [claims.tid]);
    const tenant = s.rows[0] as TenantState | undefined;
    if (!tenant) throw new UnauthorizedException('Workspace not found');

    // A suspended workspace's owner may still reach billing, to pay and get back in.
    const payingOwner = tenant.status === 'suspended' && claims.role === 'owner' && req.path.startsWith('/api/billing');
    if ((tenant.status === 'suspended' || tenant.status === 'churned') && !payingOwner) {
      throw new ForbiddenException({
        code: 'workspace_suspended',
        message: 'This workspace is suspended. Your data is safe — contact your account owner or billing.',
      });
    }
    if (tenant.status === 'trial' && tenant.trial_ends_at && new Date(tenant.trial_ends_at) < new Date()) {
      // Let them read their data and reach billing; block writes.
      if (!READ_METHODS.has(req.method) && !req.path.startsWith('/api/billing')) {
        throw new HttpException({ code: 'trial_expired', message: 'Trial ended — upgrade to keep working.' },
          HttpStatus.PAYMENT_REQUIRED);
      }
    }

    // 3. Support impersonation: re-validated every request (revocable instantly)
    if (claims.imp) {
      const a = await this.db.appNoTenant('SELECT impersonation_active($1, $2) AS ok', [claims.imp.sid, claims.tid]);
      if (!a.rows[0]?.ok) throw new UnauthorizedException('Support session has ended');
      if (claims.imp.mode === 'read_only' && !READ_METHODS.has(req.method)) {
        throw new ForbiddenException({ code: 'read_only_session', message: 'Support session is read-only' });
      }
    }

    // 4. The person's CURRENT role and status, not what the token said at
    //    sign-in (tokens last 12 hours). A deactivation, role change or team
    //    move on the Team page applies on the very next request.
    let reports: string[] | null = null;
    if (!claims.imp && claims.role !== 'channel_partner') {
      const u = (await this.db.withTenant(claims.tid, tx => tx.query(
        `SELECT u.status, r.key AS role,
                CASE WHEN r.key = 'team_leader' THEN ARRAY(
                  WITH RECURSIVE t AS (SELECT id FROM users WHERE manager_id = $1
                                       UNION SELECT x.id FROM users x JOIN t ON x.manager_id = t.id)
                  SELECT id FROM t) END AS reports
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [claims.sub]))).rows[0];
      if (!u || u.status !== 'active') {
        throw new UnauthorizedException({ code: 'account_inactive', message: 'Your account is no longer active. Ask your admin.' });
      }
      claims = { ...claims, role: u.role };
      reports = u.reports;
    }

    // 4b. Plan feature gate
    const feature = this.reflector.getAllAndOverride<string>('feature', [ctx.getHandler(), ctx.getClass()]);
    if (feature && !tenant.features?.[feature]) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan', feature,
        message: `${feature.replace(/_/g, ' ')} is not included in your plan`,
      });
    }

    // 5. Role check (impersonating support passes reads; writes were handled above)
    const roles = this.reflector.getAllAndOverride<string[]>('tenantRoles', [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(claims.role) && !(claims.imp && READ_METHODS.has(req.method))) {
      throw new ForbiddenException(`Requires one of: ${roles.join(', ')}`);
    }

    req.tenantUser = claims;
    req.tenant = tenant;
    req.scope = buildScope(claims.sub, claims.role, { impersonating: !!claims.imp, reports });
    return true;
  }
}
