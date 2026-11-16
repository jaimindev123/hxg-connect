import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, inr, Loading, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { useMe } from './App';

const MONEY = ['owner', 'admin', 'sales_manager', 'finance'];
const rupees = (n: number | string) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Search-as-you-type lead picker used when holding or booking a unit. */
export function LeadPicker({ value, onChange }: { value: any; onChange: (lead: any) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(() => tenantApi.get(`/leads?q=${encodeURIComponent(q.trim())}&limit=8`).then(r => setRows(r.data)).catch(() => setRows([])), 250);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) return <div className="row"><div className="input" style={{ display: 'flex', alignItems: 'center' }}>{value.name} <span className="faint">&nbsp;{value.primary_phone}</span></div>
    <button type="button" className="btn" style={{ flex: 'none' }} onClick={() => onChange(null)}>Change</button></div>;
  return (
    <div>
      <input className="input" placeholder="Search buyer by name or phone" value={q} onChange={e => setQ(e.target.value)} />
      {rows.length > 0 && <div className="panel" style={{ marginTop: 4 }}>{rows.map(r => (
        <button type="button" key={r.id} className="list-item" style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}
          onClick={() => { onChange(r); setQ(''); }}><span className="grow"><b>{r.name}</b> <span className="muted num">{r.primary_phone}</span></span><span className="chip">{r.stage}</span></button>))}</div>}
    </div>
  );
}

export function BookUnit({ unit, plans, lead: initialLead, onClose, onDone }:
  { unit: any; plans: any[]; lead?: any; onClose: () => void; onDone: (id: string) => void }) {
  const [lead, setLead] = useState<any>(initialLead ?? null);
  const [price, setPrice] = useState(String(Number(unit.base_price)));
  const [plan, setPlan] = useState(plans[0]?.id ?? '');
  const [app, setApp] = useState({ name: initialLead?.name ?? '', phone: initialLead?.primary_phone ?? '', email: initialLead?.email ?? '', co_applicant: '' });
  const { busy, error, run } = useSubmit();
  useEffect(() => { if (lead && !app.name) setApp(a => ({ ...a, name: lead.name, phone: lead.primary_phone ?? '' })); }, [lead]);
  const discount = 1 - Number(price) / Number(unit.base_price);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post('/bookings', {
      lead_id: lead.id, unit_id: unit.id, payment_plan_id: plan, agreed_price: Number(price),
      applicant: { name: app.name, phone: app.phone, email: app.email || undefined, co_applicant: app.co_applicant || undefined },
    }));
    if (r) onDone(r.id);
  }
  return (
    <Modal title={`Book unit ${unit.tower ? `${unit.tower}-` : ''}${unit.unit_no}`} onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="book" disabled={busy || !lead || !plan || !app.name || !app.phone}>{busy ? 'Booking…' : 'Confirm booking'}</button></>}>
      <form id="book" onSubmit={submit}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        {!plans.length && <div className="alert info">This project has no payment plan yet. Add one on the project page first.</div>}
        <Field label="Buyer (lead)"><LeadPicker value={lead} onChange={setLead} /></Field>
        <div className="row">
          <Field label="Agreed price (₹)" hint={`List ${rupees(unit.base_price)}${discount > 0.0001 ? `, ${(discount * 100).toFixed(1)}% off` : ''}`}>
            <input className="input" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          <Field label="Payment plan"><select className="input" value={plan} onChange={e => setPlan(e.target.value)}>
            {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        </div>
        <div className="row">
          <Field label="Applicant name" error={error?.field('applicant.name')}><input className="input" value={app.name} onChange={e => setApp({ ...app, name: e.target.value })} /></Field>
          <Field label="Applicant phone" error={error?.field('applicant.phone')}><input className="input" inputMode="tel" value={app.phone} onChange={e => setApp({ ...app, phone: e.target.value })} /></Field>
        </div>
        <div className="row">
          <Field label="Email (for payment links)" error={error?.field('applicant.email')}><input className="input" type="email" value={app.email} onChange={e => setApp({ ...app, email: e.target.value })} /></Field>
          <Field label="Co-applicant (optional)"><input className="input" value={app.co_applicant} onChange={e => setApp({ ...app, co_applicant: e.target.value })} /></Field>
        </div>
      </form>
    </Modal>
  );
}

