import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, inr, Loading, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { useMe } from './App';
import { BookUnit, LeadPicker } from './Bookings';

const INV_ADMIN = ['owner', 'admin', 'sales_manager'];
const BOOKERS = ['owner', 'admin', 'sales_manager', 'team_leader', 'sales_executive', 'crm_executive'];
const STATUS_LABEL: Record<string, string> = { available: 'Available', hold: 'On hold', booked: 'Booked', blocked: 'Blocked' };

export function InventoryList() {
  const { me } = useMe();
  const nav = useNavigate();
  const q = useLoad<any[]>(() => tenantApi.get('/projects'));
  const [adding, setAdding] = useState(false);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  const admin = INV_ADMIN.includes(me.user.role) && !me.support_session;
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Inventory</h1><p>Projects, towers and what's left to sell.</p></div>
        {admin && <button className="btn primary" onClick={() => setAdding(true)}>New project</button>}</div>
      <div className="table-wrap">
        {!q.data ? <Loading /> : !q.data.length ? (
          <Empty title="No projects yet" action={admin ? <button className="btn primary" onClick={() => setAdding(true)}>Add your first project</button> : undefined}>
            Add a project, then generate its towers and units in one step.</Empty>
        ) : (
          <table><thead><tr><th>Project</th><th>Status</th><th>Available</th><th>On hold</th><th>Booked</th><th>Total units</th></tr></thead>
            <tbody>{q.data.map(p => (
              <tr key={p.id} className="click" onClick={() => nav(`/inventory/${p.id}`)}>
                <td><b>{p.name}</b><span className="sub">{[p.locality, p.city].filter(Boolean).join(', ') || '—'}{p.rera_number ? `, RERA ${p.rera_number}` : ''}</span></td>
                <td><span className={`chip ${p.status === 'active' ? 'ok' : ''}`}>{humanize(p.status)}</span></td>
                <td className="num" style={{ color: 'var(--ok)', fontWeight: 600 }}>{p.available}</td>
                <td className="num">{p.on_hold}</td><td className="num">{p.booked}</td><td className="num">{p.total}</td>
              </tr>))}</tbody></table>
        )}
      </div>
      {adding && <NewProject onClose={() => setAdding(false)} onDone={id => nav(`/inventory/${id}`)} />}
    </>
  );
}

function NewProject({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: '', city: '', locality: '', rera_number: '', possession_date: '' });
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post('/projects', { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }));
    if (r) onDone(r.id);
  }
  return (
    <Modal title="New project" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="proj" disabled={busy || f.name.trim().length < 2}>Create project</button></>}>
      <form id="proj" onSubmit={submit}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        <Field label="Project name" error={error?.field('name')}><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <div className="row">
          <Field label="Locality"><input className="input" value={f.locality} onChange={e => setF({ ...f, locality: e.target.value })} placeholder="Indirapuram" /></Field>
          <Field label="City"><input className="input" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} placeholder="Ghaziabad" /></Field>
        </div>
        <div className="row">
          <Field label="RERA number (optional)"><input className="input" value={f.rera_number} onChange={e => setF({ ...f, rera_number: e.target.value })} /></Field>
          <Field label="Possession date (optional)"><input className="input" type="date" value={f.possession_date} onChange={e => setF({ ...f, possession_date: e.target.value })} /></Field>
        </div>
      </form>
    </Modal>
  );
}

