import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '../db/db.service';
import { normalizePhone, phoneSchema } from '../common/util';

export const leadInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: phoneSchema,
  email: z.string().trim().toLowerCase().email().optional(),
  whatsapp_number: phoneSchema.optional(),
  source: z.string().trim().max(60).optional(),
  budget_min: z.number().nonnegative().optional(),
  budget_max: z.number().nonnegative().optional(),
  property_type: z.enum(['apartment', 'villa', 'plot', 'commercial', 'office']).optional(),
  preferred_locations: z.array(z.string().trim()).max(20).default([]),
  tags: z.array(z.string().trim().max(40)).max(50).default([]),
  custom_fields: z.record(z.unknown()).default({}),
  owner_id: z.string().uuid().optional(),
  note: z.string().trim().max(5000).optional(),          // website message, import notes
}).refine(v => v.budget_min === undefined || v.budget_max === undefined || v.budget_min <= v.budget_max,
  { message: 'budget_min must be ≤ budget_max', path: ['budget_min'] });
export type LeadInput = z.infer<typeof leadInputSchema>;

export interface IntakeContext {
  tenantId: string;
  limits: Record<string, number>;
  actorId: string | null;
  channel: 'manual' | 'website' | 'import' | 'facebook' | 'google_ads' | 'phone' | 'whatsapp' | 'portal' | 'email' | 'connector';
  remaining?: { n: number };     // imports pre-count capacity once instead of per row
}

export type IntakeResult =
  | { duplicate_of: string; lead?: undefined; assigned_by?: undefined }
  | { duplicate_of: null; lead: any; assigned_by: string };

/** "85L", "85 lakh", "1.2 Cr", "₹85,00,000", "8500000" → rupees. */
export function parseBudget(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).toLowerCase().replace(/[₹,\s]/g, '').replace(/rs\.?|inr/g, '');
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)(cr|crore|crores|l|lac|lakh|lakhs|k)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = !m[2] ? 1 : m[2].startsWith('c') ? 1e7 : m[2] === 'k' ? 1e3 : 1e5;
  return Math.round(n * mult);
}

