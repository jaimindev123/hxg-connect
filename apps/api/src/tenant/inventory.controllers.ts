import {
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode,
  Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { TenantGuard, TenantRoles } from '../common/guards';
import { activeUser, actorIn, findVisibleLead, leadArgs, leadIn, visibleLead } from '../common/scope';
import { audit, normalizePhone, parse, phoneSchema } from '../common/util';
import { IntegrationsService } from '../integrations/integrations.service';
import { commissionOnBooking } from './partners.controllers';

const INV_ADMIN = ['owner', 'admin', 'sales_manager'];
const BOOKERS = ['owner', 'admin', 'sales_manager', 'team_leader', 'sales_executive', 'crm_executive'];
const MONEY = ['owner', 'admin', 'sales_manager', 'finance'];
const MAX_SELF_DISCOUNT = 0.02;          // executives may give up to 2% without a manager
const actor = (req: Request) => (req.tenantUser!.imp ? null : req.tenantUser!.sub);
const round2 = (n: number) => Math.round(n * 100) / 100;
const EFFECTIVE_STATUS = `CASE WHEN u.status = 'hold' AND u.hold_expires_at < now() THEN 'available' ELSE u.status END`;

const leadFor = (tx: Tx, req: Request, leadId: string) => visibleLead(tx, req.scope!, leadId,
  { cols: 'l.id, l.name, l.owner_id, l.pipeline_id, l.stage_id, l.status, l.budget_min, l.budget_max, l.cp_id, l.cp_protected_until' });

/** Shared by manual receipts and Razorpay webhooks. Returns false when a
 *  Razorpay payment was already recorded (webhook replay). */
export async function applyPayment(tx: Tx, p: {
  tenantId: string; bookingId: string; scheduleId: string; amount: number; mode: string;
  reference?: string | null; razorpayPaymentId?: string | null; actorId?: string | null; receivedAt?: string;
}): Promise<boolean> {
  const s = (await tx.query(`SELECT amount, paid_amount FROM payment_schedule WHERE id = $1 AND booking_id = $2 FOR UPDATE`,
    [p.scheduleId, p.bookingId])).rows[0];
  if (!s) throw new NotFoundException('Instalment not found');
  const ins = await tx.query(
    `INSERT INTO payments (tenant_id, booking_id, schedule_id, amount, mode, reference, razorpay_payment_id, received_at, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9)
     ON CONFLICT (razorpay_payment_id) DO NOTHING RETURNING id`,
    [p.tenantId, p.bookingId, p.scheduleId, p.amount, p.mode, p.reference ?? null, p.razorpayPaymentId ?? null, p.receivedAt ?? null, p.actorId ?? null]);
  if (!ins.rowCount) return false;
  const paid = round2(Number(s.paid_amount) + p.amount);
  await tx.query(`UPDATE payment_schedule SET paid_amount = $2, status = $3 WHERE id = $1`,
    [p.scheduleId, paid, paid >= Number(s.amount) - 0.005 ? 'paid' : 'part_paid']);
  return true;
}

// =====================================================================
@Controller('projects')
@UseGuards(TenantGuard)
export class ProjectsController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT p.*, count(u.id)::int AS total,
              count(u.id) FILTER (WHERE ${EFFECTIVE_STATUS} = 'available')::int AS available,
              count(u.id) FILTER (WHERE ${EFFECTIVE_STATUS} = 'hold')::int AS on_hold,
              count(u.id) FILTER (WHERE u.status = 'booked')::int AS booked
       FROM projects p LEFT JOIN units u ON u.project_id = p.id
       GROUP BY p.id ORDER BY p.status = 'completed', p.name`))).rows;
  }

  @Post() @TenantRoles(...INV_ADMIN)
  async create(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      name: z.string().trim().min(2).max(120), city: z.string().trim().max(80).optional(),
      locality: z.string().trim().max(120).optional(), rera_number: z.string().trim().max(60).optional(),
      status: z.enum(['upcoming', 'active', 'completed']).default('active'),
      possession_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      try {
        const p = (await tx.query(
          `INSERT INTO projects (tenant_id, name, city, locality, rera_number, status, possession_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [req.tenant!.id, b.name, b.city ?? null, b.locality ?? null, b.rera_number ?? null, b.status, b.possession_date ?? null])).rows[0];
        await audit(tx, req, 'project.created', 'project', p.id, { name: b.name });
        return p;
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException(`A project called "${b.name}" already exists`);
        throw e;
      }
    });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const p = (await tx.query(`SELECT * FROM projects WHERE id = $1`, [id])).rows[0];
      if (!p) throw new NotFoundException('Project not found');
      const towers = (await tx.query(
        `SELECT t.id, t.name, t.floors, count(u.id)::int AS total,
                count(u.id) FILTER (WHERE ${EFFECTIVE_STATUS} = 'available')::int AS available
         FROM towers t LEFT JOIN units u ON u.tower_id = t.id WHERE t.project_id = $1 GROUP BY t.id ORDER BY t.name`, [id])).rows;
      const plans = (await tx.query(`SELECT id, name, milestones FROM payment_plans WHERE project_id = $1 ORDER BY created_at`, [id])).rows;
      return { ...p, towers, plans };
    });
  }

  /** Generate a whole tower: floors × positions, priced by layout + floor rise. */
  @Post(':id/towers') @TenantRoles(...INV_ADMIN)
  async addTower(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      name: z.string().trim().min(1).max(40),
      floors: z.number().int().min(1).max(120),
      start_floor: z.number().int().min(0).max(5).default(1),
      floor_rise: z.number().min(0).max(1e7).default(0),
      layout: z.array(z.object({
        unit_type: z.string().trim().min(1).max(30),
        carpet_sqft: z.number().positive().optional(), super_sqft: z.number().positive().optional(),
        facing: z.string().trim().max(20).optional(), base_price: z.number().positive(),
      })).min(1).max(20),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      if (!(await tx.query(`SELECT 1 FROM projects WHERE id = $1`, [id])).rowCount) throw new NotFoundException('Project not found');
      let t;
      try {
        t = (await tx.query(`INSERT INTO towers (tenant_id, project_id, name, floors) VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.tenant!.id, id, b.name, b.floors])).rows[0];
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException(`Tower "${b.name}" already exists in this project`);
        throw e;
      }
      const cols: Record<string, unknown[]> = { floor: [], unit_no: [], unit_type: [], carpet: [], super: [], facing: [], price: [] };
      for (let f = b.start_floor; f < b.start_floor + b.floors; f++) {
        b.layout.forEach((l, i) => {
          cols.floor.push(f); cols.unit_no.push(`${f}${String(i + 1).padStart(2, '0')}`); cols.unit_type.push(l.unit_type);
          cols.carpet.push(l.carpet_sqft ?? null); cols.super.push(l.super_sqft ?? null); cols.facing.push(l.facing ?? null);
          cols.price.push(round2(l.base_price + b.floor_rise * (f - b.start_floor)));
        });
      }
      const r = await tx.query(
        `INSERT INTO units (tenant_id, project_id, tower_id, floor, unit_no, unit_type, carpet_sqft, super_sqft, facing, base_price)
         SELECT $1, $2, $3, * FROM unnest($4::int[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[], $10::numeric[])`,
        [req.tenant!.id, id, t.id, cols.floor, cols.unit_no, cols.unit_type, cols.carpet, cols.super, cols.facing, cols.price]);
      await audit(tx, req, 'tower.created', 'tower', t.id, { units: r.rowCount });
      return { ...t, units_created: r.rowCount };
    });
  }

  @Post(':id/payment-plans') @TenantRoles(...INV_ADMIN)
  async addPlan(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      name: z.string().trim().min(2).max(80),
      milestones: z.array(z.object({
        label: z.string().trim().min(2).max(80),
        percent: z.number().positive().max(100),
        due_days: z.number().int().min(0).max(3650).nullable().optional(),
      })).min(1).max(30),
    }).refine(p => Math.abs(p.milestones.reduce((s, m) => s + m.percent, 0) - 100) < 0.001,
      { message: 'Milestones must add up to exactly 100%', path: ['milestones'] }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      if (!(await tx.query(`SELECT 1 FROM projects WHERE id = $1`, [id])).rowCount) throw new NotFoundException('Project not found');
      return (await tx.query(`INSERT INTO payment_plans (tenant_id, project_id, name, milestones) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.tenant!.id, id, b.name, JSON.stringify(b.milestones.map(m => ({ ...m, due_days: m.due_days ?? null })))])).rows[0];
    });
  }
}

