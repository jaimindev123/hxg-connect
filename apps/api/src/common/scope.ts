import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Tx } from '../db/db.service';

/**
 * Who sees whose data, in one place. Every list, count and single-record
 * check in the CRM goes through this, so no screen can show more than the
 * person's role allows. It follows the role presets each client starts with
 * and the PRD permission matrix (docs/01-PRD.md §5):
 *
 *   all        owner, admin, sales manager, CRM executive (data ops),
 *              marketing and finance (read)
 *   team       team leader: their own leads and calls, plus everyone who
 *              reports to them, directly or through another team leader
 *   own        sales executive, telecaller
 *   customers  customer support: buyers with a booking
 *
 * A role not listed here (a custom role added later) gets "own". The safe
 * failure is showing too little, never too much.
 */
export type ScopeKind = 'all' | 'team' | 'own' | 'customers';

export const LEAD_SCOPE: Record<string, ScopeKind> = {
  owner: 'all', admin: 'all', sales_manager: 'all', crm_executive: 'all', marketing: 'all', finance: 'all',
  team_leader: 'team',
  sales_executive: 'own', telecaller: 'own',
  support: 'customers',
};

/** Roles that may open the Team page. Team leaders see only their own team there. */
export const TEAM_PAGE_ROLES = ['owner', 'admin', 'sales_manager', 'team_leader'];

export interface Scope {
  kind: ScopeKind;
  me: string;
  /** Lead owners whose leads are visible. null: no owner limit. */
  people: string[] | null;
  /** People whose own work (calls placed, visits run) is visible whatever the
   *  lead. null: everyone's. Support sees their own calls even on open leads. */
  actors: string[] | null;
  customersOnly: boolean;
}

/** Built once per request by the tenant guard. `reports` is everyone under
 *  the person in the reporting line (team leaders only). */
export function buildScope(me: string, role: string, opts: { impersonating?: boolean; reports?: string[] | null } = {}): Scope {
  const kind: ScopeKind = opts.impersonating ? 'all' : LEAD_SCOPE[role] ?? 'own';
  switch (kind) {
    case 'all': return { kind, me, people: null, actors: null, customersOnly: false };
    case 'customers': return { kind, me, people: null, actors: [me], customersOnly: true };
    case 'team': {
      const team = [me, ...(opts.reports ?? []).filter(id => id !== me)];
      return { kind, me, people: team, actors: team, customersOnly: false };
    }
    default: return { kind: 'own', me, people: [me], actors: [me], customersOnly: false };
  }
}

/**
 * SQL condition: the lead aliased `l` is one this person can see. Uses two
 * placeholders, $n and $n+1, filled by `...leadArgs(scope)` at that position.
 */
export const leadIn = (l: string, n: number) =>
  `((($${n}::uuid[]) IS NULL OR ${l}.owner_id = ANY($${n}::uuid[]))` +
  ` AND (NOT $${n + 1}::boolean OR EXISTS (SELECT 1 FROM bookings sb WHERE sb.lead_id = ${l}.id)))`;
export const leadArgs = (s: Scope) => [s.people, s.customersOnly];

/** SQL condition on a user-id column: work done by someone in scope ($n). */
export const actorIn = (col: string, n: number) => `(($${n}::uuid[]) IS NULL OR ${col} = ANY($${n}::uuid[]))`;

/** One lead, if this person may work on it: it's in their scope, or they hold
 *  an open follow-up or a scheduled site visit on it (the job they were handed,
 *  e.g. a telecaller passing a visit to a closing executive). */
export async function findVisibleLead<T = any>(tx: Tx, s: Scope, leadId: string, opts: { cols?: string; lock?: boolean } = {}): Promise<T | undefined> {
  return (await tx.query(
    `SELECT ${opts.cols ?? 'l.*'} FROM leads l
     WHERE l.id = $1 AND (${leadIn('l', 2)}
       OR EXISTS (SELECT 1 FROM follow_ups hf WHERE hf.lead_id = l.id AND hf.assigned_to = $4 AND hf.status = 'pending')
       OR EXISTS (SELECT 1 FROM site_visits hv WHERE hv.lead_id = l.id AND hv.executive_id = $4 AND hv.status = 'scheduled'))
     ${opts.lock ? 'FOR UPDATE OF l' : ''}`,
    [leadId, ...leadArgs(s), s.me])).rows[0];
}

/** As findVisibleLead, but a lead you can't see is "not found": the same reply
 *  as one that doesn't exist, so nothing leaks about other people's buyers. */
export async function visibleLead<T = any>(tx: Tx, s: Scope, leadId: string, opts: { cols?: string; lock?: boolean } = {}): Promise<T> {
  const l = await findVisibleLead<T>(tx, s, leadId, opts);
  if (!l) throw new NotFoundException('Lead not found');
  return l;
}

/** The person a follow-up or visit is handed to must be an active member of
 *  this workspace (RLS keeps it to this workspace; this keeps it to live people). */
export async function activeUser(tx: Tx, userId: string) {
  const u = (await tx.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId])).rows[0];
  if (!u) throw new BadRequestException({ code: 'assignee_inactive', message: 'That person is not an active user in this workspace' });
  return u.id as string;
}
