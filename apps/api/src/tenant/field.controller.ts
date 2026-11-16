import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { RequireFeature, TenantGuard, TenantRoles } from '../common/guards';
import { Storage } from '../common/storage';
import { audit, parse } from '../common/util';
import { findVisibleLead } from '../common/scope';

/** Who sees whose check-ins: leadership everyone, a team leader their team
 *  (everyone who reports up to them), everyone else only their own. Selfies
 *  and locations are more personal than leads, so CRM, marketing and finance
 *  roles don't get the company-wide view here. */
const SEE_ALL = new Set(['owner', 'admin', 'sales_manager']);
const fieldPeople = (req: Request): string[] | null => {
  const u = req.tenantUser!;
  if (SEE_ALL.has(u.role) || u.imp) return null;
  return req.scope!.kind === 'team' ? req.scope!.actors : [u.sub];
};
const LOW_ACCURACY_M = 100;
const LATE_SYNC_MIN = 15;

const checkinSchema = z.object({
  type: z.enum(['day_start', 'day_end', 'site_visit_in', 'site_visit_out', 'meeting', 'adhoc']),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy_m: z.coerce.number().min(0).max(100000).optional(),
  captured_at: z.string().datetime({ offset: true }),
  address: z.string().trim().max(300).optional(),
  note: z.string().trim().max(1000).optional(),
  lead_id: z.string().uuid().optional(),
  mock_location: z.enum(['true', 'false']).optional(),   // reported by the native app
  taken_by: z.string().uuid().optional(),                // who was signed in when the selfie was taken
});

const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

@Controller('field')
@UseGuards(TenantGuard)
@RequireFeature('field_tracking')
export class FieldController {
  constructor(private readonly db: Db, private readonly storage: Storage) {}

  /** Operator: selfie + location in one request, routed to their manager. */
  @Post('check-ins')
  @UseInterceptors(FileInterceptor('selfie', { limits: { fileSize: 3 * 1024 * 1024, files: 1 } }))
  async checkIn(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown, @Req() req: Request) {
    if (req.tenantUser!.imp) throw new ForbiddenException('Support sessions cannot check in');
    if (!file) throw new BadRequestException({ code: 'selfie_required', message: 'Take a selfie to check in' });
    const ext = IMAGE_EXT[file.mimetype];
    if (!ext || !looksLikeImage(file.buffer)) {
      throw new BadRequestException({ code: 'invalid_image', message: 'The selfie must be a JPEG, PNG or WebP photo' });
    }
    const b = parse(checkinSchema, body);
    // A check-in queued offline on a shared phone must never land under the
    // next person to sign in. The app keeps it until its owner signs back in.
    if (b.taken_by && b.taken_by !== req.tenantUser!.sub) {
      throw new ConflictException({ code: 'checkin_wrong_user', message: 'This check-in was taken by someone else on this phone' });
    }

    const captured = new Date(b.captured_at);
    const driftMin = (Date.now() - captured.getTime()) / 60000;
    if (driftMin < -2) throw new BadRequestException({ code: 'clock_skew', message: 'Device clock is ahead of server time' });

    const flags: Record<string, boolean | number> = {};
    if (b.accuracy_m !== undefined && b.accuracy_m > LOW_ACCURACY_M) flags.low_accuracy = true;
    if (b.accuracy_m === undefined) flags.no_accuracy = true;
    if (driftMin > LATE_SYNC_MIN) flags.late_sync = Math.round(driftMin);
    if (b.mock_location === 'true') flags.mock_location = true;
    const status = Object.keys(flags).length ? 'flagged' : 'ok';

    const tenantId = req.tenant!.id;
    const key = await this.storage.put(tenantId, 'field', ext, file.buffer);

    return this.db.withTenant(tenantId, async tx => {
      const me = (await tx.query(`SELECT manager_id FROM users WHERE id = $1`, [req.tenantUser!.sub])).rows[0];
      if (b.lead_id && !(await findVisibleLead(tx, req.scope!, b.lead_id, { cols: 'l.id' }))) {
        throw new BadRequestException('Lead not found');
      }
      const c = (await tx.query(
        `INSERT INTO field_checkins (tenant_id, user_id, manager_id, type, lead_id, selfie_key, captured_at,
           lat, lng, accuracy_m, address, note, flags, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, type, status, flags, submitted_at, manager_id`,
        [tenantId, req.tenantUser!.sub, me?.manager_id ?? null, b.type, b.lead_id ?? null, key, captured,
         b.lat, b.lng, b.accuracy_m ?? null, b.address ?? null, b.note ?? null, flags, status])).rows[0];
      await audit(tx, req, 'field.checked_in', 'field_checkin', c.id, { type: b.type, status });
      return c;
    });
  }

