import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { TenantGuard, TenantRoles } from '../common/guards';
import { audit, parse } from '../common/util';
import { activeUser, findVisibleLead, leadArgs, leadIn, visibleLead } from '../common/scope';
const actor = (req: Request) => (req.tenantUser!.imp ? null : req.tenantUser!.sub);

const followUpType = z.enum(['call', 'whatsapp', 'email', 'meeting', 'site_visit']);
const nextAction = z.object({
  type: followUpType,
  due_at: z.string().datetime({ offset: true }),
  note: z.string().trim().max(2000).optional(),
  assigned_to: z.string().uuid().optional(),
});

// ===================================================================
@Controller('pipelines')
@UseGuards(TenantGuard)
export class PipelinesController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const pipelines = (await tx.query(`SELECT id, name, is_default FROM pipelines ORDER BY is_default DESC, name`)).rows;
      const stages = (await tx.query(
        `SELECT id, pipeline_id, name, position, is_won, is_lost FROM pipeline_stages ORDER BY position`)).rows;
      return pipelines.map(p => ({ ...p, stages: stages.filter(s => s.pipeline_id === p.id) }));
    });
  }

  /** Kanban: every stage with its newest 50 cards and the full count/value. */
  @Get(':id/board')
  async board(@Param('id') id: string, @Req() req: Request) {
    const scope = leadArgs(req.scope!);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const stages = (await tx.query(
        `SELECT s.id, s.name, s.position, s.is_won, s.is_lost,
                count(l.id)::int AS count, COALESCE(sum(l.budget_max), 0)::numeric AS value
         FROM pipeline_stages s
         LEFT JOIN leads l ON l.stage_id = s.id AND ${leadIn('l', 2)}
         WHERE s.pipeline_id = $1 GROUP BY s.id ORDER BY s.position`, [id, ...scope])).rows;
      if (!stages.length) throw new NotFoundException('Pipeline not found');
      const cards = (await tx.query(
        `SELECT * FROM (
           SELECT l.id, l.name, l.stage_id, l.budget_min, l.budget_max, l.source, l.tags,
                  l.last_activity_at, u.name AS owner,
                  (SELECT min(f.due_at) FROM follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending') AS next_due,
                  row_number() OVER (PARTITION BY l.stage_id ORDER BY l.last_activity_at DESC) AS rn
           FROM leads l LEFT JOIN users u ON u.id = l.owner_id
           WHERE l.pipeline_id = $1 AND ${leadIn('l', 2)}) x
         WHERE rn <= 50`, [id, ...scope])).rows;
      return stages.map(s => ({ ...s, cards: cards.filter(c => c.stage_id === s.id) }));
    });
  }
}

// ===================================================================
@Controller('follow-ups')
@UseGuards(TenantGuard)
export class FollowUpsController {
  constructor(private readonly db: Db) {}

