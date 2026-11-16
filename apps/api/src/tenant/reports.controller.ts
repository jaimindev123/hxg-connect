import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { Db, Tx } from '../db/db.service';
import { TenantGuard } from '../common/guards';
import { audit } from '../common/util';

type ColType = 'text' | 'int' | 'money' | 'percent' | 'minutes' | 'date' | 'decimal';
interface Col { key: string; label: string; type: ColType }
interface ReportDef {
  title: string; description: string; roles: string[];
  columns: Col[];
  /** scope: the people whose work is counted; null for the whole company. */
  query: (tx: Tx, from: string, to: string, scope: string[] | null) => Promise<any[]>;
  totals?: (rows: any[]) => Record<string, unknown>;
}

const sum = (rows: any[], k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
const ratio = (a: number, b: number) => (b ? a / b : 0);
const MGMT = ['owner', 'admin', 'sales_manager'];

const REPORTS: Record<string, ReportDef> = {
  lead_sources: {
    title: 'Lead sources', description: 'Where leads came from and how many turned into visits and bookings.',
    roles: [...MGMT, 'marketing', 'team_leader'],
    columns: [{ key: 'source', label: 'Source', type: 'text' }, { key: 'leads', label: 'Leads', type: 'int' },
      { key: 'visited', label: 'Visited site', type: 'int' }, { key: 'visit_rate', label: 'Visit rate', type: 'percent' },
      { key: 'booked', label: 'Booked', type: 'int' }, { key: 'conversion', label: 'Conversion', type: 'percent' },
      { key: 'booked_value', label: 'Booked value', type: 'money' }],
    async query(tx, from, to, scope) {
      const rows = (await tx.query(
        `SELECT COALESCE(l.source, 'unknown') AS source, count(*)::int AS leads,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM site_visits v WHERE v.lead_id = l.id AND v.status = 'completed'))::int AS visited,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.lead_id = l.id AND b.status <> 'cancelled'))::int AS booked,
           COALESCE(sum((SELECT sum(b.agreed_price) FROM bookings b WHERE b.lead_id = l.id AND b.status <> 'cancelled')), 0)::numeric AS booked_value
         FROM leads l WHERE l.created_at >= $1 AND l.created_at < $2 AND ($3::uuid[] IS NULL OR l.owner_id = ANY($3::uuid[]))
         GROUP BY 1 ORDER BY leads DESC`, [from, to, scope])).rows;
      return rows.map(r => ({ ...r, visit_rate: ratio(r.visited, r.leads), conversion: ratio(r.booked, r.leads) }));
    },
    totals: r => ({ source: 'Total', leads: sum(r, 'leads'), visited: sum(r, 'visited'), booked: sum(r, 'booked'),
      visit_rate: ratio(sum(r, 'visited'), sum(r, 'leads')), conversion: ratio(sum(r, 'booked'), sum(r, 'leads')), booked_value: sum(r, 'booked_value') }),
  },
  team: {
    title: 'Team performance', description: 'Calls, follow-ups, visits and bookings by person. Overdue is as of now.',
    roles: [...MGMT, 'team_leader'],
    columns: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'role', label: 'Role', type: 'text' },
      { key: 'new_leads', label: 'New leads', type: 'int' }, { key: 'calls', label: 'Calls made', type: 'int' },
      { key: 'talk_min', label: 'Talk time (min)', type: 'minutes' }, { key: 'follow_ups_done', label: 'Follow-ups done', type: 'int' },
      { key: 'overdue_now', label: 'Overdue now', type: 'int' }, { key: 'visits', label: 'Site visits', type: 'int' },
      { key: 'bookings', label: 'Bookings', type: 'int' }, { key: 'booked_value', label: 'Booked value', type: 'money' }],
    async query(tx, from, to, scope) {
      return (await tx.query(
        `SELECT u.name, r.name AS role,
           (SELECT count(*) FROM leads l WHERE l.owner_id = u.id AND l.created_at >= $1 AND l.created_at < $2)::int AS new_leads,
           (SELECT count(*) FROM calls c WHERE c.user_id = u.id AND c.direction = 'outbound' AND c.started_at >= $1 AND c.started_at < $2)::int AS calls,
           round((SELECT COALESCE(sum(c.duration_sec), 0) FROM calls c WHERE c.user_id = u.id AND c.started_at >= $1 AND c.started_at < $2) / 60.0, 1)::float AS talk_min,
           (SELECT count(*) FROM follow_ups f WHERE f.assigned_to = u.id AND f.status = 'done' AND f.completed_at >= $1 AND f.completed_at < $2)::int AS follow_ups_done,
           (SELECT count(*) FROM follow_ups f WHERE f.assigned_to = u.id AND f.status = 'pending' AND f.due_at < now())::int AS overdue_now,
           (SELECT count(*) FROM site_visits v WHERE v.executive_id = u.id AND v.status = 'completed' AND v.completed_at >= $1 AND v.completed_at < $2)::int AS visits,
           (SELECT count(*) FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE l.owner_id = u.id AND b.status <> 'cancelled' AND b.booked_at >= $1 AND b.booked_at < $2)::int AS bookings,
           (SELECT COALESCE(sum(b.agreed_price), 0) FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE l.owner_id = u.id AND b.status <> 'cancelled' AND b.booked_at >= $1 AND b.booked_at < $2)::numeric AS booked_value
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.status = 'active' AND r.key NOT IN ('finance','support','marketing') AND ($3::uuid[] IS NULL OR u.id = ANY($3::uuid[]))
         ORDER BY booked_value DESC, visits DESC, calls DESC, u.name`, [from, to, scope])).rows;
    },
    totals: r => ({ name: 'Total', ...Object.fromEntries(['new_leads', 'calls', 'talk_min', 'follow_ups_done', 'overdue_now', 'visits', 'bookings', 'booked_value'].map(k => [k, sum(r, k)])) }),
  },
  calls: {
    title: 'Calls by day', description: 'Outgoing, answered incoming and missed calls, with talk time.',
    roles: [...MGMT, 'team_leader'],
    columns: [{ key: 'day', label: 'Day', type: 'date' }, { key: 'outbound', label: 'Outgoing', type: 'int' },
      { key: 'connected', label: 'Connected', type: 'int' }, { key: 'answered_in', label: 'Incoming answered', type: 'int' },
      { key: 'missed', label: 'Missed', type: 'int' }, { key: 'avg_min', label: 'Avg length (min)', type: 'minutes' },
      { key: 'talk_min', label: 'Talk time (min)', type: 'minutes' }],
    async query(tx, from, to, scope) {
      return (await tx.query(
        `SELECT to_char((c.started_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound,
           count(*) FILTER (WHERE c.status = 'completed' AND c.duration_sec > 0)::int AS connected,
           count(*) FILTER (WHERE c.direction = 'inbound' AND c.status <> 'missed')::int AS answered_in,
           count(*) FILTER (WHERE c.status = 'missed')::int AS missed,
           COALESCE(round(avg(c.duration_sec) FILTER (WHERE c.duration_sec > 0) / 60.0, 1), 0)::float AS avg_min,
           round(COALESCE(sum(c.duration_sec), 0) / 60.0, 1)::float AS talk_min
         FROM calls c LEFT JOIN leads l ON l.id = c.lead_id
         WHERE c.started_at >= $1 AND c.started_at < $2 AND ($3::uuid[] IS NULL OR c.user_id = ANY($3::uuid[]) OR l.owner_id = ANY($3::uuid[]))
         GROUP BY 1 ORDER BY 1 DESC`, [from, to, scope])).rows;
    },
    totals: r => ({ day: 'Total', outbound: sum(r, 'outbound'), connected: sum(r, 'connected'), answered_in: sum(r, 'answered_in'),
      missed: sum(r, 'missed'), talk_min: Math.round(sum(r, 'talk_min') * 10) / 10 }),
  },
  site_visits: {
    title: 'Site visits', description: 'By project: turnout, check-in verification, interest and bookings after the visit.',
    roles: [...MGMT, 'team_leader'],
    columns: [{ key: 'project', label: 'Project', type: 'text' }, { key: 'scheduled', label: 'Scheduled', type: 'int' },
      { key: 'completed', label: 'Visited', type: 'int' }, { key: 'no_show', label: 'No-shows', type: 'int' },
      { key: 'verified', label: 'Verified by check-in', type: 'int' }, { key: 'avg_interest', label: 'Avg interest (of 5)', type: 'decimal' },
      { key: 'booked_after', label: 'Booked after visit', type: 'int' }],
    async query(tx, from, to, scope) {
      return (await tx.query(
        `SELECT p.name AS project, count(*)::int AS scheduled,
           count(*) FILTER (WHERE v.status = 'completed')::int AS completed,
           count(*) FILTER (WHERE v.status = 'no_show')::int AS no_show,
           count(*) FILTER (WHERE v.checkin_id IS NOT NULL)::int AS verified,
           round(avg(v.interest)::numeric, 1)::float AS avg_interest,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.lead_id = v.lead_id AND b.status <> 'cancelled' AND b.booked_at >= v.scheduled_at))::int AS booked_after
         FROM site_visits v JOIN projects p ON p.id = v.project_id LEFT JOIN leads l ON l.id = v.lead_id
         WHERE v.scheduled_at >= $1 AND v.scheduled_at < $2 AND ($3::uuid[] IS NULL OR v.executive_id = ANY($3::uuid[]) OR l.owner_id = ANY($3::uuid[]))
         GROUP BY p.name ORDER BY scheduled DESC`, [from, to, scope])).rows;
    },
    totals: r => ({ project: 'Total', ...Object.fromEntries(['scheduled', 'completed', 'no_show', 'verified', 'booked_after'].map(k => [k, sum(r, k)])) }),
  },
  bookings: {
    title: 'Bookings', description: 'Every booking in the period with what has been collected and what is overdue.',
    roles: [...MGMT, 'finance'],
    columns: [{ key: 'booked_on', label: 'Booked on', type: 'date' }, { key: 'buyer', label: 'Buyer', type: 'text' },
      { key: 'project', label: 'Project', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'list_price', label: 'List price', type: 'money' }, { key: 'agreed_price', label: 'Agreed', type: 'money' },
      { key: 'collected', label: 'Collected', type: 'money' }, { key: 'overdue', label: 'Overdue', type: 'money' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'owner', label: 'Sales owner', type: 'text' }],
    async query(tx, from, to) {
      return (await tx.query(
        `SELECT to_char((b.booked_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS booked_on, b.applicant->>'name' AS buyer,
           p.name AS project, t.name || '-' || u.unit_no AS unit, b.list_price, b.agreed_price,
           (SELECT COALESCE(sum(s.paid_amount), 0) FROM payment_schedule s WHERE s.booking_id = b.id)::numeric AS collected,
           (SELECT COALESCE(sum(s.amount - s.paid_amount), 0) FROM payment_schedule s WHERE s.booking_id = b.id AND s.due_date < current_date AND s.status <> 'paid')::numeric AS overdue,
           b.status, own.name AS owner
         FROM bookings b JOIN units u ON u.id = b.unit_id JOIN towers t ON t.id = u.tower_id JOIN projects p ON p.id = u.project_id
         JOIN leads l ON l.id = b.lead_id LEFT JOIN users own ON own.id = l.owner_id
         WHERE b.booked_at >= $1 AND b.booked_at < $2 ORDER BY b.booked_at DESC`, [from, to])).rows;
    },
    totals: r => { const live = r.filter(x => x.status !== 'cancelled');
      return { buyer: `${live.length} active`, agreed_price: sum(live, 'agreed_price'), collected: sum(r, 'collected'), overdue: sum(live, 'overdue') }; },
  },
  collections: {
    title: 'Collections by month', description: 'Instalments falling due each month against money actually received.',
    roles: [...MGMT, 'finance'],
    columns: [{ key: 'month', label: 'Month', type: 'text' }, { key: 'due', label: 'Falling due', type: 'money' },
      { key: 'collected', label: 'Received', type: 'money' }, { key: 'receipts', label: 'Receipts', type: 'int' },
      { key: 'collection_rate', label: 'Received vs due', type: 'percent' }],
    async query(tx, from, to) {
      const rows = (await tx.query(
        `WITH m AS (SELECT generate_series(date_trunc('month', $1::timestamptz AT TIME ZONE 'Asia/Kolkata'),
                                           date_trunc('month', ($2::timestamptz - interval '1 second') AT TIME ZONE 'Asia/Kolkata'), interval '1 month')::date AS month)
         SELECT to_char(m.month, 'Mon YYYY') AS month,
           (SELECT COALESCE(sum(s.amount), 0) FROM payment_schedule s JOIN bookings b ON b.id = s.booking_id
             WHERE b.status <> 'cancelled' AND s.due_date >= m.month AND s.due_date < m.month + interval '1 month')::numeric AS due,
           (SELECT COALESCE(sum(p.amount), 0) FROM payments p
             WHERE (p.received_at AT TIME ZONE 'Asia/Kolkata')::date >= m.month AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date < m.month + interval '1 month')::numeric AS collected,
           (SELECT count(*) FROM payments p
             WHERE (p.received_at AT TIME ZONE 'Asia/Kolkata')::date >= m.month AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date < m.month + interval '1 month')::int AS receipts
         FROM m ORDER BY m.month DESC`, [from, to])).rows;
      return rows.map(r => ({ ...r, collection_rate: ratio(Number(r.collected), Number(r.due)) }));
    },
    totals: r => ({ month: 'Total', due: sum(r, 'due'), collected: sum(r, 'collected'), receipts: sum(r, 'receipts'), collection_rate: ratio(sum(r, 'collected'), sum(r, 'due')) }),
  },
  lost_reasons: {
    title: 'Lost reasons', description: 'Why leads were marked lost in the period, from the reason given at the time.',
    roles: [...MGMT, 'marketing', 'team_leader'],
    columns: [{ key: 'reason', label: 'Reason', type: 'text' }, { key: 'leads', label: 'Leads', type: 'int' }, { key: 'share', label: 'Share', type: 'percent' }],
    async query(tx, from, to, scope) {
      const rows = (await tx.query(
        `SELECT COALESCE(NULLIF(trim(a.body), ''), 'No reason given') AS reason, count(DISTINCT a.lead_id)::int AS leads
         FROM activities a JOIN pipeline_stages s ON s.id = (a.meta->>'to')::uuid AND s.is_lost JOIN leads l ON l.id = a.lead_id
         WHERE a.type = 'stage_change' AND a.occurred_at >= $1 AND a.occurred_at < $2 AND ($3::uuid[] IS NULL OR l.owner_id = ANY($3::uuid[]))
         GROUP BY 1 ORDER BY leads DESC`, [from, to, scope])).rows;
      const total = sum(rows, 'leads');
      return rows.map(r => ({ ...r, share: ratio(r.leads, total) }));
    },
    totals: r => ({ reason: 'Total', leads: sum(r, 'leads'), share: r.length ? 1 : 0 }),
  },
};

