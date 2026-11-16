import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, HttpStatus,
  NotFoundException, Param, Patch, Post, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { TenantGuard, TenantRoles } from '../common/guards';
import { audit, parse } from '../common/util';
import { intakeLead, LeadInput, leadInputSchema, parseBudget } from './lead-intake';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const noSupport = (req: Request) => { if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot change this'); };
const PROPERTY_TYPES = ['apartment', 'villa', 'plot', 'commercial', 'office'] as const;

// =====================================================================
const conditionsSchema = z.object({
  sources: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  property_types: z.array(z.enum(PROPERTY_TYPES)).max(5).default([]),
  locations: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  budget_min: z.number().positive().optional(),
  budget_max: z.number().positive().optional(),
});
const ruleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  conditions: conditionsSchema.default({}),
  assignee_ids: z.array(z.string().uuid()).min(1, 'Pick at least one person').max(50),
  enabled: z.boolean().default(true),
});

@Controller('assignment-rules')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin', 'sales_manager')
export class AssignmentRulesController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT r.*, (SELECT array_agg(u.name ORDER BY array_position(r.assignee_ids, u.id)) FROM users u WHERE u.id = ANY(r.assignee_ids)) AS assignee_names
       FROM assignment_rules r ORDER BY r.position, r.created_at`))).rows;
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    noSupport(req);
    const b = parse(ruleSchema, body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      await this.checkPeople(tx, b.assignee_ids);
      const r = (await tx.query(
        `INSERT INTO assignment_rules (tenant_id, name, position, enabled, conditions, assignee_ids)
         VALUES ($1,$2,(SELECT COALESCE(max(position), -1) + 1 FROM assignment_rules),$3,$4,$5) RETURNING *`,
        [req.tenant!.id, b.name, b.enabled, b.conditions, b.assignee_ids])).rows[0];
      await audit(tx, req, 'assignment_rule.created', 'assignment_rule', r.id, { name: b.name });
      return r;
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    noSupport(req);
    const b = parse(ruleSchema.partial(), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      if (b.assignee_ids) await this.checkPeople(tx, b.assignee_ids);
      const r = (await tx.query(
        `UPDATE assignment_rules SET name = COALESCE($2, name), enabled = COALESCE($3, enabled),
           conditions = COALESCE($4, conditions), assignee_ids = COALESCE($5, assignee_ids),
           last_index = CASE WHEN $5::uuid[] IS NULL THEN last_index ELSE -1 END
         WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.enabled ?? null, b.conditions ?? null, b.assignee_ids ?? null])).rows[0];
      if (!r) throw new NotFoundException('Rule not found');
      return r;
    });
  }

  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: Request) {
    noSupport(req);
    const r = await this.db.withTenant(req.tenant!.id, tx => tx.query(`DELETE FROM assignment_rules WHERE id = $1`, [id]));
    if (!r.rowCount) throw new NotFoundException('Rule not found');
  }

  /** Rules are checked top to bottom; the first match wins. */
  @Post('reorder') @HttpCode(200)
  async reorder(@Body() body: unknown, @Req() req: Request) {
    noSupport(req);
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(200) }), body);
    await this.db.withTenant(req.tenant!.id, tx =>
      tx.query(`UPDATE assignment_rules r SET position = x.pos FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id, pos) WHERE r.id = x.id`, [ids]));
    return { ok: true };
  }

  private async checkPeople(tx: any, ids: string[]) {
    const n = (await tx.query(`SELECT count(*)::int AS n FROM users WHERE id = ANY($1)`, [ids])).rows[0].n;
    if (n !== new Set(ids).size) throw new BadRequestException('Some selected people are not in this workspace');
  }
}