  /** The work queue: overdue first, then the rest of today. */
  @Get('my-day')
  async myDay(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT f.id, f.type, f.due_at, f.note, f.lead_id, l.name AS lead_name, l.primary_phone,
              s.name AS stage, (f.due_at < now()) AS overdue
       FROM follow_ups f JOIN leads l ON l.id = f.lead_id JOIN pipeline_stages s ON s.id = l.stage_id
       WHERE f.status = 'pending' AND f.assigned_to = $1
         AND f.due_at < date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 + interval '1 day'
       ORDER BY f.due_at`, [req.tenantUser!.sub, 'Asia/Kolkata']))).rows;
  }

  @Get()
  async forLead(@Query('lead_id') leadId: string, @Req() req: Request) {
    if (!leadId) throw new BadRequestException('lead_id is required');
    return this.db.withTenant(req.tenant!.id, async tx => {
      await visibleLead(tx, req.scope!, leadId, { cols: 'l.id' });
      return (await tx.query(
        `SELECT f.*, u.name AS assignee FROM follow_ups f LEFT JOIN users u ON u.id = f.assigned_to
         WHERE f.lead_id = $1 ORDER BY f.status = 'pending' DESC, f.due_at`, [leadId])).rows;
    });
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    const b = parse(nextAction.extend({ lead_id: z.string().uuid() }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const lead = await visibleLead(tx, req.scope!, b.lead_id, { cols: 'l.id, l.owner_id' });
      const f = await this.insert(tx, req, b.lead_id, b, lead.owner_id);
      await audit(tx, req, 'follow_up.created', 'lead', b.lead_id, { type: b.type, due_at: b.due_at });
      return f;
    });
  }

  /** Closing a follow-up demands the next step, unless the deal closed or
   *  another follow-up is already pending. This is the leakage rule. */
  @Post(':id/complete') @HttpCode(200)
  async complete(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      outcome: z.string().trim().min(2).max(2000),
      next: nextAction.optional(),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const f = (await tx.query(
        `SELECT f.id, f.lead_id, f.status, l.status AS lead_status, l.owner_id
         FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.id = $1 FOR UPDATE OF f`, [id])).rows[0];
      // Yours to close if the lead is in your scope or this follow-up was handed to you.
      if (!f || !(await findVisibleLead(tx, req.scope!, f.lead_id, { cols: 'l.id' }))) throw new NotFoundException('Follow-up not found');
      if (f.status !== 'pending') throw new BadRequestException('This follow-up is already closed');

      const otherPending = (await tx.query(
        `SELECT 1 FROM follow_ups WHERE lead_id = $1 AND status = 'pending' AND id <> $2 LIMIT 1`, [f.lead_id, id])).rowCount;
      if (f.lead_status === 'open' && !b.next && !otherPending) {
        throw new BadRequestException({
          code: 'next_action_required',
          message: 'Schedule the next step for this lead, or move it to Booking or Lost.',
        });
      }

      await tx.query(
        `UPDATE follow_ups SET status = 'done', outcome = $2, completed_at = now() WHERE id = $1`, [id, b.outcome]);
      await tx.query(
        `INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'follow_up',$3,$4,$5)`,
        [req.tenant!.id, f.lead_id, actor(req), b.outcome, { follow_up_id: id }]);
      await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [f.lead_id]);
      const next = b.next ? await this.insert(tx, req, f.lead_id, b.next, f.owner_id) : null;
      await audit(tx, req, 'follow_up.completed', 'lead', f.lead_id);
      return { id, status: 'done', next };
    });
  }

  private async insert(tx: any, req: Request, leadId: string, n: z.infer<typeof nextAction>, ownerId: string | null) {
    if (n.assigned_to) await activeUser(tx, n.assigned_to);
    return (await tx.query(
      `INSERT INTO follow_ups (tenant_id, lead_id, assigned_to, type, due_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, type, due_at, note, status, assigned_to`,
      [req.tenant!.id, leadId, n.assigned_to ?? ownerId ?? actor(req), n.type, n.due_at, n.note ?? null, actor(req)])).rows[0];
  }
}

// ===================================================================
@Controller('dashboard')
@UseGuards(TenantGuard)
export class DashboardController {
  constructor(private readonly db: Db) {}

  @Get('summary')
  async summary(@Req() req: Request) {
    const scope = leadArgs(req.scope!);
    const me = req.tenantUser!.sub;
    return this.db.withTenant(req.tenant!.id, async tx => {
      const k = (await tx.query(
        `SELECT
           count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int          AS new_today,
           count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int         AS new_week,
           count(*) FILTER (WHERE status = 'open')::int                                  AS open,
           count(*) FILTER (WHERE status = 'won' AND updated_at >= date_trunc('month', now()))::int AS won_month,
           COALESCE(sum(budget_max) FILTER (WHERE status = 'won' AND updated_at >= date_trunc('month', now())), 0)::numeric AS won_value_month,
           count(*) FILTER (WHERE status = 'open' AND NOT EXISTS
             (SELECT 1 FROM follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending'))::int AS without_next_action
         FROM leads l WHERE ${leadIn('l', 1)}`, scope)).rows[0];
      const f = (await tx.query(
        `SELECT count(*) FILTER (WHERE due_at < now())::int AS overdue,
                count(*) FILTER (WHERE due_at >= now() AND due_at < date_trunc('day', now()) + interval '1 day')::int AS later_today
         FROM follow_ups WHERE status = 'pending' AND assigned_to = $1`, [me])).rows[0];
      const funnel = (await tx.query(
        `SELECT s.name, s.position, count(l.id)::int AS count
         FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id AND p.is_default
         LEFT JOIN leads l ON l.stage_id = s.id AND ${leadIn('l', 1)}
         WHERE NOT s.is_lost GROUP BY s.id ORDER BY s.position`, scope)).rows;
      const sources = (await tx.query(
        `SELECT COALESCE(l.source, 'unknown') AS source, count(*)::int AS count FROM leads l
         WHERE l.created_at >= now() - interval '30 days' AND ${leadIn('l', 1)}
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, scope)).rows;
      return { leads: k, follow_ups: f, funnel, sources };
    });
  }
}

// ===================================================================
@Controller('users')
@UseGuards(TenantGuard)
export class UserAdminController {
  constructor(private readonly db: Db) {}

  @Get('roles')
  async roles(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id,
      tx => tx.query(`SELECT key, name FROM roles WHERE key <> 'owner' ORDER BY name`))).rows;
  }

  /** Change role, reporting line, or deactivate. The owner is untouchable here. */
  @Patch(':id') @TenantRoles('owner', 'admin')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      role: z.string().optional(),
      manager_id: z.string().uuid().nullable().optional(),
      status: z.enum(['active', 'inactive']).optional(),
    }), body);
    if (b.manager_id === id) throw new BadRequestException('Someone cannot report to themselves');
    return this.db.withTenant(req.tenant!.id, async tx => {
      const u = (await tx.query(
        `SELECT u.id, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id])).rows[0];
      if (!u) throw new NotFoundException('User not found');
      if (u.role === 'owner') throw new ForbiddenException('The account owner can only be changed by HXG Connect support');
      if (id === req.tenantUser!.sub && b.status === 'inactive') throw new BadRequestException('You cannot deactivate yourself');

      let roleId: string | undefined;
      if (b.role) {
        if (b.role === 'owner') throw new BadRequestException('There is only one owner');
        roleId = (await tx.query(`SELECT id FROM roles WHERE key = $1`, [b.role])).rows[0]?.id;
        if (!roleId) throw new BadRequestException(`Unknown role "${b.role}"`);
      }
      const r = await tx.query(
        `UPDATE users SET role_id = COALESCE($2, role_id),
                manager_id = CASE WHEN $3 THEN $4::uuid ELSE manager_id END,
                status = COALESCE($5, status)
         WHERE id = $1 RETURNING id, name, email, status, manager_id`,
        [id, roleId ?? null, b.manager_id !== undefined, b.manager_id ?? null, b.status ?? null]);
      await audit(tx, req, 'user.updated', 'user', id, b);
      return r.rows[0];
    });
  }
}