/** Spreadsheet formula injection: a cell starting with = + - @ (or tab/CR)
 *  is executed by Excel. Prefix with a quote so it's shown as text. */
export const safeCell = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const csvCell = (v: unknown) => { const s = String(safeCell(v) ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

@Controller('reports')
@UseGuards(TenantGuard)
export class ReportsController {
  constructor(private readonly db: Db) {}

  @Get()
  list(@Req() req: Request) {
    const role = req.tenantUser!.role;
    return Object.entries(REPORTS).filter(([, r]) => r.roles.includes(role) || req.tenantUser!.imp)
      .map(([key, r]) => ({ key, title: r.title, description: r.description }));
  }

  @Get(':key')
  async run(@Param('key') key: string, @Query('from') fromQ: string, @Query('to') toQ: string,
            @Query('format') format = 'json', @Req() req: Request, @Res() res: Response) {
    const def = REPORTS[key];
    if (!def) throw new NotFoundException('Unknown report');
    const role = req.tenantUser!.role;
    if (!def.roles.includes(role) && !req.tenantUser!.imp) throw new ForbiddenException('This report is not available to your role');

    // Dates are calendar days in India time: from 00:00 IST to the end of "to".
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const toDay = day.test(toQ ?? '') ? toQ : today;
    const fromDay = day.test(fromQ ?? '') ? fromQ : new Date(Date.parse(toDay) - 29 * 864e5).toISOString().slice(0, 10);
    const span = (Date.parse(toDay) - Date.parse(fromDay)) / 864e5;
    if (Number.isNaN(span) || span < 0) throw new BadRequestException('The start date must be on or before the end date');
    if (span > 366) throw new BadRequestException('Reports cover up to one year at a time');
    const from = `${fromDay}T00:00:00+05:30`;
    const to = new Date(Date.parse(`${toDay}T00:00:00+05:30`) + 864e5).toISOString();
    // A team leader's reports cover their whole team, not just their own leads.
    const s = req.scope!;
    const scope = s.kind === 'all' ? null : (s.people ?? [s.me]);

    const rows = await this.db.withTenant(req.tenant!.id, tx => def.query(tx, from, to, scope));
    const totals = def.totals && rows.length ? def.totals(rows) : null;
    const meta = { key, title: def.title, description: def.description, from: fromDay, to: toDay, columns: def.columns };

    if (format === 'json') { res.json({ ...meta, rows, totals }); return; }
    await this.db.withTenant(req.tenant!.id, tx => audit(tx, req, 'report.exported', undefined, undefined, { key, format, from: fromDay, to: toDay }));
    const name = `${req.tenant!.subdomain}-${key}-${fromDay}-to-${toDay}`;
    const all = totals ? [...rows, totals] : rows;

    if (format === 'csv') {
      const lines = [def.columns.map(c => csvCell(c.label)).join(',')]
        .concat(all.map(r => def.columns.map(c => csvCell(c.type === 'percent' && r[c.key] !== undefined ? `${(Number(r[c.key]) * 100).toFixed(1)}%` : r[c.key])).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      res.send('\uFEFF' + lines.join('\r\n'));             // BOM so Excel reads ₹ and Hindi names correctly
      return;
    }
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'HXG Connect';
      const ws = wb.addWorksheet(def.title.slice(0, 31));
      ws.addRow([`${def.title}, ${fromDay} to ${toDay}`]).font = { bold: true, size: 13 };
      ws.addRow([]);
      const head = ws.addRow(def.columns.map(c => c.label));
      head.font = { bold: true };
      for (const r of all) ws.addRow(def.columns.map(c => {
        const v = r[c.key];
        if (v === null || v === undefined) return null;
        if (['int', 'money', 'percent', 'minutes', 'decimal'].includes(c.type)) return Number(v);
        if (c.type === 'date' && day.test(String(v))) return new Date(`${v}T00:00:00Z`);
        return safeCell(String(v));
      }));
      if (totals) ws.lastRow!.font = { bold: true };
      def.columns.forEach((c, i) => {
        const col = ws.getColumn(i + 1);
        col.width = Math.max(12, c.label.length + 4);
        col.numFmt = { money: '"₹"#,##0', percent: '0.0%', minutes: '0.0', decimal: '0.0', int: '0', date: 'dd mmm yyyy', text: '@' }[c.type];
      });
      ws.views = [{ state: 'frozen', ySplit: 3 }];
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      res.send(Buffer.from(await wb.xlsx.writeBuffer()));
      return;
    }
    throw new BadRequestException('format must be json, csv or xlsx');
  }
}