// =====================================================================
@Controller('api-keys')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin')
export class ApiKeysController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request) {
    return (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT id, name, prefix, default_source, last_used_at, created_at, revoked_at FROM api_keys ORDER BY revoked_at NULLS FIRST, created_at DESC`))).rows;
  }

  /** The full key is returned exactly once. Only its hash is kept. */
  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    noSupport(req);
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), default_source: z.string().trim().min(2).max(60).default('website') }), body);
    const prefix = randomBytes(4).toString('hex');
    const key = `hxgk_${prefix}_${randomBytes(24).toString('base64url')}`;
    return this.db.withTenant(req.tenant!.id, async tx => {
      const r = (await tx.query(
        `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, default_source, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, name, prefix, default_source, created_at`,
        [req.tenant!.id, b.name, prefix, sha256(key), b.default_source, req.tenantUser!.sub])).rows[0];
      await audit(tx, req, 'api_key.created', 'api_key', r.id, { name: b.name });
      return { ...r, key };
    });
  }

  @Post(':id/revoke') @HttpCode(200)
  async revoke(@Param('id') id: string, @Req() req: Request) {
    noSupport(req);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const r = await tx.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [id]);
      if (!r.rowCount) throw new NotFoundException('Active key not found');
      await audit(tx, req, 'api_key.revoked', 'api_key', id);
      return { id, revoked: true };
    });
  }
}

// =====================================================================
/** Turns a loose website/webhook payload into a LeadInput. */
export function mapLoosePayload(b: Record<string, any>, defaultSource: string): unknown {
  const budget = parseBudget(b.budget);
  const pt = mapPropertyType(b.property_type);
  const extra: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'page_url', 'project'])
    if (b[k]) extra[k] = String(b[k]).slice(0, 300);
  return {
    name: String(b.name ?? '').slice(0, 160), phone: String(b.phone ?? b.mobile ?? ''),
    email: b.email ? String(b.email) : undefined,
    source: String(b.source || defaultSource).slice(0, 60),
    budget_max: budget, property_type: pt,
    preferred_locations: b.location ? [String(b.location).slice(0, 80)] : [],
    custom_fields: extra, note: b.message ? String(b.message).slice(0, 5000) : undefined,
  };
}

export function mapPropertyType(raw: unknown): LeadInput['property_type'] {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return undefined;
  if (s.includes('villa') || s.includes('bungalow')) return 'villa';
  if (s.includes('plot') || s.includes('land')) return 'plot';
  if (s.includes('office')) return 'office';
  if (s.includes('shop') || s.includes('commercial') || s.includes('retail')) return 'commercial';
  if (s.includes('flat') || s.includes('apartment') || s.includes('bhk')) return 'apartment';
  return undefined;
}

const keyHits = new Map<string, { n: number; reset: number }>();
function keyLimit(id: string, perMin = 60) {
  const now = Date.now(), h = keyHits.get(id);
  if (!h || h.reset < now) { keyHits.set(id, { n: 1, reset: now + 60_000 }); return true; }
  return ++h.n <= perMin;
}

@Controller('capture')
export class CaptureController {
  constructor(private readonly db: Db) {}

  /** Public: website forms post here with their key. Accepts JSON or a plain
   *  HTML form. Same reply whether or not the number is already a lead, so
   *  the endpoint can't be used to find out who your customers are. */
  @Post('leads')
  async capture(@Req() req: Request, @Res() res: Response) {
    const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const body = (req.body ?? {}) as Record<string, any>;
    const key = typeof header === 'string' && header ? header : typeof body.api_key === 'string' ? body.api_key : '';
    if (!/^hxgk_[0-9a-f]{8}_[\w-]{20,}$/.test(key)) throw new UnauthorizedException('Missing or malformed API key');
    const k = (await this.db.appNoTenant('SELECT * FROM resolve_api_key($1)', [sha256(key)])).rows[0];
    if (!k) throw new UnauthorizedException('This API key is not valid or was revoked');
    if (!keyLimit(k.id)) throw new HttpException({ code: 'rate_limited', message: 'Too many submissions' }, HttpStatus.TOO_MANY_REQUESTS);

    const t = (await this.db.appNoTenant('SELECT * FROM tenant_state($1)', [k.tenant_id])).rows[0];
    if (!t || t.status === 'suspended' || t.status === 'churned') throw new ForbiddenException('This workspace is not accepting leads');
    if (t.status === 'trial' && t.trial_ends_at && new Date(t.trial_ends_at) < new Date()) {
      throw new HttpException({ code: 'trial_expired', message: 'This workspace is not accepting leads' }, HttpStatus.PAYMENT_REQUIRED);
    }

    const done = () => {
      const redirect = typeof body.redirect === 'string' && /^https?:\/\//.test(body.redirect) ? body.redirect : null;
      if (redirect && req.is('application/x-www-form-urlencoded')) res.redirect(303, redirect);
      else res.status(201).json({ ok: true });
    };
    if (body.website || body.company_website) return done();         // honeypot: bots fill hidden fields

    const input = parse(leadInputSchema, mapLoosePayload(body, k.default_source));
    await this.db.withTenant(k.tenant_id, async tx => {
      await intakeLead(tx, { tenantId: k.tenant_id, limits: t.limits, actorId: null, channel: 'website' }, input);
      await tx.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [k.id]);
    });
    done();
  }
}

// =====================================================================
/** RFC 4180 CSV with delimiter sniffing (Excel in India often saves ";"). */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const first = text.slice(0, text.search(/\r?\n/) >>> 0 || text.length);
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

const GUESS: Record<string, string[]> = {
  name: ['name', 'fullname', 'customername', 'leadname', 'clientname', 'customer'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'mobileno', 'phoneno', 'contact', 'contactnumber', 'whatsapp'],
  email: ['email', 'emailaddress', 'emailid', 'mail'],
  source: ['source', 'leadsource', 'channel'],
  budget: ['budget', 'budgetrange', 'price', 'pricerange'],
  location: ['location', 'locality', 'preferredlocation', 'area', 'city'],
  property_type: ['propertytype', 'requirement', 'unittype', 'type', 'configuration'],
  tags: ['tags', 'tag', 'labels'],
  note: ['notes', 'note', 'remarks', 'comment', 'comments', 'message'],
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

/** "80-95L", "80 to 95 lakh", "1.2 Cr" → {min, max}. A unit on the second
 *  number applies to the first when the first has none. */
function budgetRange(raw: string): { min?: number; max?: number } {
  const parts = raw.split(/\s*(?:-|–|to)\s*/i).filter(Boolean);
  if (parts.length === 2) {
    const unit = parts[1].match(/[a-z]+$/i)?.[0] ?? '';
    const first = /[a-z]$/i.test(parts[0]) ? parts[0] : parts[0] + unit;
    return { min: parseBudget(first), max: parseBudget(parts[1]) };
  }
  const v = parseBudget(raw);
  return { max: v };
}

@Controller('imports')
@UseGuards(TenantGuard)
@TenantRoles('owner', 'admin', 'sales_manager', 'crm_executive')
export class ImportController {
  constructor(private readonly db: Db) {}

  @Post('leads/preview') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(@UploadedFile() file?: Express.Multer.File) {
    const rows = this.rows(file);
    const headers = rows[0].map(h => h.trim());
    const mapping: Record<string, number> = {};
    for (const [field, names] of Object.entries(GUESS)) {
      const idx = headers.findIndex((h, i) => names.includes(norm(h)) && !Object.values(mapping).includes(i));
      if (idx >= 0) mapping[field] = idx;
    }
    return { headers, sample: rows.slice(1, 6), total: rows.length - 1, mapping };
  }

  @Post('leads') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>, @Req() req: Request) {
    noSupport(req);
    const rows = this.rows(file).slice(1);
    if (rows.length > 20000) throw new BadRequestException('Up to 20,000 rows per import. Split the file and import in parts.');
    let mapping: Record<string, number>;
    try { mapping = z.record(z.number().int().min(0)).parse(JSON.parse(body.mapping ?? '{}')); }
    catch { throw new BadRequestException('Column mapping is missing'); }
    if (mapping.name === undefined || mapping.phone === undefined) throw new BadRequestException('Map at least the name and phone columns');
    const defaultSource = (body.default_source || 'import').slice(0, 60);
    const tenantId = req.tenant!.id;
    const cell = (r: string[], f: string) => (mapping[f] !== undefined ? (r[mapping[f]] ?? '').trim() : '');

    const limit = req.tenant!.limits.leads;
    const existing = (await this.db.withTenant(tenantId, tx => tx.query(`SELECT count(*)::int AS n FROM leads`))).rows[0].n;
    const remaining = { n: limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - existing) };
    const result = { total: rows.length, created: 0, duplicates: 0, invalid: [] as { row: number; error: string }[], limit_reached: false };

    for (let start = 0; start < rows.length && !result.limit_reached; start += 200) {
      await this.db.withTenant(tenantId, async tx => {
        for (let i = start; i < Math.min(start + 200, rows.length); i++) {
          const r = rows[i], rowNo = i + 2;                       // +1 header, +1 human counting
          const b = budgetRange(cell(r, 'budget'));
          const candidate = {
            name: cell(r, 'name'), phone: cell(r, 'phone'), email: cell(r, 'email') || undefined,
            source: (cell(r, 'source') || defaultSource).toLowerCase().replace(/\s+/g, '_'),
            budget_min: b.min, budget_max: b.max, property_type: mapPropertyType(cell(r, 'property_type')),
            preferred_locations: cell(r, 'location') ? cell(r, 'location').split(/[,/]/).map(s => s.trim()).filter(Boolean).slice(0, 5) : [],
            tags: cell(r, 'tags') ? cell(r, 'tags').split(/[,;]/).map(s => s.trim()).filter(Boolean).slice(0, 20) : [],
            note: cell(r, 'note') || undefined,
          };
          const v = leadInputSchema.safeParse(candidate);
          if (!v.success) { result.invalid.push({ row: rowNo, error: v.error.issues.map(x => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') }); continue; }
          await tx.query('SAVEPOINT row');
          try {
            const out = await intakeLead(tx, { tenantId, limits: req.tenant!.limits, actorId: req.tenantUser!.sub, channel: 'import', remaining }, v.data);
            await tx.query('RELEASE SAVEPOINT row');
            if (out.duplicate_of) result.duplicates++; else result.created++;
          } catch (e: any) {
            await tx.query('ROLLBACK TO SAVEPOINT row');
            if (e?.response?.code === 'lead_limit_reached') { result.limit_reached = true; break; }
            result.invalid.push({ row: rowNo, error: e?.message ?? 'Could not import' });
          }
        }
      });
    }
    await this.db.withTenant(tenantId, tx => audit(tx, req, 'leads.imported', undefined, undefined,
      { created: result.created, duplicates: result.duplicates, invalid: result.invalid.length }));
    return { ...result, invalid: result.invalid.slice(0, 200) };
  }

  private rows(file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Choose a CSV file');
    const rows = parseCsv(file.buffer.toString('utf8'));
    if (rows.length < 2) throw new BadRequestException('The file needs a header row and at least one lead');
    return rows;
  }
}
