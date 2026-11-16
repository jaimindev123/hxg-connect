import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { hint, randomKey, seal, unseal } from '../common/crypto';
import { randomBytes } from 'node:crypto';
import { parse } from '../common/util';
import { CATALOG, findProvider, ProviderDef } from './catalog';

type Scope = 'tenant' | 'platform';

const saveSchema = z.object({
  config: z.record(z.string().max(500)).default({}),
  secrets: z.record(z.string().max(4000)).default({}),
  enabled: z.boolean().optional(),
});

@Injectable()
export class IntegrationsService {
  constructor(private readonly db: Db) {}

  private run<T>(scope: Scope, tenantId: string | null, fn: (tx: Tx) => Promise<T>) {
    return scope === 'tenant' ? this.db.withTenant(tenantId!, fn) : this.db.platformTx(fn);
  }
  private table = (scope: Scope) => (scope === 'tenant' ? 'integrations' : 'platform.integrations');
  private def(scope: Scope, provider: string): ProviderDef {
    const d = findProvider(scope, provider);
    if (!d) throw new NotFoundException(`Unknown integration "${provider}"`);
    return d;
  }

  async list(scope: Scope, tenantId: string | null, origin: string) {
    const rows = await this.run(scope, tenantId, tx => tx.query(`SELECT * FROM ${this.table(scope)}`));
    return CATALOG.filter(d => d.scope === scope)
      .map(d => this.view(d, rows.rows.find(r => r.provider === d.provider), origin));
  }

  /** Blank secret fields keep the stored value, so changing one key never
   *  means retyping the rest. Validation runs on the merged result. */
  async save(scope: Scope, tenantId: string | null, provider: string, body: unknown, actorId: string, origin: string) {
    const d = this.def(scope, provider);
    const b = parse(saveSchema, body);
    return this.run(scope, tenantId, async tx => {
      const existing = (await tx.query(`SELECT * FROM ${this.table(scope)} WHERE provider = $1 FOR UPDATE`, [provider])).rows[0];
      const oldSecrets = unseal(existing?.secrets_enc);
      const cfg: Record<string, string> = {};
      const sec: Record<string, string> = {};
      const issues: { path: string; message: string }[] = [];

      for (const f of d.fields) {
        const incoming = (f.secret ? b.secrets[f.key] : b.config[f.key])?.trim();
        const value = incoming || (f.secret ? oldSecrets[f.key] : existing?.config?.[f.key]) || '';
        const path = `${f.secret ? 'secrets' : 'config'}.${f.key}`;
        if (!value) { if (f.required) issues.push({ path, message: `${f.label} is required` }); continue; }
        if (f.options && !f.options.includes(value)) issues.push({ path, message: `Choose one of: ${f.options.join(', ')}` });
        else if (f.pattern && !f.pattern.test(value)) issues.push({ path, message: f.patternHint ?? `${f.label} doesn't look right` });
        (f.secret ? sec : cfg)[f.key] = value;
      }
      if (issues.length) throw new BadRequestException({ code: 'validation_failed', message: 'Some fields need fixing', issues });

      // Webhook identity: random, unguessable, stable across edits.
      if (d.webhook) {
        cfg.webhook_key = existing?.config?.webhook_key ?? randomKey();
        if (!['razorpay', 'calls', 'portal', 'connector'].includes(d.webhook)) cfg.verify_token = existing?.config?.verify_token ?? randomKey(18);
        if (d.webhook === 'portal') cfg.email_key = existing?.config?.email_key ?? randomBytes(10).toString('hex');   // lowercase: mail systems may lowercase addresses
      }
      const enabled = b.enabled ?? existing?.enabled ?? true;
      const cols = scope === 'tenant' ? '(tenant_id, provider, enabled, config, secrets_enc, status, updated_by)' : '(provider, enabled, config, secrets_enc, status, updated_by)';
      const vals = scope === 'tenant' ? '($6, $1, $2, $3, $4, \'saved\', $5)' : '($1, $2, $3, $4, \'saved\', $5)';
      const conflict = scope === 'tenant' ? '(tenant_id, provider)' : '(provider)';
      const params: unknown[] = [provider, enabled, cfg, seal(sec), actorId];
      if (scope === 'tenant') params.push(tenantId);
      const row = (await tx.query(
        `INSERT INTO ${this.table(scope)} ${cols} VALUES ${vals}
         ON CONFLICT ${conflict} DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config,
           secrets_enc = EXCLUDED.secrets_enc, status = 'saved', last_error = NULL, last_tested_at = NULL,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`, params)).rows[0];

      // One active calling provider at a time.
      if (d.exclusive && enabled) {
        const siblings = CATALOG.filter(x => x.scope === scope && x.category === d.category && x.provider !== provider).map(x => x.provider);
        await tx.query(`UPDATE ${this.table(scope)} SET enabled = false WHERE provider = ANY($1)`, [siblings]);
      }
      return this.view(d, row, origin);
    });
  }