// =====================================================================
export function ProjectView() {
  const { id } = useParams();
  const { me } = useMe();
  const p = useLoad<any>(() => tenantApi.get(`/projects/${id}`), [id]);
  const [tower, setTower] = useState<string | null>(null);
  const [addingTower, setAddingTower] = useState(false);
  const [addingPlan, setAddingPlan] = useState(false);
  useEffect(() => { if (p.data?.towers.length && !tower) setTower(p.data.towers[0].id); }, [p.data, tower]);
  if (p.error) return <ErrorState error={p.error} retry={p.reload} />;
  if (!p.data) return <Loading />;
  const d = p.data;
  const admin = INV_ADMIN.includes(me.user.role) && !me.support_session;

  return (
    <>
      <Link to="/inventory" className="small">All projects</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <div className="grow"><h1>{d.name}</h1><p>{[d.locality, d.city].filter(Boolean).join(', ')}{d.rera_number && `, RERA ${d.rera_number}`}{d.possession_date && `, possession ${new Date(d.possession_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`}</p></div>
        {admin && <button className="btn" onClick={() => setAddingPlan(true)}>Add payment plan</button>}
        {admin && <button className="btn primary" onClick={() => setAddingTower(true)}>Add tower</button>}
      </div>
      {!d.towers.length ? (
        <div className="panel"><Empty title="No towers yet" action={admin ? <button className="btn primary" onClick={() => setAddingTower(true)}>Add a tower</button> : undefined}>
          Describe one floor's layout and the number of floors; every unit is created for you.</Empty></div>
      ) : (
        <>
          <div className="tabs">{d.towers.map((t: any) => (
            <button key={t.id} className={tower === t.id ? 'on' : ''} onClick={() => setTower(t.id)}>{t.name} <span className="faint">{t.available}/{t.total}</span></button>))}</div>
          {tower && <TowerGrid key={tower} towerId={tower} plans={d.plans} towerName={d.towers.find((t: any) => t.id === tower)?.name} onChanged={p.reload} />}
        </>
      )}
      <div className="section" style={{ marginTop: 28 }}>
        <div className="section-head"><h2>Payment plans</h2></div>
        <div className="panel">{!d.plans.length ? <Empty title="No payment plans">Bookings need one. Add a plan such as construction-linked or 10:90.</Empty> :
          d.plans.map((pl: any) => (
            <div key={pl.id} className="list-item"><div className="grow"><b>{pl.name}</b>
              <div className="small muted">{pl.milestones.map((m: any) => `${m.percent}% ${m.label.toLowerCase()}`).join(', ')}</div></div></div>))}</div>
      </div>
      {addingTower && <AddTower projectId={d.id} onClose={() => setAddingTower(false)} onDone={t => { setAddingTower(false); setTower(t); p.reload(); }} />}
      {addingPlan && <AddPlan projectId={d.id} onClose={() => setAddingPlan(false)} onDone={() => { setAddingPlan(false); p.reload(); }} />}
    </>
  );
}

function TowerGrid({ towerId, towerName, plans, onChanged }: { towerId: string; towerName?: string; plans: any[]; onChanged: () => void }) {
  const units = useLoad<any[]>(() => tenantApi.get(`/towers/${towerId}/units`), [towerId]);
  const [sel, setSel] = useState<any>(null);
  if (units.error) return <ErrorState error={units.error} retry={units.reload} />;
  if (!units.data) return <Loading />;
  const floors = Array.from(new Set(units.data.map(u => u.floor))).sort((a, b) => b - a);
  const counts = units.data.reduce((m: any, u) => ({ ...m, [u.status]: (m[u.status] ?? 0) + 1 }), {});
  return (
    <>
      <div className="legend">{Object.keys(STATUS_LABEL).map(s => <span key={s}><i className={`lg-${s}`} />{STATUS_LABEL[s]} {counts[s] ?? 0}</span>)}</div>
      <div className="grid-wrap" role="grid" aria-label={`Units in ${towerName}`}>
        {floors.map(f => (
          <div key={f} className="floor-row" role="row"><span className="fl">F{f}</span>
            {units.data!.filter(u => u.floor === f).map(u => (
              <button key={u.id} role="gridcell" className={`ucell ${u.status} ${sel?.id === u.id ? 'sel' : ''}`} onClick={() => setSel(u)}
                aria-label={`${u.unit_no}, ${u.unit_type}, ${STATUS_LABEL[u.status]}, ${inr(u.base_price)}`}>
                {u.unit_no}<small>{u.unit_type}</small></button>))}
          </div>))}
      </div>
      {sel && <UnitDrawer unit={{ ...sel, tower: towerName }} plans={plans} onClose={() => setSel(null)}
        onChanged={() => { units.reload(); onChanged(); setSel(null); }} />}
    </>
  );
}

