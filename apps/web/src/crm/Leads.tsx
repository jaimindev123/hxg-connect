import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { session, tenantApi } from '../lib/api';
import {
  budget, Empty, ErrorState, Field, humanize, isoToLocal, Loading, localToIso, Modal,
  useLoad, useSubmit, useToast, when,
} from '../lib/ui';
import { CompleteFollowUp, FOLLOW_UP_TYPES } from './MyDay';
import { MatchingUnits } from './Inventory';
import { ScheduleVisit } from './Visits';
import ImportLeads from './Import';
import { CallsPanel, useClickToCall, WhatsAppThread } from './Comms';
import { useMe } from './App';

const SOURCES = ['facebook', 'google_ads', 'instagram', 'website', '99acres', 'magicbricks', 'housing', 'walk_in', 'referral', 'channel_partner', 'event', 'other'];
const TYPES = ['apartment', 'villa', 'plot', 'commercial', 'office'];

export function usePipeline() {
  return useLoad<any[]>(() => tenantApi.get('/pipelines'));
}

// =====================================================================
export function LeadsList() {
  const nav = useNavigate();
  const { me } = useMe();
  const [importing, setImporting] = useState(false);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const pipes = usePipeline();
  const stages = pipes.data?.[0]?.stages ?? [];

  const query = (c?: string | null) => {
    const p = new URLSearchParams({ limit: '50' });
    if (q.trim()) p.set('q', q.trim());
    if (stage) p.set('stage_id', stage);
    if (c) p.set('cursor', c);
    return tenantApi.get<{ data: any[]; next_cursor: string | null }>(`/leads?${p}`);
  };
  const list = useLoad(() => query(), [q, stage]);
  useEffect(() => { if (list.data) { setRows(list.data.data); setCursor(list.data.next_cursor); } }, [list.data]);

  const toast = useToast();
  async function exportCsv() {
    try {
      const ws = session.workspace();
      const r = await fetch('/api/leads/export', { headers: { authorization: `Bearer ${session.token('tenant')}`, ...(ws && { 'x-tenant': ws }) } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? 'Export failed');
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'leads.csv';
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: name });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e: any) { toast(e.message, true); }
  }

  async function loadMore() {
    setMore(true);
    try { const r = await query(cursor); setRows(x => [...(x ?? []), ...r.data]); setCursor(r.next_cursor); }
    finally { setMore(false); }
  }

  return (
    <>
      <div className="page-head">
        <div className="grow"><h1>Leads</h1><p>Every enquiry, newest first.</p></div>
        {['owner', 'admin', 'sales_manager', 'crm_executive'].includes(me.user.role) && !me.support_session &&
          <><button className="btn" onClick={exportCsv}>Export</button><button className="btn" onClick={() => setImporting(true)}>Import</button></>}
        <button className="btn primary" onClick={() => setParams({ new: '1' })}>Add lead</button>
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Search name or phone" value={q} onChange={e => setQ(e.target.value)} aria-label="Search leads" />
        <select className="input" value={stage} onChange={e => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="">All stages</option>
          {stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {list.error ? <ErrorState error={list.error} retry={list.reload} /> : (
        <div className="table-wrap">
          {!rows ? <Loading /> : !rows.length ? (
            <Empty title={q || stage ? 'No leads match' : 'No leads yet'}
              action={!q && !stage ? <button className="btn primary" onClick={() => setParams({ new: '1' })}>Add your first lead</button> : undefined}>
              {q || stage ? 'Try a different search or stage.' : 'Add one by hand, or connect a lead source later.'}
            </Empty>
          ) : (
            <>
              <table>
                <thead><tr><th>Lead</th><th>Stage</th><th>Budget</th><th>Source</th><th>Owner</th><th>Last activity</th></tr></thead>
                <tbody>
                  {rows.map(l => (
                    <tr key={l.id} className="click" onClick={() => nav(`/leads/${l.id}`)}>
                      <td><Link to={`/leads/${l.id}`} onClick={e => e.stopPropagation()}><b>{l.name}</b></Link><span className="sub num">{l.primary_phone}</span></td>
                      <td><span className={`chip ${l.status === 'won' ? 'ok' : l.status === 'lost' ? 'bad' : ''}`}>{l.stage}</span></td>
                      <td className="money">{budget(l.budget_min, l.budget_max)}</td>
                      <td>{l.source ? humanize(l.source) : <span className="faint">—</span>}</td>
                      <td>{l.owner ?? <span className="faint">Unassigned</span>}</td>
                      <td className="muted">{when(l.last_activity_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {cursor && <div className="more-row"><button className="btn sm" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Load more'}</button></div>}
            </>
          )}
        </div>
      )}
      {importing && <ImportLeads onClose={() => setImporting(false)} onDone={() => list.reload()} />}
      {params.get('new') && <NewLead onClose={() => setParams({})} onCreated={() => { setParams({}); list.reload(); }} />}
    </>
  );
}

function NewLead({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ name: '', phone: '', email: '', source: '', property_type: '', budget_min: '', budget_max: '', locations: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }));
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const lakh = (v: string) => (v ? Math.round(Number(v) * 1e5) : undefined);
    const r = await run(() => tenantApi.post('/leads', {
      name: f.name, phone: f.phone, email: f.email || undefined, source: f.source || undefined,
      property_type: f.property_type || undefined, budget_min: lakh(f.budget_min), budget_max: lakh(f.budget_max),
      preferred_locations: f.locations.split(',').map(s => s.trim()).filter(Boolean),
    }));
    if (!r) return;
    if (r.duplicate_of) { toast('Already in your leads. This enquiry was added to their timeline.'); nav(`/leads/${r.duplicate_of}`); }
    else { toast(`${f.name} added`); onCreated(); }
  }

  return (
    <Modal title="Add lead" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="new-lead" disabled={busy || !f.name || !f.phone}>{busy ? 'Adding…' : 'Add lead'}</button></>}>
      <form id="new-lead" onSubmit={submit}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        <Field label="Name" error={error?.field('name')}><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
        <div className="row">
          <Field label="Phone" error={error?.field('phone')} hint="10-digit mobile or with country code"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email (optional)" error={error?.field('email')}><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        <div className="row">
          <Field label="Source"><select className="input" value={f.source} onChange={set('source')}><option value="">Not known</option>{SOURCES.map(s => <option key={s} value={s}>{humanize(s)}</option>)}</select></Field>
          <Field label="Looking for"><select className="input" value={f.property_type} onChange={set('property_type')}><option value="">Not known</option>{TYPES.map(s => <option key={s} value={s}>{humanize(s)}</option>)}</select></Field>
        </div>
        <div className="row">
          <Field label="Budget from (₹ lakh)" error={error?.field('budget_min')}><input className="input" inputMode="decimal" value={f.budget_min} onChange={set('budget_min')} placeholder="80" /></Field>
          <Field label="Budget to (₹ lakh)"><input className="input" inputMode="decimal" value={f.budget_max} onChange={set('budget_max')} placeholder="95" /></Field>
        </div>
        <Field label="Preferred locations" hint="Separate with commas"><input className="input" value={f.locations} onChange={set('locations')} placeholder="Indirapuram, Vaishali" /></Field>
      </form>
    </Modal>
  );
}

// =====================================================================
export function LeadDetail() {
  const { id } = useParams();
  const toast = useToast();
  const lead = useLoad<any>(() => tenantApi.get(`/leads/${id}`), [id]);
  const fus = useLoad<any[]>(() => tenantApi.get(`/follow-ups?lead_id=${id}`), [id]);
  const pipes = usePipeline();
  const [closing, setClosing] = useState<any>(null);
  const [lostTo, setLostTo] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [visiting, setVisiting] = useState(false);
  const [callsKey, setCallsKey] = useState(0);
  const dialer = useClickToCall(() => setTimeout(() => setCallsKey(k => k + 1), 1500));
  const [note, setNote] = useState('');
  const noteSubmit = useSubmit();

  if (lead.error) return <ErrorState error={lead.error} retry={lead.reload} />;
  if (!lead.data) return <Loading />;
  const l = lead.data;
  const stages = pipes.data?.find(p => p.id === l.pipeline_id)?.stages ?? [];
  const pending = (fus.data ?? []).filter(f => f.status === 'pending');
  const refresh = () => { lead.reload(); fus.reload(); };

  async function moveTo(stageId: string, reason?: string) {
    try {
      const r = await tenantApi.post(`/leads/${id}/stage`, { stage_id: stageId, note: reason });
      toast(`Moved to ${r.stage}`); setLostTo(null); refresh();
    } catch (e: any) { toast(e.message, true); }
  }
  function onStage(stageId: string) {
    const s = stages.find((x: any) => x.id === stageId);
    if (s?.is_lost) setLostTo(s); else moveTo(stageId);
  }
  async function addNote(e: FormEvent) {
    e.preventDefault();
    const r = await noteSubmit.run(() => tenantApi.post(`/leads/${id}/notes`, { body: note }));
    if (r) { setNote(''); lead.reload(); }
  }

  return (
    <>
      <Link to="/leads" className="small">Back to leads</Link>
      <div className="lead-head" style={{ marginTop: 10 }}>
        <div className="grow">
          <h1>{l.name}</h1>
          <div className="facts">
            <span className="num"><b>{l.primary_phone}</b></span>
            {l.email && <span>{l.email}</span>}
            <span>Budget <b className="money">{budget(l.budget_min, l.budget_max)}</b></span>
            {l.property_type && <span>Wants <b>{humanize(l.property_type)}</b></span>}
            {l.preferred_locations?.length > 0 && <span>In <b>{l.preferred_locations.join(', ')}</b></span>}
            {l.source && <span>From <b>{humanize(l.source)}</b></span>}
            <span>Owner <b>{l.owner ?? 'Unassigned'}</b></span>
          </div>
        </div>
        <button className="btn primary" onClick={() => dialer.call(l.id, l.primary_phone)}>Call</button>
        <a className="btn" href={`https://wa.me/${l.primary_phone.replace('+', '')}`} target="_blank" rel="noreferrer">WhatsApp</a>
        {l.status === 'open' && <button className="btn" onClick={() => setVisiting(true)}>Site visit</button>}
        <select className="input" style={{ width: 190 }} value={l.stage_id} onChange={e => onStage(e.target.value)} aria-label="Stage">
          {stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div className="grid-2">
        <div>
          <div className="section">
            <div className="section-head"><h2>Activity</h2></div>
            <form onSubmit={addNote} className="row" style={{ marginBottom: 6 }}>
              <input className="input" placeholder="Add a note: what they said, what they want" value={note} onChange={e => setNote(e.target.value)} />
              <button className="btn" style={{ flex: 'none' }} disabled={!note.trim() || noteSubmit.busy}>Add note</button>
            </form>
            <div>
              {l.timeline.map((t: any) => (
                <div key={t.id} className="timeline-item">
                  <span className={`dot ${t.type === 'stage_change' ? 'act' : t.type === 're_enquiry' ? 'warn' : t.type === 'follow_up' ? 'brass' : ''}`} />
                  <div>
                    <div><b>{t.type === 'stage_change' ? `Moved to ${t.meta?.to_name}` : t.type === 're_enquiry' ? 'Enquired again' : t.type === 'follow_up' ? 'Follow-up done' : t.type === 'note' ? 'Note' : t.body}</b>
                      <span className="muted small"> {t.actor ?? 'System'}, {when(t.occurred_at)}</span></div>
                    {t.type !== 'system' && t.body && <div style={{ marginTop: 2 }}>{t.body}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="section">
            <div className="section-head"><h2>Next step</h2><span className="grow" /><button className="btn sm" onClick={() => setAdding(true)}>Schedule</button></div>
            {!pending.length ? (
              l.status === 'open'
                ? <div className="next-box urgent"><b>Nothing scheduled.</b><p className="small muted" style={{ margin: '4px 0 10px' }}>Leads without a next step are the ones that go cold.</p><button className="btn sm primary" onClick={() => setAdding(true)}>Schedule a follow-up</button></div>
                : <div className="next-box muted">This lead is {l.status}.</div>
            ) : pending.map(f => {
              const late = new Date(f.due_at) < new Date();
              return (
                <div key={f.id} className={`next-box ${late ? 'urgent' : ''}`} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <div style={{ flex: 1 }}><b>{humanize(f.type)}</b> <span className={late ? 'overdue-text' : 'muted'}>{when(f.due_at)}</span>
                      {f.note && <div className="small muted">{f.note}</div>}<div className="small faint">{f.assignee}</div></div>
                    <button className="btn sm primary" onClick={() => setClosing({ ...f, lead_name: l.name })}>Done</button>
                  </div>
                </div>
              );
            })}
          </div>
          <MatchingUnits lead={l} onChanged={refresh} />
          <CallsPanel leadId={l.id} refreshKey={callsKey} />
          <WhatsAppThread leadId={l.id} />
        </div>
      </div>

      {dialer.prompt}
      {visiting && <ScheduleVisit lead={l} onClose={() => setVisiting(false)} onDone={() => { setVisiting(false); toast('Site visit scheduled'); refresh(); }} />}
      {adding && <ScheduleFollowUp leadId={l.id} onClose={() => setAdding(false)} onDone={() => { setAdding(false); fus.reload(); }} />}
      {closing && <CompleteFollowUp followUp={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); refresh(); }} />}
      {lostTo && <LostReason onClose={() => setLostTo(null)} onConfirm={reason => moveTo(lostTo.id, reason)} />}
    </>
  );
}

function ScheduleFollowUp({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: () => void }) {
  const t = new Date(Date.now() + 2 * 3600e3); t.setMinutes(0, 0, 0);
  const [type, setType] = useState('call');
  const [due, setDue] = useState(isoToLocal(t));
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => tenantApi.post('/follow-ups', { lead_id: leadId, type, due_at: localToIso(due), note: note || undefined }))) onDone();
  }
  return (
    <Modal title="Schedule a follow-up" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="sched" disabled={busy}>Schedule</button></>}>
      <form id="sched" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <div className="row">
          <Field label="Type"><select className="input" value={type} onChange={e => setType(e.target.value)}>{FOLLOW_UP_TYPES.map(x => <option key={x} value={x}>{humanize(x)}</option>)}</select></Field>
          <Field label="When"><input className="input" type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></Field>
        </div>
        <Field label="Note (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Send the 3BHK cost sheet first" /></Field>
      </form>
    </Modal>
  );
}

export function LostReason({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const common = ['Budget mismatch', 'Bought elsewhere', 'Location not suitable', 'Not reachable', 'Plan postponed'];
  return (
    <Modal title="Why was this lead lost?" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={reason.trim().length < 3} onClick={() => onConfirm(reason)}>Mark as lost</button></>}>
      <p className="muted small" style={{ marginBottom: 10 }}>This feeds the lost-reasons report, so pick the real one.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {common.map(c => <button key={c} type="button" className={`btn sm ${reason === c ? 'primary' : ''}`} onClick={() => setReason(c)}>{c}</button>)}
      </div>
      <Field label="Or describe it"><input className="input" value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