  async test(scope: Scope, tenantId: string | null, provider: string, origin: string) {
    const d = this.def(scope, provider);
    const row = (await this.run(scope, tenantId, tx => tx.query(`SELECT * FROM ${this.table(scope)} WHERE provider = $1`, [provider]))).rows[0];
    if (!row) throw new BadRequestException({ code: 'not_configured', message: `Save the ${d.label} keys first` });

    const verdict = await d.verify(row.config, unseal(row.secrets_enc));
    const status = verdict.ok === true ? 'connected' : verdict.ok === false ? 'error' : 'saved';
    const updated = (await this.run(scope, tenantId, tx => tx.query(
      `UPDATE ${this.table(scope)} SET status = $2, last_tested_at = now(), last_error = $3
       WHERE provider = $1 RETURNING *`, [provider, status, verdict.ok === false ? verdict.detail : null]))).rows[0];
    return { ...this.view(d, updated, origin), result: verdict };
  }

  async remove(scope: Scope, tenantId: string | null, provider: string) {
    this.def(scope, provider);
    const r = await this.run(scope, tenantId, tx => tx.query(`DELETE FROM ${this.table(scope)} WHERE provider = $1`, [provider]));
    if (!r.rowCount) throw new NotFoundException('Nothing to remove');
  }

  /** Decrypted credentials for server-side use only. Never send to a client. */
  async credentials(scope: Scope, tenantId: string | null, provider: string) {
    const row = (await this.run(scope, tenantId, tx => tx.query(
      `SELECT config, secrets_enc, enabled, status FROM ${this.table(scope)} WHERE provider = $1`, [provider]))).rows[0];
    return row ? { config: row.config as Record<string, string>, secrets: unseal(row.secrets_enc), enabled: row.enabled, status: row.status } : null;
  }

  private view(d: ProviderDef, row: any, origin: string) {
    const secrets = unseal(row?.secrets_enc);
    return {
      provider: d.provider, category: d.category, label: d.label, description: d.description, docs: d.docs ?? null,
      exclusive: !!d.exclusive,
      fields: d.fields.map(({ pattern, ...f }) => f),
      configured: !!row, enabled: row?.enabled ?? false,
      status: row ? row.status : 'not_configured',
      config: Object.fromEntries(d.fields.filter(f => !f.secret).map(f => [f.key, row?.config?.[f.key] ?? ''])),
      secrets: Object.fromEntries(d.fields.filter(f => f.secret).map(f => [f.key, hint(secrets[f.key])])),
      last_tested_at: row?.last_tested_at ?? null, last_error: row?.last_error ?? null,
      updated_at: row?.updated_at ?? null,
      webhook: d.webhook && row?.config?.webhook_key ? {
        url: d.webhook === 'connector' ? `${origin}/api/webhooks/in/{source}/${row.config.webhook_key}` : d.webhook === 'portal' ? `${origin}/api/webhooks/portal/{portal}/${row.config.webhook_key}` : `${origin}/api/webhooks/${d.webhook}/${row.config.webhook_key}`,
        email: d.webhook === 'portal' && row.config.email_key && config.inboundEmailDomain ? `${row.config.email_key}@${config.inboundEmailDomain}` : undefined,
        verify_token: !['razorpay', 'calls', 'portal', 'connector'].includes(d.webhook) ? row.config.verify_token : undefined,
        https: origin.startsWith('https://'),
      } : null,
    };
  }
}