export async function intakeLead(tx: Tx, ctx: IntakeContext, input: LeadInput): Promise<IntakeResult> {
  const phone = normalizePhone(input.phone);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ctx.tenantId}:${phone}`]);

  const dup = (await tx.query(`SELECT lead_id FROM lead_phones WHERE phone = $1`, [phone])).rows[0];
  if (dup) {
    await tx.query(
      `INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'re_enquiry',$3,$4,$5)`,
      [ctx.tenantId, dup.lead_id, ctx.actorId, input.note ?? `Enquired again via ${input.source ?? ctx.channel}`,
       { source: input.source, channel: ctx.channel }]);
    await tx.query(`UPDATE leads SET last_activity_at = now(), updated_at = now() WHERE id = $1`, [dup.lead_id]);
    return { duplicate_of: dup.lead_id };
  }

  const limit = ctx.limits.leads;
  if (ctx.remaining) {
    if (ctx.remaining.n <= 0) throw new HttpException({ code: 'lead_limit_reached', limit, message: 'Plan lead limit reached' }, HttpStatus.PAYMENT_REQUIRED);
    ctx.remaining.n -= 1;
  } else if (limit !== undefined) {
    const n = (await tx.query(`SELECT count(*)::int AS n FROM leads`)).rows[0].n;
    if (n >= limit) {
      throw new HttpException({ code: 'lead_limit_reached', limit,
        message: `Your plan holds ${limit.toLocaleString('en-IN')} leads. Upgrade to keep capturing.` }, HttpStatus.PAYMENT_REQUIRED);
    }
  }

  const stage = (await tx.query(
    `SELECT s.id AS stage_id, s.pipeline_id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id AND p.is_default
     ORDER BY s.position LIMIT 1`)).rows[0];
  if (!stage) throw new BadRequestException('Workspace has no default pipeline');

  let owner: string | null = input.owner_id ?? null;
  let assignedBy = owner ? 'manual' : '';
  if (!owner) {
    const picked = await pickByRules(tx, input);
    if (picked) { owner = picked.userId; assignedBy = `rule: ${picked.rule}`; }
  }
  if (!owner) { owner = await leastLoaded(tx); if (owner) assignedBy = 'least loaded'; }
  if (!owner) { owner = ctx.actorId; assignedBy = owner ? 'creator' : 'unassigned'; }

  const lead = (await tx.query(
    `INSERT INTO leads (tenant_id, name, email, primary_phone, whatsapp_number, pipeline_id, stage_id,
       owner_id, source, budget_min, budget_max, property_type, preferred_locations, tags, custom_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, name, primary_phone, owner_id, stage_id, source, created_at`,
    [ctx.tenantId, input.name, input.email ?? null, phone, input.whatsapp_number ? normalizePhone(input.whatsapp_number) : null,
     stage.pipeline_id, stage.stage_id, owner, input.source ?? null, input.budget_min ?? null, input.budget_max ?? null,
     input.property_type ?? null, input.preferred_locations, input.tags, input.custom_fields])).rows[0];

  await tx.query(`INSERT INTO lead_phones (tenant_id, phone, lead_id) VALUES ($1,$2,$3)`, [ctx.tenantId, phone, lead.id]);
  await tx.query(
    `INSERT INTO activities (tenant_id, lead_id, type, actor_id, body, meta) VALUES ($1,$2,'system',$3,'Lead created',$4)`,
    [ctx.tenantId, lead.id, ctx.actorId, { source: input.source, channel: ctx.channel, assigned_to: owner, assigned_by: assignedBy }]);
  if (input.note) {
    await tx.query(`INSERT INTO activities (tenant_id, lead_id, type, actor_id, body) VALUES ($1,$2,'note',$3,$4)`,
      [ctx.tenantId, lead.id, ctx.actorId, input.note]);
  }
  return { duplicate_of: null, lead, assigned_by: assignedBy };
}

/** First enabled rule (by position) whose conditions all match. Empty
 *  condition lists match everything. The cursor advances under a row lock,
 *  so concurrent captures still alternate fairly. Inactive people are skipped. */
async function pickByRules(tx: Tx, input: LeadInput): Promise<{ userId: string; rule: string } | null> {
  const rules = (await tx.query(`SELECT id, name, conditions FROM assignment_rules WHERE enabled ORDER BY position, created_at`)).rows;
  const src = (input.source ?? '').toLowerCase();
  const locs = input.preferred_locations.map(l => l.toLowerCase());
  for (const r of rules) {
    const c = r.conditions ?? {};
    if (c.sources?.length && !c.sources.map((s: string) => s.toLowerCase()).includes(src)) continue;
    if (c.property_types?.length && !c.property_types.includes(input.property_type)) continue;
    if (c.locations?.length && !c.locations.some((l: string) => locs.some(x => x.includes(l.toLowerCase())))) continue;
    const budget = input.budget_max ?? input.budget_min;
    if ((c.budget_min || c.budget_max) && budget === undefined) continue;
    if (c.budget_min && budget! < c.budget_min) continue;
    if (c.budget_max && budget! > c.budget_max) continue;

    const locked = (await tx.query(`SELECT assignee_ids, last_index FROM assignment_rules WHERE id = $1 FOR UPDATE`, [r.id])).rows[0];
    const active = new Set((await tx.query(
      `SELECT id FROM users WHERE id = ANY($1) AND status = 'active'`, [locked.assignee_ids])).rows.map(x => x.id));
    const pool: string[] = locked.assignee_ids;
    for (let step = 1; step <= pool.length; step++) {
      const idx = (locked.last_index + step) % pool.length;
      if (active.has(pool[idx])) {
        await tx.query(`UPDATE assignment_rules SET last_index = $2 WHERE id = $1`, [r.id, idx]);
        return { userId: pool[idx], rule: r.name };
      }
    }
  }
  return null;
}

async function leastLoaded(tx: Tx): Promise<string | null> {
  const r = await tx.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     LEFT JOIN leads l ON l.owner_id = u.id AND l.status = 'open'
     WHERE u.status = 'active' AND r.key IN ('sales_executive','telecaller')
     GROUP BY u.id ORDER BY count(l.id), min(u.created_at) LIMIT 1`);
  return r.rows[0]?.id ?? null;
}
