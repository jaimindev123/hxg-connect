import {
  ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import type { Tx } from '../db/db.service';

/** Parse a body with zod; 400 with field-level issues on failure. */
export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'Some fields are invalid',
      issues: r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** E.164-ish normalization. "98765 43210", "+91-98765-43210", "919876543210"
 *  all become "+919876543210". This is what makes dedupe actually work. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  const cc = config.defaultCountryCode;
  if (digits.length === 11 && digits.startsWith('0')) return `+${cc}${digits.slice(1)}`;
  if (digits.length === 10) return `+${cc}${digits}`;
  if (digits.startsWith(cc) && digits.length === cc.length + 10) return `+${digits}`;
  return `+${digits}`;
}

export const phoneSchema = z.string().min(7).max(20)
  .refine(v => /^\+?[\d\s\-()]{7,20}$/.test(v.trim()), 'Not a valid phone number');

/** Every mutation in a client workspace leaves a trail. When support is
 *  impersonating, the row records the platform person, not a client user. */
export async function audit(tx: Tx, req: Request, action: string,
                            entity?: string, entityId?: string, detail: object = {}) {
  const u = req.tenantUser!;
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_id, impersonator_id, action, entity, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [u.tid, u.imp ? null : u.sub, u.imp ? u.sub : null, action, entity ?? null, entityId ?? null, detail]);
}

/** RFC 7807 problem+json for every error, so the web and mobile clients
 *  handle failures one way. Unknown errors never leak internals. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    let status = 500;
    let body: Record<string, unknown> = { code: 'internal_error', message: 'Something went wrong' };

    if (err instanceof HttpException) {
      status = err.getStatus();
      const r = err.getResponse();
      body = typeof r === 'string' ? { message: r } : { ...(r as object) };
      if (Array.isArray(body.message)) body.message = (body.message as string[]).join('; ');
      delete body.statusCode;
      delete body.error;
    } else if ((err as { code?: string })?.code === '22P02') {
      status = 404; body = { code: 'not_found', message: 'Not found' };   // malformed uuid
    } else {
      this.log.error(`${req.method} ${req.url}`, (err as Error)?.stack);
    }

    res.status(status).type('application/problem+json').json({
      status, title: body.code ?? defaultTitle(status), ...body, instance: req.url,
    });
  }
}

function defaultTitle(status: number) {
  return ({ 400: 'bad_request', 401: 'unauthorized', 402: 'payment_required', 403: 'forbidden',
            404: 'not_found', 409: 'conflict' } as Record<number, string>)[status] ?? 'error';
}