// =====================================================================
@Controller()
@UseGuards(TenantGuard)
export class UnitsController {
  constructor(private readonly db: Db) {}

  @Get('towers/:id/units')
  async grid(@Param('id') id: string, @Req() req: Request) {
    // Everyone sees that a unit is on hold and who placed it; only people who
    // can see that buyer's lead see the buyer's name.
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT u.id, u.floor, u.unit_no, u.unit_type, u.carpet_sqft, u.super_sqft, u.facing, u.base_price,
              ${EFFECTIVE_STATUS} AS status, u.hold_expires_at,
              CASE WHEN ${leadIn('l', 2)} THEN l.id END AS hold_lead_id,
              CASE WHEN ${leadIn('l', 2)} THEN l.name END AS hold_lead_name,
              CASE WHEN l.id IS NOT NULL THEN hb.name END AS hold_by_name,
              b.id AS booking_id
       FROM units u LEFT JOIN leads l ON l.id = u.hold_lead_id AND u.status = 'hold' AND u.hold_expires_at >= now()
       LEFT JOIN users hb ON hb.id = u.hold_by
       LEFT JOIN bookings b ON b.unit_id = u.id AND b.status <> 'cancelled'
       WHERE u.tower_id = $1 ORDER BY u.floor DESC, u.unit_no`, [id, ...leadArgs(req.scope!)]))).rows;
  }

  /** Units that fit a lead's budget (±10%), cheapest-close-to-budget first. */
  @Get('units/match')
  async match(@Query('lead_id') leadId: string, @Req() req: Request) {
    if (!leadId) throw new BadRequestException('lead_id is required');
    return this.db.withTenant(req.tenant!.id, async tx => {
      const l = await leadFor(tx, req, leadId);
      if (!l.budget_max && !l.budget_min) return [];
      const lo = Number(l.budget_min ?? l.budget_max) * 0.9, hi = Number(l.budget_max ?? l.budget_min) * 1.1;
      return (await tx.query(
        `SELECT u.id, u.unit_no, u.unit_type, u.super_sqft, u.facing, u.base_price, u.floor,
                t.name AS tower, p.id AS project_id, p.name AS project
         FROM units u JOIN towers t ON t.id = u.tower_id JOIN projects p ON p.id = u.project_id
         WHERE ${EFFECTIVE_STATUS} = 'available' AND u.base_price BETWEEN $1 AND $2 AND p.status <> 'completed'
         ORDER BY abs(u.base_price - $2 / 1.1) LIMIT 12`, [lo, hi])).rows;
    });
  }

  @Patch('units/:id') @TenantRoles(...INV_ADMIN)
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ base_price: z.number().positive().optional(), status: z.enum(['available', 'blocked']).optional() }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const u = (await tx.query(`SELECT status FROM units WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!u) throw new NotFoundException('Unit not found');
      if (u.status === 'booked') throw new ConflictException('This unit is booked. Cancel the booking first.');
      const r = (await tx.query(
        `UPDATE units SET base_price = COALESCE($2, base_price), status = COALESCE($3, status),
           hold_lead_id = CASE WHEN $3 IS NULL THEN hold_lead_id END, hold_by = CASE WHEN $3 IS NULL THEN hold_by END,
           hold_expires_at = CASE WHEN $3 IS NULL THEN hold_expires_at END, updated_at = now()
         WHERE id = $1 RETURNING id, base_price, status`, [id, b.base_price ?? null, b.status ?? null])).rows[0];
      await audit(tx, req, 'unit.updated', 'unit', id, b);
      return r;
    });
  }

  @Post('units/:id/hold') @HttpCode(200) @TenantRoles(...BOOKERS)
  async hold(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ lead_id: z.string().uuid(), hours: z.number().int().min(1).max(168).default(48) }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const l = await leadFor(tx, req, b.lead_id);
      const u = (await tx.query(`SELECT * FROM units WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!u) throw new NotFoundException('Unit not found');
      const heldByOther = u.status === 'hold' && new Date(u.hold_expires_at) > new Date() && u.hold_lead_id !== l.id;
      if (u.status === 'booked' || u.status === 'blocked' || heldByOther) {
        throw new ConflictException({ code: 'unit_unavailable', message: `Unit ${u.unit_no} is ${heldByOther ? 'on hold for another buyer' : u.status}` });
      }
      const r = (await tx.query(
        `UPDATE units SET status = 'hold', hold_lead_id = $2, hold_by = $3, hold_expires_at = now() + make_interval(hours => $4), updated_at = now()
         WHERE id = $1 RETURNING id, unit_no, status, hold_expires_at`, [id, l.id, actor(req), b.hours])).rows[0];
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body) VALUES ($1,$2,'system',$3,$4)`,
        [req.tenant!.id, l.id, actor(req), `Unit ${u.unit_no} held for ${b.hours} hours`]);
      return r;
    });
  }

  @Post('units/:id/release') @HttpCode(200) @TenantRoles(...BOOKERS)
  async release(@Param('id') id: string, @Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const r = await tx.query(
        `UPDATE units SET status = 'available', hold_lead_id = NULL, hold_by = NULL, hold_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'hold' AND (hold_by = $2 OR $3) RETURNING id, status`,
        [id, req.tenantUser!.sub, INV_ADMIN.includes(req.tenantUser!.role)]);
      if (!r.rowCount) throw new NotFoundException('No hold of yours on this unit');
      return r.rows[0];
    });
  }
}

