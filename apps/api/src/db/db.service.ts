import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { config } from '../config';

export type Tx = PoolClient;

@Injectable()
export class Db implements OnModuleDestroy {
  /** hxg_platform — Super Admin console. Cannot read leads (no grant). */
  private readonly platformPool = new Pool({ connectionString: config.platformDbUrl, max: 10 });
  /** hxg_app — client CRM. Every tenant table filtered by RLS. */
  private readonly appPool = new Pool({ connectionString: config.appDbUrl, max: 40 });

  /** One-off platform query (platform schema, directory, usage counts). */
  platform(text: string, params: unknown[] = []) {
    return this.platformPool.query(text, params);
  }

  /** One-off app-role query with NO tenant context — only safe for the
   *  SECURITY DEFINER bridges (resolve_tenant, tenant_state, ...). Any
   *  direct table read here returns zero rows, by design. */
  appNoTenant(text: string, params: unknown[] = []) {
    return this.appPool.query(text, params);
  }

  /** Transaction on the platform pool. Pass tenantId to also open RLS for
   *  that tenant (used only by provisioning to seed a new workspace). */
  platformTx<T>(fn: (tx: Tx) => Promise<T>, tenantId?: string): Promise<T> {
    return this.tx(this.platformPool, fn, tenantId);
  }

  /** The workhorse: every client-CRM request runs inside this. The tenant id
   *  is set with is_local=true, so it dies with the transaction and can never
   *  leak to the next request that borrows this pooled connection. */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx(this.appPool, fn, tenantId);
  }

  private async tx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, tenantId?: string): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.platformPool.end(), this.appPool.end()]);
  }
}