// =====================================================================
export function BookingsList() {
  const nav = useNavigate();
  const q = useLoad<any[]>(() => tenantApi.get('/bookings'));
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  const live = q.data?.filter(b => b.status !== 'cancelled') ?? [];
  const booked = live.reduce((n, b) => n + Number(b.agreed_price), 0);
  const paid = live.reduce((n, b) => n + Number(b.paid), 0);
  const overdue = live.reduce((n, b) => n + Number(b.overdue), 0);
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Bookings</h1><p>Sold units and what's been collected.</p></div></div>
      {q.data && live.length > 0 && (
        <div className="figures">
          <div className="figure"><div className="v">{live.length}</div><div className="l">Active bookings</div></div>
          <div className="figure money"><div className="v">{inr(booked)}</div><div className="l">Booked value</div></div>
          <div className="figure"><div className="v">{inr(paid)}</div><div className="l">Collected</div></div>
          <div className={`figure ${overdue > 0 ? 'alert' : ''}`}><div className="v">{inr(overdue) === '—' ? '₹0' : inr(overdue)}</div><div className="l">Overdue</div></div>
        </div>
      )}
      <div className="table-wrap">
        {!q.data ? <Loading /> : !q.data.length ? <Empty title="No bookings yet">Book a unit from Inventory or from a lead's page.</Empty> : (
          <table><thead><tr><th>Buyer</th><th>Unit</th><th>Agreed</th><th>Collected</th><th>Status</th><th>Booked</th></tr></thead>
            <tbody>{q.data.map(b => (
              <tr key={b.id} className={`click ${Number(b.overdue) > 0 ? 'urgent' : ''}`} onClick={() => nav(`/bookings/${b.id}`)}>
                <td><b>{b.applicant?.name ?? b.lead_name}</b></td>
                <td>{b.project}<span className="sub">{b.tower}-{b.unit_no}, {b.unit_type}</span></td>
                <td className="money">{inr(b.agreed_price)}</td>
                <td className="num">{Math.round((Number(b.paid) / Number(b.agreed_price)) * 100)}%{Number(b.overdue) > 0 && <span className="sub overdue-text">{inr(b.overdue)} overdue</span>}</td>
                <td><span className={`chip ${b.status === 'cancelled' ? 'bad' : 'ok'}`}>{humanize(b.status)}</span></td>
                <td className="muted">{when(b.booked_at)}</td>
              </tr>))}</tbody></table>
        )}
      </div>
    </>
  );
}