// =====================================================================
const nextStep = z.object({ type: z.enum(['call', 'whatsapp', 'email', 'meeting', 'site_visit']), due_at: z.string().datetime({ offset: true }) });

@Controller('site-visits')
@UseGuards(TenantGuard)
export class SiteVisitsController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request, @Query('range') range = 'upcoming') {
    const sc = req.scope!;
    const where = range === 'past' ? `v.scheduled_at < date_trunc('day', now())`
      : range === 'today' ? `v.scheduled_at >= date_trunc('day', now()) AND v.scheduled_at < date_trunc('day', now()) + interval '1 day'`
      : `v.scheduled_at >= date_trunc('day', now())`;
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT v.*, l.name AS lead_name, l.primary_phone, p.name AS project, u.name AS executive,
              (v.checkin_id IS NOT NULL) AS verified
       FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN projects p ON p.id = v.project_id
       LEFT JOIN users u ON u.id = v.executive_id
       WHERE ${where} AND (${leadIn('l', 1)} OR ${actorIn('v.executive_id', 3)})
       ORDER BY v.scheduled_at ${range === 'past' ? 'DESC' : 'ASC'} LIMIT 200`, [...leadArgs(sc), sc.actors]))).rows;
  }

  @Post()
  async schedule(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      lead_id: z.string().uuid(), project_id: z.string().uuid(),
      scheduled_at: z.string().datetime({ offset: true }), executive_id: z.string().uuid().optional(),
      note: z.string().trim().max(500).optional(),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const l = await leadFor(tx, req, b.lead_id);
      const p = (await tx.query(`SELECT name FROM projects WHERE id = $1`, [b.project_id])).rows[0];
      if (!p) throw new BadRequestException('Project not found');
      const exec = b.executive_id ? await activeUser(tx, b.executive_id) : l.owner_id ?? actor(req);
      // The visit doubles as the lead's next step, so it shows in My Day.
      const fu = (await tx.query(
        `INSERT INTO follow_ups (tenant_id, lead_id, assigned_to, type, due_at, note, created_by)
         VALUES ($1,$2,$3,'site_visit',$4,$5,$6) RETURNING id`,
        [req.tenant!.id, l.id, exec, b.scheduled_at, b.note ?? `Site visit at ${p.name}`, actor(req)])).rows[0];
      const v = (await tx.query(
        `INSERT INTO site_visits (tenant_id, lead_id, project_id, executive_id, follow_up_id, scheduled_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.tenant!.id, l.id, b.project_id, exec, fu.id, b.scheduled_at, actor(req)])).rows[0];
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body) VALUES ($1,$2,'system',$3,$4)`,
        [req.tenant!.id, l.id, actor(req), `Site visit scheduled at ${p.name}`]);
      return v;
    });
  }

  /** Outcome + feedback; links the executive's on-site selfie check-in as proof. */
  @Post(':id/complete') @HttpCode(200)
  async complete(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      outcome: z.enum(['completed', 'no_show']), interest: z.number().int().min(1).max(5).optional(),
      notes: z.string().trim().max(2000).optional(), next: nextStep.optional(),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const v = (await tx.query(`SELECT * FROM site_visits WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      const l = v && await findVisibleLead(tx, req.scope!, v.lead_id, { cols: 'l.id, l.owner_id, l.status' });
      if (!v || !l) throw new NotFoundException('Visit not found');
      if (v.status !== 'scheduled') throw new BadRequestException(`This visit is already ${v.status}`);
      const otherPending = (await tx.query(
        `SELECT 1 FROM follow_ups WHERE lead_id = $1 AND status = 'pending' AND id IS DISTINCT FROM $2 LIMIT 1`, [l.id, v.follow_up_id])).rowCount;
      if (l.status === 'open' && !b.next && !otherPending) {
        throw new BadRequestException({ code: 'next_action_required', message: 'Schedule the next step for this buyer.' });
      }
      const checkin = b.outcome === 'completed' ? (await tx.query(
        `SELECT id FROM field_checkins WHERE user_id = $1 AND type = 'site_visit_in'
           AND captured_at BETWEEN $2::timestamptz - interval '6 hours' AND now()
         ORDER BY abs(extract(epoch FROM captured_at - $2::timestamptz)) LIMIT 1`, [v.executive_id, v.scheduled_at])).rows[0] : null;
      await tx.query(
        `UPDATE site_visits SET status = $2, interest = $3, notes = $4, completed_at = now(), checkin_id = $5 WHERE id = $1`,
        [id, b.outcome, b.interest ?? null, b.notes ?? null, checkin?.id ?? null]);
      if (v.follow_up_id) await tx.query(`UPDATE follow_ups SET status = 'done', outcome = $2, completed_at = now() WHERE id = $1 AND status = 'pending'`,
        [v.follow_up_id, b.outcome === 'no_show' ? 'Buyer did not turn up' : (b.notes ?? 'Visit completed')]);
      if (b.outcome === 'completed') {
        // Move forward to "Site Visit" if the lead is still before it.
        await tx.query(
          `UPDATE leads SET stage_id = s.id, updated_at = now() FROM pipeline_stages s, pipeline_stages cur
           WHERE leads.id = $1 AND s.pipeline_id = leads.pipeline_id AND s.name = 'Site Visit'
             AND cur.id = leads.stage_id AND cur.position < s.position AND leads.status = 'open'`, [l.id]);
      }
      if (b.next) await tx.query(
        `INSERT INTO follow_ups (tenant_id, lead_id, assigned_to, type, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.tenant!.id, l.id, l.owner_id ?? actor(req), b.next.type, b.next.due_at, actor(req)]);
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'site_visit',$3,$4,$5)`,
        [req.tenant!.id, l.id, actor(req), b.notes ?? (b.outcome === 'no_show' ? 'Did not turn up' : 'Visited the site'),
         { outcome: b.outcome, interest: b.interest, verified: !!checkin }]);
      await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [l.id]);
      return { id, status: b.outcome, verified: !!checkin };
    });
  }

  @Post(':id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const found = (await tx.query(`SELECT lead_id FROM site_visits WHERE id = $1 AND status = 'scheduled' FOR UPDATE`, [id])).rows[0];
      if (!found || !(await findVisibleLead(tx, req.scope!, found.lead_id, { cols: 'l.id' }))) throw new NotFoundException('No scheduled visit with that id');
      const v = (await tx.query(`UPDATE site_visits SET status = 'cancelled' WHERE id = $1 RETURNING follow_up_id, lead_id`, [id])).rows[0];
      if (v.follow_up_id) await tx.query(`UPDATE follow_ups SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [v.follow_up_id]);
      return { id, status: 'cancelled' };
    });
  }
}

// =====================================================================
@Controller('bookings')
@UseGuards(TenantGuard)
export class BookingsController {
  constructor(private readonly db: Db, private readonly integrations: IntegrationsService) {}

  @Get()
  async list(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT b.id, b.status, b.booked_at, b.agreed_price, b.applicant, l.id AS lead_id, l.name AS lead_name,
              u.unit_no, u.unit_type, t.name AS tower, p.name AS project,
              COALESCE((SELECT sum(paid_amount) FROM payment_schedule s WHERE s.booking_id = b.id), 0)::numeric AS paid,
              COALESCE((SELECT sum(amount - paid_amount) FROM payment_schedule s WHERE s.booking_id = b.id
                        AND s.due_date < current_date AND s.status <> 'paid'), 0)::numeric AS overdue
       FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id
       JOIN towers t ON t.id = u.tower_id JOIN projects p ON p.id = u.project_id
       WHERE ${leadIn('l', 1)} ORDER BY b.booked_at DESC LIMIT 500`, leadArgs(req.scope!)))).rows;
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      const b = (await tx.query(
        `SELECT b.*, l.name AS lead_name, l.owner_id, u.unit_no, u.unit_type, u.super_sqft, t.name AS tower, p.name AS project, pp.name AS plan_name
         FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id JOIN towers t ON t.id = u.tower_id
         JOIN projects p ON p.id = u.project_id LEFT JOIN payment_plans pp ON pp.id = b.payment_plan_id WHERE b.id = $1`, [id])).rows[0];
      if (!b || !(await findVisibleLead(tx, req.scope!, b.lead_id, { cols: 'l.id' }))) throw new NotFoundException('Booking not found');
      const schedule = (await tx.query(`SELECT * FROM payment_schedule WHERE booking_id = $1 ORDER BY seq`, [id])).rows;
      const payments = (await tx.query(
        `SELECT pm.*, u.name AS recorded_by_name FROM payments pm LEFT JOIN users u ON u.id = pm.recorded_by
         WHERE pm.booking_id = $1 ORDER BY pm.received_at DESC`, [id])).rows;
      return { ...b, schedule, payments };
    });
  }

  @Post() @TenantRoles(...BOOKERS)
  async create(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      lead_id: z.string().uuid(), unit_id: z.string().uuid(), payment_plan_id: z.string().uuid(),
      agreed_price: z.number().positive(),
      applicant: z.object({ name: z.string().trim().min(2).max(120), phone: phoneSchema,
        email: z.string().trim().email().optional(), co_applicant: z.string().trim().max(120).optional() }),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const l = await leadFor(tx, req, b.lead_id);
      const u = (await tx.query(
        `SELECT u.*, t.name AS tower FROM units u JOIN towers t ON t.id = u.tower_id WHERE u.id = $1 FOR UPDATE OF u`, [b.unit_id])).rows[0];
      if (!u) throw new NotFoundException('Unit not found');
      const holdLive = u.status === 'hold' && new Date(u.hold_expires_at) > new Date();
      if (u.status === 'booked' || u.status === 'blocked' || (holdLive && u.hold_lead_id !== l.id)) {
        throw new ConflictException({ code: 'unit_unavailable', message: `Unit ${u.unit_no} is ${holdLive ? 'on hold for another buyer' : u.status}` });
      }
      const plan = (await tx.query(`SELECT milestones FROM payment_plans WHERE id = $1 AND project_id = $2`, [b.payment_plan_id, u.project_id])).rows[0];
      if (!plan) throw new BadRequestException('Choose a payment plan from this unit\'s project');
      const list = Number(u.base_price);
      if (b.agreed_price < list * (1 - MAX_SELF_DISCOUNT) && !INV_ADMIN.includes(req.tenantUser!.role)) {
        throw new ForbiddenException({ code: 'discount_needs_approval',
          message: `Discounts over ${MAX_SELF_DISCOUNT * 100}% need a sales manager. Ask one to make this booking.` });
      }
      let booking;
      try {
        booking = (await tx.query(
          `INSERT INTO bookings (tenant_id, lead_id, unit_id, payment_plan_id, applicant, list_price, agreed_price, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [req.tenant!.id, l.id, u.id, b.payment_plan_id, { ...b.applicant, phone: normalizePhone(b.applicant.phone) },
           list, b.agreed_price, actor(req)])).rows[0];
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException({ code: 'unit_unavailable', message: `Unit ${u.unit_no} was just booked` });
        throw e;
      }
      // Schedule: each milestone's share; the last absorbs rounding so it sums exactly.
      const ms = plan.milestones as { label: string; percent: number; due_days: number | null }[];
      let allocated = 0;
      for (const [i, m] of ms.entries()) {
        const amount = i === ms.length - 1 ? round2(b.agreed_price - allocated) : round2(b.agreed_price * m.percent / 100);
        allocated = round2(allocated + amount);
        await tx.query(
          `INSERT INTO payment_schedule (tenant_id, booking_id, seq, label, percent, amount, due_date)
           VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE current_date + $7::int END)`,
          [req.tenant!.id, booking.id, i + 1, m.label, m.percent, amount, m.due_days]);
      }
      await tx.query(`UPDATE units SET status = 'booked', hold_lead_id = NULL, hold_by = NULL, hold_expires_at = NULL, updated_at = now() WHERE id = $1`, [u.id]);
      await tx.query(
        `UPDATE leads SET stage_id = s.id, status = 'won', last_activity_at = now(), updated_at = now()
         FROM pipeline_stages s WHERE leads.id = $1 AND s.id = (SELECT id FROM pipeline_stages WHERE pipeline_id = $2 AND is_won ORDER BY position LIMIT 1)`,
        [l.id, l.pipeline_id]);
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'booking',$3,$4,$5)`,
        [req.tenant!.id, l.id, actor(req), `Booked ${u.tower}-${u.unit_no}`, { booking_id: booking.id, agreed_price: b.agreed_price }]);
      await audit(tx, req, 'booking.created', 'booking', booking.id, { unit: u.unit_no, agreed_price: b.agreed_price, list_price: list });
      await commissionOnBooking(tx, req.tenant!.id, l, { id: booking.id, agreed_price: b.agreed_price });
      return booking;
    });
  }

  @Post(':id/payments') @TenantRoles(...MONEY)
  async pay(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({
      schedule_id: z.string().uuid(), amount: z.number().positive(),
      mode: z.enum(['cash', 'cheque', 'neft', 'upi', 'other']), reference: z.string().trim().max(120).optional(),
      received_at: z.string().datetime({ offset: true }).optional(),
    }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const bk = (await tx.query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0];
      if (!bk) throw new NotFoundException('Booking not found');
      if (bk.status === 'cancelled') throw new BadRequestException('This booking is cancelled');
      const s = (await tx.query(`SELECT amount, paid_amount FROM payment_schedule WHERE id = $1 AND booking_id = $2`, [b.schedule_id, id])).rows[0];
      if (!s) throw new NotFoundException('Instalment not found');
      const left = round2(Number(s.amount) - Number(s.paid_amount));
      if (b.amount > left + 0.005) throw new BadRequestException({ code: 'overpayment', message: `Only ₹${left.toLocaleString('en-IN')} is due on this instalment` });
      await applyPayment(tx, { tenantId: req.tenant!.id, bookingId: id, scheduleId: b.schedule_id, amount: b.amount,
        mode: b.mode, reference: b.reference, actorId: actor(req), receivedAt: b.received_at });
      await audit(tx, req, 'payment.recorded', 'booking', id, { amount: b.amount, mode: b.mode });
      return { ok: true };
    });
  }

  /** Razorpay payment link for what's left on an instalment, using the
   *  client's own keys from Settings. Confirmation arrives by webhook. */
  @Post(':id/schedule/:sid/payment-link') @HttpCode(200) @TenantRoles(...MONEY)
  async paymentLink(@Param('id') id: string, @Param('sid') sid: string, @Req() req: Request) {
    const rzp = await this.integrations.credentials('tenant', req.tenant!.id, 'razorpay');
    if (!rzp?.enabled) throw new BadRequestException({ code: 'razorpay_not_connected', message: 'Connect Razorpay in Settings > Integrations first' });
    const row = (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT s.*, b.applicant, b.status AS booking_status, u.unit_no, t.name AS tower FROM payment_schedule s
       JOIN bookings b ON b.id = s.booking_id JOIN units u ON u.id = b.unit_id JOIN towers t ON t.id = u.tower_id
       WHERE s.id = $1 AND s.booking_id = $2`, [sid, id]))).rows[0];
    if (!row) throw new NotFoundException('Instalment not found');
    if (row.booking_status === 'cancelled') throw new BadRequestException('This booking is cancelled');
    const left = round2(Number(row.amount) - Number(row.paid_amount));
    if (left <= 0) throw new BadRequestException('This instalment is already paid');

    let res: Response;
    try {
      res = await fetch(`${config.providerBase.razorpay}/v1/payment_links`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${rzp.config.key_id}:${rzp.secrets.key_secret}`).toString('base64')}` },
        body: JSON.stringify({
          amount: Math.round(left * 100), currency: 'INR', accept_partial: false,
          reference_id: `${sid.slice(0, 8)}-${Date.now().toString(36)}`,
          description: `${row.label}, unit ${row.tower}-${row.unit_no}`.slice(0, 2048),
          customer: { name: row.applicant.name, contact: row.applicant.phone, ...(row.applicant.email && { email: row.applicant.email }) },
          notify: { sms: true, email: !!row.applicant.email }, reminder_enable: true,
          notes: { tenant_id: req.tenant!.id, booking_id: id, schedule_id: sid },
        }),
      });
    } catch {
      throw new BadGatewayException('Razorpay could not be reached. Try again in a minute.');
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadGatewayException(data?.error?.description ?? `Razorpay refused the request (${res.status})`);
    await this.db.withTenant(req.tenant!.id, async tx => {
      await tx.query(`UPDATE payment_schedule SET payment_link_id = $2, payment_link_url = $3 WHERE id = $1`, [sid, data.id, data.short_url]);
      await audit(tx, req, 'payment_link.created', 'booking', id, { schedule_id: sid, amount: left });
    });
    return { url: data.short_url, amount: left };
  }

  @Post(':id/cancel') @HttpCode(200) @TenantRoles('owner', 'admin', 'sales_manager')
  async cancel(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const b = (await tx.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2
         WHERE id = $1 AND status <> 'cancelled' RETURNING unit_id, lead_id`, [id, reason])).rows[0];
      if (!b) throw new NotFoundException('No active booking with that id');
      await tx.query(`UPDATE units SET status = 'available', updated_at = now() WHERE id = $1`, [b.unit_id]);
      // Unpaid commission falls away with the booking; money already paid is left for finance to recover.
      await tx.query(`UPDATE cp_commissions SET status = 'cancelled' WHERE booking_id = $1 AND status IN ('pending','approved')`, [id]);
      await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body) VALUES ($1,$2,'system',$3,$4)`,
        [req.tenant!.id, b.lead_id, actor(req), `Booking cancelled: ${reason}`]);
      await audit(tx, req, 'booking.cancelled', 'booking', id, { reason });
      return { id, status: 'cancelled' };
    });
  }
}

// =====================================================================
@Injectable()
export class HoldSweeper implements OnModuleInit, OnModuleDestroy {
  private t?: NodeJS.Timeout;
  constructor(private readonly db: Db) {}
  onModuleInit() {
    this.t = setInterval(() => this.db.appNoTenant('SELECT release_expired_holds()').catch(() => undefined), 60_000);
    this.t.unref();
  }
  onModuleDestroy() { if (this.t) clearInterval(this.t); }
}