// =====================================================================
/** Effective domain, editable in the console without a redeploy. Other API
 *  replicas pick a change up within a minute. */
export const runtime = { baseDomain: config.baseDomain as string | null };

@Injectable()
export class PlatformSettings implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: Db) {}

  async onModuleInit() {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => undefined), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async refresh() {
    const r = await this.db.platform(`SELECT value FROM platform.settings WHERE key = 'base_domain'`);
    runtime.baseDomain = (r.rows[0]?.value as string | null) ?? config.baseDomain ?? null;
  }

  async setDomain(domain: string | null, actorId: string) {
    if (domain === null) await this.db.platform(`DELETE FROM platform.settings WHERE key = 'base_domain'`);
    else await this.db.platform(
      `INSERT INTO platform.settings (key, value, updated_by) VALUES ('base_domain', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(domain), actorId]);
    await this.refresh();
  }
}

/** Where a client's people should go: their subdomain once a domain is set,
 *  otherwise the address this server is reached at. */
export const workspaceUrl = (sub: string, origin: string) =>
  runtime.baseDomain ? `https://${sub}.${runtime.baseDomain}` : origin;

// =====================================================================
@Injectable()
export class Mailer {
  constructor(private readonly integrations: IntegrationsService) {}

  /** Returns sent=false (not an error) when email isn't set up yet, so
   *  invitations still work by copying the link. */
  async sendReset(to: string, name: string, link: string) {
    return this.sendLink(to, 'Reset your HXG Connect password', `Hi ${name},\n\nUse this link to set a new password. It works once and expires in 1 hour. If you didn't ask for this, ignore this email.\n\n${link}\n`, link);
  }

  private async sendLink(to: string, subject: string, text: string, link: string): Promise<{ sent: boolean; error?: string }> {
    const smtp = await this.integrations.credentials('platform', null, 'smtp');
    if (!smtp?.enabled) return { sent: false };
    const c = smtp.config;
    const t = nodemailer.createTransport({ host: c.host, port: Number(c.port), secure: c.port === '465', auth: { user: c.username, pass: smtp.secrets.password }, connectionTimeout: 8000 });
    try { await t.sendMail({ from: `"${(c.from_name || 'HXG Connect').replace(/"/g, '')}" <${c.from_email}>`, to, subject, text }); return { sent: true }; }
    catch (e: any) { return { sent: false, error: e?.message }; } finally { t.close(); }
  }

  async sendInvite(to: string, name: string, workspace: string, link: string): Promise<{ sent: boolean; error?: string }> {
    const smtp = await this.integrations.credentials('platform', null, 'smtp');
    if (!smtp?.enabled) return { sent: false };
    const c = smtp.config;
    const t = nodemailer.createTransport({ host: c.host, port: Number(c.port), secure: c.port === '465',
      auth: { user: c.username, pass: smtp.secrets.password }, connectionTimeout: 8000 });
    const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
    try {
      await t.sendMail({
        from: `"${(c.from_name || 'HXG Connect').replace(/"/g, '')}" <${c.from_email}>`, to,
        subject: `You're invited to ${workspace} on HXG Connect`,
        text: `Hi ${name},\n\nYou've been invited to ${workspace} on HXG Connect. Set your password here (the link works once and expires in 72 hours):\n\n${link}\n`,
        html: `<p>Hi ${esc(name)},</p><p>You've been invited to <b>${esc(workspace)}</b> on HXG Connect.</p>
               <p><a href="${esc(link)}">Set your password</a></p><p style="color:#555555">The link works once and expires in 72 hours.</p>`,
      });
      return { sent: true };
    } catch (e: any) {
      return { sent: false, error: e?.message ?? 'Email failed' };
    } finally { t.close(); }
  }
}