function UnitDrawer({ unit: u, plans, onClose, onChanged }: { unit: any; plans: any[]; onClose: () => void; onChanged: () => void }) {
  const { me } = useMe();
  const toast = useToast();
  const nav = useNavigate();
  const [lead, setLead] = useState<any>(null);
  const [hours, setHours] = useState('48');
  const [booking, setBooking] = useState(false);
  const can = BOOKERS.includes(me.user.role) && !me.support_session;
  const admin = INV_ADMIN.includes(me.user.role) && !me.support_session;
  async function act(fn: () => Promise<any>, msg: string) {
    try { await fn(); toast(msg); onChanged(); } catch (e: any) { toast(e.message, true); }
  }
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label={`Unit ${u.unit_no}`}>
        <div style={{ display: 'flex' }}><div style={{ flex: 1 }}><h2>{u.tower}-{u.unit_no}</h2><p className="muted small">{u.unit_type}, floor {u.floor}</p></div>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>
        <dl className="kv">
          <dt>Status</dt><dd><span className={`chip ${u.status === 'available' ? 'ok' : u.status === 'hold' ? 'warn' : u.status === 'booked' ? 'bad' : ''}`}>{STATUS_LABEL[u.status]}</span></dd>
          <dt>Price</dt><dd className="money">₹{Number(u.base_price).toLocaleString('en-IN')}</dd>
          {u.super_sqft && <><dt>Super area</dt><dd className="num">{Number(u.super_sqft).toLocaleString('en-IN')} sq ft{u.carpet_sqft ? `, carpet ${Number(u.carpet_sqft).toLocaleString('en-IN')}` : ''}</dd></>}
          {u.super_sqft && <><dt>Rate</dt><dd className="num">₹{Math.round(u.base_price / u.super_sqft).toLocaleString('en-IN')} / sq ft</dd></>}
          {u.facing && <><dt>Facing</dt><dd>{u.facing}</dd></>}
          {u.status === 'hold' && <><dt>Held for</dt><dd>{u.hold_lead_id
            ? <Link to={`/leads/${u.hold_lead_id}`}>{u.hold_lead_name}</Link>
            : <>another team's buyer{u.hold_by_name ? <span className="faint"> (held by {u.hold_by_name})</span> : null}</>}, until {when(u.hold_expires_at).toLowerCase()}</dd></>}
        </dl>
        {u.status === 'booked' && u.booking_id && <button className="btn" onClick={() => nav(`/bookings/${u.booking_id}`)}>Open booking</button>}
        {can && u.status === 'available' && (
          <>
            <h3 style={{ marginBottom: 8 }}>Hold for a buyer</h3>
            <Field label="Buyer"><LeadPicker value={lead} onChange={setLead} /></Field>
            <Field label="Hold for"><select className="input" value={hours} onChange={e => setHours(e.target.value)}>
              {[['24', '24 hours'], ['48', '48 hours'], ['72', '3 days'], ['168', '7 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <div className="row">
              <button className="btn" disabled={!lead} onClick={() => act(() => tenantApi.post(`/units/${u.id}/hold`, { lead_id: lead.id, hours: Number(hours) }), `Held for ${lead.name}`)}>Hold</button>
              <button className="btn primary" onClick={() => setBooking(true)}>Book now</button>
            </div>
          </>
        )}
        {can && u.status === 'hold' && <div className="row">
          <button className="btn" onClick={() => act(() => tenantApi.post(`/units/${u.id}/release`), 'Hold released')}>Release hold</button>
          {u.hold_lead_id && <button className="btn primary" onClick={() => setBooking(true)}>Book for {u.hold_lead_name}</button>}</div>}
        {admin && (u.status === 'available' || u.status === 'blocked') && (
          <button className="btn ghost" style={{ marginTop: 18 }} onClick={() => act(() => tenantApi.patch(`/units/${u.id}`, { status: u.status === 'blocked' ? 'available' : 'blocked' }),
            u.status === 'blocked' ? 'Unit back on sale' : 'Unit blocked from sale')}>{u.status === 'blocked' ? 'Put back on sale' : 'Block from sale'}</button>)}
      </aside>
      {booking && <BookUnit unit={u} plans={plans} lead={u.status === 'hold' ? { id: u.hold_lead_id, name: u.hold_lead_name } : lead ?? undefined}
        onClose={() => setBooking(false)} onDone={id => { toast('Booked. Payment schedule created.'); nav(`/bookings/${id}`); }} />}
    </>
  );
}

function AddTower({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: (towerId: string) => void }) {
  const [f, setF] = useState({ name: '', floors: '12', start_floor: '1', floor_rise: '' });
  const [layout, setLayout] = useState([{ unit_type: '2BHK', super_sqft: '', facing: '', price_lakh: '' }, { unit_type: '3BHK', super_sqft: '', facing: '', price_lakh: '' }]);
  const { busy, error, run } = useSubmit();
  const set = (i: number, k: string, v: string) => setLayout(l => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const total = (Number(f.floors) || 0) * layout.length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post(`/projects/${projectId}/towers`, {
      name: f.name, floors: Number(f.floors), start_floor: Number(f.start_floor), floor_rise: Number(f.floor_rise || 0),
      layout: layout.map(l => ({ unit_type: l.unit_type, super_sqft: l.super_sqft ? Number(l.super_sqft) : undefined,
        facing: l.facing || undefined, base_price: Math.round(Number(l.price_lakh) * 1e5) })),
    }));
    if (r) onDone(r.id);
  }
  return (
    <Modal title="Add tower" onClose={onClose} wide
      footer={<><span className="small muted" style={{ marginRight: 'auto' }}>{total > 0 ? `Creates ${total} units` : ''}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" form="tower" disabled={busy || !f.name || !total || layout.some(l => !Number(l.price_lakh))}>{busy ? 'Creating units…' : 'Create tower'}</button></>}>
      <form id="tower" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <div className="row">
          <Field label="Tower name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="T2" autoFocus /></Field>
          <Field label="Floors"><input className="input" inputMode="numeric" value={f.floors} onChange={e => setF({ ...f, floors: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="First floor number"><select className="input" value={f.start_floor} onChange={e => setF({ ...f, start_floor: e.target.value })}><option value="0">0 (ground)</option><option value="1">1</option></select></Field>
          <Field label="Floor rise (₹ per floor)" hint="Added for each floor up"><input className="input" inputMode="numeric" value={f.floor_rise} onChange={e => setF({ ...f, floor_rise: e.target.value.replace(/\D/g, '') })} placeholder="50000" /></Field>
        </div>
        <h3 style={{ margin: '6px 0 8px' }}>One floor's layout</h3>
        <p className="small muted" style={{ marginBottom: 8 }}>Each row is a flat position on every floor. Unit numbers follow floor + position: 1201, 1202…</p>
        {layout.map((l, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={`Position ${i + 1} type`}><input className="input" value={l.unit_type} onChange={e => set(i, 'unit_type', e.target.value)} /></Field>
            <Field label="Super area (sq ft)"><input className="input" inputMode="numeric" value={l.super_sqft} onChange={e => set(i, 'super_sqft', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Facing"><input className="input" value={l.facing} onChange={e => set(i, 'facing', e.target.value)} placeholder="East" /></Field>
            <Field label="Base price (₹ lakh)"><input className="input" inputMode="decimal" value={l.price_lakh} onChange={e => set(i, 'price_lakh', e.target.value.replace(/[^\d.]/g, ''))} /></Field>
            <div className="field"><button type="button" className="btn ghost" disabled={layout.length === 1} onClick={() => setLayout(x => x.filter((_, j) => j !== i))} aria-label="Remove position">✕</button></div>
          </div>))}
        <button type="button" className="btn sm" onClick={() => setLayout(x => [...x, { unit_type: '', super_sqft: '', facing: '', price_lakh: '' }])}>Add position</button>
      </form>
    </Modal>
  );
}

function AddPlan({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('Construction linked');
  const [ms, setMs] = useState([{ label: 'On booking', percent: '10', due_days: '0' }, { label: 'Within 45 days', percent: '40', due_days: '45' }, { label: 'On possession', percent: '50', due_days: '' }]);
  const { busy, error, run } = useSubmit();
  const total = ms.reduce((n, m) => n + (Number(m.percent) || 0), 0);
  const set = (i: number, k: string, v: string) => setMs(l => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => tenantApi.post(`/projects/${projectId}/payment-plans`, { name,
      milestones: ms.map(m => ({ label: m.label, percent: Number(m.percent), due_days: m.due_days === '' ? null : Number(m.due_days) })) }))) onDone();
  }
  return (
    <Modal title="Add payment plan" onClose={onClose} wide
      footer={<><span className={`small ${Math.abs(total - 100) < 0.001 ? 'muted' : 'overdue-text'}`} style={{ marginRight: 'auto' }}>Total {total}% {Math.abs(total - 100) < 0.001 ? '' : '(must be 100%)'}</span>
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="plan" disabled={busy || Math.abs(total - 100) > 0.001}>Save plan</button></>}>
      <form id="plan" onSubmit={submit}>
        {error && <div className="alert bad">{error.field('milestones') ?? error.message}</div>}
        <Field label="Plan name"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        {ms.map((m, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={`Milestone ${i + 1}`}><input className="input" value={m.label} onChange={e => set(i, 'label', e.target.value)} /></Field>
            <Field label="Percent"><input className="input" inputMode="decimal" value={m.percent} onChange={e => set(i, 'percent', e.target.value.replace(/[^\d.]/g, ''))} /></Field>
            <Field label="Due after (days)" hint="Blank = on demand"><input className="input" inputMode="numeric" value={m.due_days} onChange={e => set(i, 'due_days', e.target.value.replace(/\D/g, ''))} /></Field>
            <div className="field"><button type="button" className="btn ghost" disabled={ms.length === 1} onClick={() => setMs(x => x.filter((_, j) => j !== i))} aria-label="Remove milestone">✕</button></div>
          </div>))}
        <button type="button" className="btn sm" onClick={() => setMs(x => [...x, { label: '', percent: '', due_days: '' }])}>Add milestone</button>
      </form>
    </Modal>
  );
}

/** On a lead's page: available units that fit their budget, with hold/book. */
export function MatchingUnits({ lead, onChanged }: { lead: any; onChanged: () => void }) {
  const { me } = useMe();
  const toast = useToast();
  const nav = useNavigate();
  const m = useLoad<any[]>(() => tenantApi.get(`/units/match?lead_id=${lead.id}`), [lead.id, lead.budget_max, lead.budget_min]);
  const [book, setBook] = useState<{ unit: any; plans: any[] } | null>(null);
  if (!m.data || (!lead.budget_max && !lead.budget_min)) return null;
  const can = BOOKERS.includes(me.user.role) && !me.support_session && lead.status === 'open';
  async function hold(u: any) {
    try { await tenantApi.post(`/units/${u.id}/hold`, { lead_id: lead.id, hours: 48 }); toast(`${u.tower}-${u.unit_no} held for 48 hours`); m.reload(); onChanged(); }
    catch (e: any) { toast(e.message, true); }
  }
  async function startBooking(u: any) {
    try { const p = await tenantApi.get(`/projects/${u.project_id}`); setBook({ unit: u, plans: p.plans }); }
    catch (e: any) { toast(e.message, true); }
  }
  return (
    <div className="section">
      <div className="section-head"><h2>Units in budget</h2></div>
      <div className="panel">{!m.data.length ? <Empty title="Nothing available in this budget" /> : m.data.slice(0, 6).map(u => (
        <div key={u.id} className="list-item">
          <div className="grow"><b>{u.tower}-{u.unit_no}</b> <span className="muted">{u.unit_type}{u.facing ? `, ${u.facing}` : ''}</span>
            <div className="small muted">{u.project}{u.super_sqft ? `, ${Number(u.super_sqft).toLocaleString('en-IN')} sq ft` : ''}</div></div>
          <span className="money">{inr(u.base_price)}</span>
          {can && <><button className="btn sm" onClick={() => hold(u)}>Hold</button><button className="btn sm primary" onClick={() => startBooking(u)}>Book</button></>}
        </div>))}</div>
      {book && <BookUnit unit={book.unit} plans={book.plans} lead={lead} onClose={() => setBook(null)}
        onDone={id => { toast('Booked. Payment schedule created.'); nav(`/bookings/${id}`); }} />}
    </div>
  );
}