  /** Feed: managers see their reports, leadership sees everyone, others see their own. */
  @Get('check-ins')
  async feed(@Req() req: Request, @Query('date') date?: string, @Query('status') status?: string) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const rows = (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT c.id, c.type, c.status, c.flags, c.captured_at, c.submitted_at, c.lat, c.lng, c.accuracy_m,
              c.address, c.note, c.selfie_key, u.id AS user_id, u.name AS user_name, l.name AS lead_name
       FROM field_checkins c JOIN users u ON u.id = c.user_id LEFT JOIN leads l ON l.id = c.lead_id
       WHERE ($1::uuid[] IS NULL OR c.user_id = ANY($1::uuid[]))
         AND ($2::date IS NULL OR (c.captured_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date)
         AND ($3::text IS NULL OR c.status = $3)
       ORDER BY c.submitted_at DESC LIMIT 200`, [fieldPeople(req), day, status ?? null]))).rows;
    return rows.map(({ selfie_key, ...r }) => ({ ...r, selfie_url: this.storage.signedUrl(selfie_key) }));
  }

  /** Latest check-in per field user today: the manager's live board. */
  @Get('team/live')
  async live(@Req() req: Request) {
    const rows = (await this.db.withTenant(req.tenant!.id, tx => tx.query(
      `SELECT u.id, u.name, r.key AS role, c.id AS checkin_id, c.type, c.status, c.captured_at,
              c.lat, c.lng, c.accuracy_m, c.address, c.selfie_key
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN LATERAL (
         SELECT * FROM field_checkins fc WHERE fc.user_id = u.id
           AND fc.captured_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
         ORDER BY fc.captured_at DESC LIMIT 1) c ON true
       WHERE u.status = 'active' AND r.key IN ('sales_executive','team_leader','telecaller')
         AND ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))
       ORDER BY c.captured_at DESC NULLS LAST, u.name`, [fieldPeople(req)]))).rows;
    return rows.map(({ selfie_key, ...r }) => ({
      ...r,
      state: !r.checkin_id ? 'not_checked_in' : r.type === 'day_end' ? 'day_ended' : 'in_field',
      selfie_url: selfie_key ? this.storage.signedUrl(selfie_key) : null,
    }));
  }

  @Post('check-ins/:id/review') @HttpCode(200)
  @TenantRoles('owner', 'admin', 'sales_manager', 'team_leader')
  async review(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() }), body);
    return this.db.withTenant(req.tenant!.id, async tx => {
      const r = await tx.query(
        `UPDATE field_checkins SET status = $2, reviewed_by = $3, reviewed_at = now()
         WHERE id = $1 AND status IN ('flagged','ok')
           AND ($4 OR (user_id = ANY($5::uuid[]) AND user_id <> $3)) RETURNING id, status`,
        [id, b.decision, req.tenantUser!.sub, SEE_ALL.has(req.tenantUser!.role), req.scope!.actors ?? []]);
      if (!r.rowCount) throw new NotFoundException('Check-in not found or already reviewed');
      await audit(tx, req, `field.${b.decision}`, 'field_checkin', id, { note: b.note });
      return r.rows[0];
    });
  }
}

// ===================================================================
/** Serves stored files behind presigned-style URLs (no session needed,
 *  so <img src> works). The signature is the authorization. */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: Storage) {}

  @Get('*')
  async get(@Req() req: Request, @Res() res: Response, @Query('exp') exp: string, @Query('sig') sig: string) {
    const key = decodeURIComponent(req.path.replace(/^\/api\/files\//, ''));
    if (!this.storage.verify(key, exp, sig)) {
      res.status(403).type('application/problem+json')
        .json({ status: 403, title: 'forbidden', code: 'bad_signature', message: 'Link expired or invalid' });
      return;
    }
    try {
      const data = await this.storage.read(key);
      const ext = key.split('.').pop();
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`).send(data);
    } catch {
      res.status(404).type('application/problem+json').json({ status: 404, title: 'not_found', message: 'File not found' });
    }
  }
}

/** Magic-byte check: the declared mimetype is client-controlled. */
function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                         // JPEG
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
  return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';  // WebP
}
