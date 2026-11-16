import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../config';
import { Db } from '../db/db.service';
import { signInvite } from '../common/tokens';
import { Mailer, workspaceUrl } from '../integrations/integrations.service';

export const provisionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  subdomain: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/, '3–32 chars: lowercase letters, digits, hyphens'),
  plan_code: z.enum(['starter', 'growth', 'pro', 'enterprise']),
  owner: z.object({ name: z.string().trim().min(2), email: z.string().trim().toLowerCase().email() }),
  trial_days: z.number().int().min(0).max(90).default(14),
});
export type ProvisionInput = z.infer<typeof provisionSchema>;

// The ten role presets every client starts with. Clients edit these freely.
const ROLE_PRESETS: [key: string, name: string, permissions: Record<string, string>][] = [
  ['owner',           'Owner',           { '*': 'all' }],
  ['admin',           'Admin',           { '*': 'all', billing: 'none' }],
  ['sales_manager',   'Sales Manager',   { leads: 'all', reports: 'all', users: 'read' }],
  ['team_leader',     'Team Leader',     { leads: 'team', reports: 'team' }],
  ['sales_executive', 'Sales Executive', { leads: 'own' }],
  ['telecaller',      'Telecaller',      { leads: 'own' }],
  ['crm_executive',   'CRM Executive',   { leads: 'all', imports: 'all' }],
  ['marketing',       'Marketing',       { leads: 'read', campaigns: 'all' }],
  ['finance',         'Finance',         { bookings: 'all', payments: 'all' }],
  ['support',         'Customer Support',{ customers: 'all', tickets: 'all' }],
];

// Real-estate default pipeline. Lost is terminal with a mandatory reason.
const DEFAULT_STAGES: [name: string, won?: boolean, lost?: boolean][] = [
  ['New Lead'], ['Contacted'], ['Qualified'], ['Interested'], ['Meeting Scheduled'],
  ['Site Visit'], ['Negotiation'], ['Booking', true], ['Payment'], ['Registration'],
  ['Possession'], ['Lost', false, true],
];

@Injectable()
export class ProvisioningService {
  constructor(private readonly db: Db, private readonly mailer: Mailer) {}

  async provision(input: ProvisionInput, actorId: string, origin: string) {
    if (config.reservedSubdomains.includes(input.subdomain)) {
      throw new BadRequestException({ code: 'subdomain_reserved', message: `"${input.subdomain}" is reserved` });
    }

    const plan = (await this.db.platform(
      'SELECT id, code, limits, features FROM platform.plans WHERE code = $1', [input.plan_code])).rows[0];
    if (!plan) throw new NotFoundException('Plan not found');

    // Step 1: create the tenant row (platform plane, no RLS context yet).
    let tenantId: string;
    try {
      tenantId = await this.db.platformTx(async tx => {
        const isTrial = input.trial_days > 0;
        const t = await tx.query(
          `INSERT INTO tenants (name, subdomain, status, plan_id, trial_ends_at, owner_email, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [input.name, input.subdomain, isTrial ? 'trial' : 'active', plan.id,
           isTrial ? new Date(Date.now() + input.trial_days * 864e5) : null, input.owner.email, actorId]);
        const id = t.rows[0].id as string;

        await tx.query(
          `INSERT INTO platform.subscriptions (tenant_id, plan_id, seats, status, current_period_end)
           VALUES ($1, $2, 1, $3, $4)`,
          [id, plan.id, isTrial ? 'trialing' : 'active', new Date(Date.now() + 30 * 864e5)]);

        await tx.query(
          `INSERT INTO platform.audit_log (actor_id, action, tenant_id, detail) VALUES ($1, 'tenant.provisioned', $2, $3)`,
          [actorId, id, { plan: input.plan_code, subdomain: input.subdomain }]);

        // Step 2 runs in the SAME transaction with RLS opened for the new tenant.
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        await this.seedWorkspace(tx, id, input);
        return id;
      });
    } catch (e: any) {
      if (e?.code === '23505' && String(e.constraint ?? '').includes('subdomain')) {
        throw new ConflictException({ code: 'subdomain_taken', message: `${input.subdomain} is already taken` });
      }
      throw e;
    }

    const owner = (await this.db.platformTx(tx =>
      tx.query(`SELECT id FROM users WHERE email = $1`, [input.owner.email]), tenantId)).rows[0];

    const base = workspaceUrl(input.subdomain, origin);
    const token = signInvite({ tid: tenantId, uid: owner.id });
    const invite_link = `${base}/invite#token=${token}&ws=${input.subdomain}`;
    // Emailed when SMTP is set up in the console; otherwise the console shows
    // the link to copy, so onboarding never depends on email being configured.
    const mail = await this.mailer.sendInvite(input.owner.email, input.owner.name, input.name, invite_link);
    return {
      tenant: { id: tenantId, name: input.name, subdomain: input.subdomain, plan: input.plan_code },
      workspace_url: base,
      owner_invite_token: token,
      invite_link, invite_emailed: mail.sent, email_error: mail.error,
    };
  }

  private async seedWorkspace(tx: any, tenantId: string, input: ProvisionInput) {
    const roleIds: Record<string, string> = {};
    for (const [key, name, perms] of ROLE_PRESETS) {
      const r = await tx.query(
        `INSERT INTO roles (tenant_id, key, name, is_system, permissions) VALUES ($1,$2,$3,true,$4) RETURNING id`,
        [tenantId, key, name, perms]);
      roleIds[key] = r.rows[0].id;
    }

    await tx.query(
      `INSERT INTO users (tenant_id, email, name, role_id, status) VALUES ($1,$2,$3,$4,'invited')`,
      [tenantId, input.owner.email, input.owner.name, roleIds.owner]);

    const p = await tx.query(
      `INSERT INTO pipelines (tenant_id, name, is_default) VALUES ($1, 'Sales', true) RETURNING id`, [tenantId]);
    for (const [i, [name, won, lost]] of DEFAULT_STAGES.entries()) {
      await tx.query(
        `INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, position, is_won, is_lost)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, p.rows[0].id, name, i, !!won, !!lost]);
    }
  }
}