export function BookingDetail() {
  const { id } = useParams();
  const { me } = useMe();
  const toast = useToast();
  const b = useLoad<any>(() => tenantApi.get(`/bookings/${id}`), [id]);
  const [paying, setPaying] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  if (b.error) return <ErrorState error={b.error} retry={b.reload} />;
  if (!b.data) return <Loading />;
  const d = b.data;
  const canMoney = MONEY.includes(me.user.role) && !me.support_session;
  const live = d.status !== 'cancelled';
  const today = new Date().toISOString().slice(0, 10);

  async function link(sid: string) {
    setLinking(sid);
    try {
      const r = await tenantApi.post(`/bookings/${id}/schedule/${sid}/payment-link`);
      await navigator.clipboard.writeText(r.url).catch(() => undefined);
      toast(`Payment link for ${inr(r.amount)} sent to the buyer by SMS${d.applicant.email ? ' and email' : ''}. Copied to clipboard too.`);
      b.reload();
    } catch (e: any) { toast(e.message, true); } finally { setLinking(null); }
  }

  return (
    <>
      <Link to="/bookings" className="small">Back to bookings</Link>
      <div className="lead-head" style={{ marginTop: 10 }}>
        <div className="grow"><h1>{d.applicant.name}</h1>
          <div className="facts"><span><b>{d.project}</b>, {d.tower}-{d.unit_no} ({d.unit_type})</span>
            <span>Agreed <b className="money">{rupees(d.agreed_price)}</b></span>
            {Number(d.list_price) > Number(d.agreed_price) && <span>List {rupees(d.list_price)}</span>}
            <span>{d.plan_name}</span><span>Booked {when(d.booked_at)}</span>
            <Link to={`/leads/${d.lead_id}`}>Open lead</Link></div></div>
        <span className={`chip ${live ? 'ok' : 'bad'}`}>{humanize(d.status)}</span>
        {live && ['owner', 'admin', 'sales_manager'].includes(me.user.role) && !me.support_session &&
          <button className="btn danger" onClick={() => setCancelling(true)}>Cancel booking</button>}
      </div>
      {!live && <div className="alert bad">Cancelled {when(d.cancelled_at)}: {d.cancel_reason}. The unit is back on sale; refunds are handled outside HXG Connect for now.</div>}

      <div className="section">
        <div className="section-head"><h2>Payment schedule</h2></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Instalment</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th><th /></tr></thead>
          <tbody>{d.schedule.map((s: any) => {
            const late = s.status !== 'paid' && s.due_date && s.due_date < today;
            return (
              <tr key={s.id} className={late ? 'urgent' : ''}>
                <td>{s.label}<span className="sub">{Number(s.percent)}%</span></td>
                <td className={late ? 'overdue-text' : ''}>{s.due_date ? new Date(s.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'On demand'}</td>
                <td className="money">{rupees(s.amount)}</td>
                <td className="num">{Number(s.paid_amount) > 0 ? rupees(s.paid_amount) : <span className="faint">—</span>}</td>
                <td><span className={`chip ${s.status === 'paid' ? 'ok' : late ? 'bad' : s.status === 'part_paid' ? 'warn' : ''}`}>{late ? 'Overdue' : humanize(s.status)}</span>
                  {s.payment_link_url && s.status !== 'paid' && <span className="sub"><a href={s.payment_link_url} target="_blank" rel="noreferrer">Link sent</a></span>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{canMoney && live && s.status !== 'paid' && <>
                  <button className="btn sm" disabled={linking === s.id} onClick={() => link(s.id)}>{linking === s.id ? 'Creating…' : 'Payment link'}</button>{' '}
                  <button className="btn sm primary" onClick={() => setPaying(s)}>Record payment</button></>}</td>
              </tr>);
          })}</tbody></table></div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Receipts</h2></div>
        <div className="table-wrap">{!d.payments.length ? <Empty title="No payments yet" /> : (
          <table><thead><tr><th>Received</th><th>Amount</th><th>Mode</th><th>Reference</th><th>Recorded by</th></tr></thead>
            <tbody>{d.payments.map((p: any) => (
              <tr key={p.id}><td>{when(p.received_at)}</td><td className="money">{rupees(p.amount)}</td><td>{p.mode === 'razorpay' ? 'Razorpay' : p.mode.toUpperCase()}</td>
                <td className="num">{p.reference ?? '—'}</td><td className="muted">{p.recorded_by_name ?? (p.mode === 'razorpay' ? 'Automatic' : '—')}</td></tr>))}</tbody></table>)}
        </div>
      </div>
      {paying && <RecordPayment bookingId={d.id} item={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); toast('Payment recorded'); b.reload(); }} />}
      {cancelling && <CancelBooking id={d.id} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); toast('Booking cancelled. The unit is available again.'); b.reload(); }} />}
    </>
  );
}

function RecordPayment({ bookingId, item, onClose, onDone }: { bookingId: string; item: any; onClose: () => void; onDone: () => void }) {
  const left = Math.round((Number(item.amount) - Number(item.paid_amount)) * 100) / 100;
  const [f, setF] = useState({ amount: String(left), mode: 'neft', reference: '', date: new Date().toISOString().slice(0, 10) });
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => tenantApi.post(`/bookings/${bookingId}/payments`, { schedule_id: item.id, amount: Number(f.amount), mode: f.mode,
      reference: f.reference || undefined, received_at: new Date(`${f.date}T12:00:00`).toISOString() }))) onDone();
  }
  return (
    <Modal title={`Record payment: ${item.label}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="pay" disabled={busy || !Number(f.amount)}>Record payment</button></>}>
      <form id="pay" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <div className="row">
          <Field label="Amount (₹)" hint={`${rupees(left)} due`}><input className="input" inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
          <Field label="Received on"><input className="input" type="date" value={f.date} max={new Date().toISOString().slice(0, 10)} onChange={e => setF({ ...f, date: e.target.value })} /></Field>
        </div>
        <div className="row">
          <Field label="Mode"><select className="input" value={f.mode} onChange={e => setF({ ...f, mode: e.target.value })}>
            {[['neft', 'NEFT / RTGS'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['other', 'Other']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Reference" hint="UTR, cheque number…"><input className="input" value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function CancelBooking({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit();
  return (
    <Modal title="Cancel this booking?" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Keep booking</button>
        <button className="btn danger" disabled={busy || reason.trim().length < 5} onClick={async () => { if (await run(() => tenantApi.post(`/bookings/${id}/cancel`, { reason }))) onDone(); }}>Cancel booking</button></>}>
      {error && <div className="alert bad">{error.message}</div>}
      <p className="muted small" style={{ marginBottom: 10 }}>The unit goes back on sale immediately. Payments already received stay on record.</p>
      <Field label="Reason"><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Home loan rejected by the bank" autoFocus /></Field>
    </Modal>
  );
}
