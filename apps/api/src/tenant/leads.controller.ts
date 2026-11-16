import {
  BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException,
  Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { TenantGuard } from '../common/guards';
import { audit, parse } from '../common/util';
import { intakeLead, leadInputSchema } from './lead-intake';
import { activeUser, leadArgs, leadIn, visibleLead } from '../common/scope';

@Controller('leads')
@UseGuards(TenantGuard)
export class LeadsController {
  constructor(private readonly db: Db) {}

  /** Everything this person can see, as a spreadsheet. A full copy of the
   *  client's leads is theirs to take, so it is limited to the roles that
   *  manage the data, and every export is recorded. */
  @Get('export')
  async export(@Req() req: Request, @Res() res: Response) {
    if (!['owner', 'admin', 'sales_manager', 'crm_executive'].includes(req.tenantUser!.role) || req.tenantUser!.imp) {
      throw new ForbiddenException('Only the owner, admins, sales managers and CRM executives can export leads');
    }
    const rows = await this.db.withTenant(req.tenant!.id, async tx => {
      const r = (await tx.query(
        `SELECT l.name, l.primary_phone, l.email, s.name AS stage, l.status, l.source, u.name AS owner, l.budget_min, l.budget_max,
                l.property_type, array_to_string(l.preferred_locations, '; ') AS locations, array_to_string(l.tags, '; ') AS tags,
                to_char(l.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS created
         FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id LEFT JOIN users u ON u.id = l.owner_id
         WHERE ${leadIn('l', 1)} ORDER BY l.created_at DESC LIMIT 50000`, leadArgs(req.scope!))).rows;
      await audit(tx, req, 'leads.exported', undefined, undefined, { rows: r.length });
      return r;
    });
    const cols: [string, string][] = [['name', 'Name'], ['primary_phone', 'Phone'], ['email', 'Email'], ['stage', 'Stage'], ['status', 'Status'], ['source', 'Source'],
      ['owner', 'Assigned to'], ['budget_min', 'Budget from'], ['budget_max', 'Budget to'], ['property_type', 'Property type'], ['locations', 'Preferred locations'],
      ['tags', 'Tags'], ['created', 'Created (IST)']];
    // Text a spreadsheet would run as a formula is neutralised; a plain +91… number is left readable.
    const cell = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(t) && !/^\+\d+$/.test(t) ? `'${t}` : t; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [cols.map(c => c[1]).join(','), ...rows.map(r => cols.map(c => cell(r[c[0]])).join(','))].join('\r\n'));
  }

  @Get()
  async list(@Req() req: Request,
             @Query('cursor') cursor?: string, @Query('limit') limitQ?: string,
             @Query('stage_id') stageId?: string, @Query('q') q?: string) {
    const limit = Math.min(Math.max(Number(limitQ) || 50, 1), 200);
    let afterTs: string | null = null, afterId: string | null = null;
    if (cursor) {
      try { [afterTs, afterId] = Buffer.from(cursor, 'base64url').toString().split('|'); }
      catch { throw new BadRequestException('Bad cursor'); }
    }

    const rows = (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT l.id, l.name, l.primary_phone, l.email, l.source, l.budget_min, l.budget_max,
              l.property_type, l.tags, l.status, l.created_at, l.last_activity_at,
              s.id AS stage_id, s.name AS stage, u.id AS owner_id, u.name AS owner
       FROM leads l
       JOIN pipeline_stages s ON s.id = l.stage_id
       LEFT JOIN users u ON u.id = l.owner_id
       WHERE ${leadIn('l', 1)}
         AND ($3::uuid IS NULL OR l.stage_id = $3)
         AND ($4::text IS NULL OR l.name ILIKE '%' || $4 || '%' OR l.primary_phone LIKE '%' || $4 || '%')
         AND ($5::timestamptz IS NULL OR (l.created_at, l.id) < ($5, $6::uuid))
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $7`,
      [...leadArgs(req.scope!), stageId ?? null, q ?? null, afterTs, afterId, limit + 1]))).rows;

    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      data: page,
      next_cursor: more ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parse(leadInputSchema, body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      if (b.owner_id) await activeUser(tx, b.owner_id);   // only a live member of this workspace can own it
      const r = await intakeLead(tx, { tenantId: req.tenant!.id, limits: req.tenant!.limits, actorId: this.actor(req), channel: 'manual' }, b);
      if (r.duplicate_of) {
        await audit(tx, req, 'lead.re_enquiry', 'lead', r.duplicate_of, { source: b.source });
        res.status(200);
        return { duplicate_of: r.duplicate_of, action: 'activity_appended' };
      }
      await audit(tx, req, 'lead.created', 'lead', r.lead.id, { assigned_by: r.assigned_by });
      res.status(201);
      return { ...r.lead, assigned_by: r.assigned_by, duplicate_of: null };
    });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    return this.db.withTenant(req.tenant!.id, async tx => {
      // Another company's lead doesn't exist from here (RLS); a colleague's
      // lead outside your scope gets the same "not found".
      await visibleLead(tx, req.scope!, id, { cols: 'l.id' });
      const lead = (await tx.query(
        `SELECT l.*, s.name AS stage, u.name AS owner FROM leads l
         JOIN pipeline_stages s ON s.id = l.stage_id LEFT JOIN users u ON u.id = l.owner_id
         WHERE l.id = $1`, [id])).rows[0];
      if (!lead) throw new NotFoundException('Lead not found');
      const timeline = (await tx.query(
        `SELECT a.id, a.type, a.body, a.meta, a.occurred_at, u.name AS actor
         FROM activities a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.lead_id = $1 ORDER BY a.occurred_at DESC LIMIT 100`, [id])).rows;
      return { ...lead, timeline };
    });
  }

  @Post(':id/stage')
  async moveStage(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ stage_id: z.string().uuid(), note: z.string().trim().max(2000).optional() }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const lead = await visibleLead(tx, req.scope!, id, { cols: 'l.id, l.pipeline_id, l.stage_id, l.owner_id', lock: true });

      const to = (await tx.query(
        `SELECT id, name, is_won, is_lost FROM pipeline_stages WHERE id = $1 AND pipeline_id = $2`,
        [b.stage_id, lead.pipeline_id])).rows[0];
      if (!to) throw new BadRequestException('That stage is not in this lead\'s pipeline');
      if (to.is_lost && !b.note) throw new BadRequestException({ code: 'lost_reason_required', message: 'Say why it was lost' });

      const status = to.is_won ? 'won' : to.is_lost ? 'lost' : 'open';
      await tx.query(`UPDATE leads SET stage_id = $2, status = $3, last_activity_at = now(), updated_at = now() WHERE id = $1`,
        [id, to.id, status]);
      await tx.query(
        `INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'stage_change',$3,$4,$5)`,
        [req.tenant!.id, id, this.actor(req), b.note ?? null, { from: lead.stage_id, to: to.id, to_name: to.name }]);
      await audit(tx, req, 'lead.stage_changed', 'lead', id, { to: to.name });
      return { id, stage_id: to.id, stage: to.name, status };
    });
  }

  @Post(':id/notes')
  async addNote(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { body: text } = parse(z.object({ body: z.string().trim().min(1).max(5000) }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      await visibleLead(tx, req.scope!, id, { cols: 'l.id' });
      const a = (await tx.query(
        `INSERT INTO activities (tenant_id, lead_id, type, actor_id, body) VALUES ($1,$2,'note',$3,$4)
         RETURNING id, type, body, occurred_at`, [req.tenant!.id, id, this.actor(req), text])).rows[0];
      await tx.query(`UPDATE leads SET last_activity_at = now() WHERE id = $1`, [id]);
      return a;
    });
  }

  // ---- helpers -----------------------------------------------------
  private actor(req: Request): string | null {
    return req.tenantUser!.imp ? null : req.tenantUser!.sub;   // support never "owns" activity
  }
}
