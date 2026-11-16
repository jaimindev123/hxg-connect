import { FormEvent, useState } from 'react';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, inr, Loading, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { useMe } from './App';

export default function Partners() {
  const { me } = useMe();
  const [tab, setTab] = useState<'partners' | 'commissions'>('partners');
  if (!me.features.cp_portal) return <div className="panel"><Empty title="The partner portal isn't in your plan">
    Brokers registering buyers with protection, and automatic commissions, come with the Pro plan. Your account owner can upgrade.</Empty></div>;
  const staff = ['owner', 'admin', 'sales_manager'].includes(me.user.role);
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Channel partners</h1><p>Brokers who bring you buyers, and what you owe them.</p></div></div>
      <div className="tabs">
        {staff && <button className={tab === 'partners' ? 'on' : ''} onClick={() => setTab('partners')}>Partners</button>}
        <button className={tab === 'commissions' || !staff ? 'on' : ''} onClick={() => setTab('commissions')}>Commissions</button>
      </div>
      {tab === 'partners' && staff ? <PartnerList /> : <Commissions />}
    </>
  );
}

function PartnerList() {
  const toast = useToast();
  const q = useLoad<any[]>(() => tenantApi.get('/channel-partners'));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  return (
    <>
      <div className="toolbar"><span className="muted small" style={{ flex: 1 }}>Partners sign in at <b>{location.origin}/partner</b> and register buyers there.</span>
        <button className="btn primary" onClick={() => setAdding(true)}>Add partner</button></div>
      <div className="table-wrap">{!q.data ? <Loading /> : !q.data.length ? <Empty title="No partners yet">Add a broker firm; they get an invitation to the partner portal.</Empty> : (
        <table><thead><tr><th>Firm</th><th>Commission</th><th>Protection</th><th>Buyers</th><th>Bookings</th><th>Owed</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.map(p => (
            <tr key={p.id}><td><b>{p.firm_name}</b><span className="sub">{p.contact_name}, {p.email}{p.rera_number ? `, RERA ${p.rera_number}` : ''}</span></td>
              <td className="num">{Number(p.commission_pct)}%</td><td className="num">{p.protection_days} days</td>
              <td className="num">{p.leads}</td><td className="num">{p.bookings}</td><td className="money">{Number(p.owed) ? inr(p.owed) : '—'}</td>
              <td><span className={`chip ${p.status === 'active' ? 'ok' : p.status === 'invited' ? 'act' : 'bad'}`}>{humanize(p.status)}</span></td>
              <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setEditing(p)}>Edit</button></td></tr>))}</tbody></table>)}
      </div>
      {adding && <AddPartner onClose={() => setAdding(false)} onDone={() => q.reload()} />}
      {editing && <EditPartner p={editing} onClose={() => setEditing(null)} onDone={m => { setEditing(null); toast(m); q.reload(); }} />}
    </>
  );
}

function AddPartner({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ firm_name: '', contact_name: '', email: '', phone: '', rera_number: '', commission_pct: '2', protection_days: '60' });
  const [link, setLink] = useState<{ url: string; emailed: boolean } | null>(null);
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post('/channel-partners', { ...f, phone: f.phone || undefined, rera_number: f.rera_number || undefined,
      commission_pct: Number(f.commission_pct), protection_days: Number(f.protection_days) }));
    if (r) { setLink({ url: r.invite_link, emailed: r.invite_emailed }); onDone(); }
  }
  if (link) return (
    <Modal title="Partner invited" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <p style={{ marginBottom: 10 }}>{link.emailed ? `We've emailed ${f.email} an invitation. The link is here too.` : `Send this link to ${f.contact_name}. It works once and expires in 7 days.`}</p>
      <div className="row"><input className="input" readOnly value={link.url} onFocus={e => e.target.select()} />
        <button className="btn" style={{ flex: 'none' }} onClick={() => { navigator.clipboard.writeText(link.url); toast('Link copied'); }}>Copy</button></div>
    </Modal>
  );
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add channel partner" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cp" disabled={busy || !f.firm_name || !f.contact_name || !f.email}>Invite partner</button></>}>
      <form id="cp" onSubmit={submit}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        <div className="row"><Field label="Firm name" error={error?.field('firm_name')}><input className="input" value={f.firm_name} onChange={set('firm_name')} autoFocus /></Field>
          <Field label="RERA agent number (optional)"><input className="input" value={f.rera_number} onChange={set('rera_number')} /></Field></div>
        <div className="row"><Field label="Contact person" error={error?.field('contact_name')}><input className="input" value={f.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="Email (their sign-in)" error={error?.field('email')}><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Phone (optional)"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field></div>
        <div className="row"><Field label="Commission (% of agreed price)"><input className="input" inputMode="decimal" value={f.commission_pct} onChange={set('commission_pct')} /></Field>
          <Field label="Buyer protection (days)" hint="How long a registered buyer stays theirs without a booking"><input className="input" inputMode="numeric" value={f.protection_days} onChange={set('protection_days')} /></Field></div>
      </form>
    </Modal>
  );
}

function EditPartner({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: (m: string) => void }) {
  const [pct, setPct] = useState(String(Number(p.commission_pct)));
  const [days, setDays] = useState(String(p.protection_days));
  const { busy, error, run } = useSubmit();
  const save = async (extra: object = {}, msg = 'Saved') => { if (await run(() => tenantApi.patch(`/channel-partners/${p.id}`, { commission_pct: Number(pct), protection_days: Number(days), ...extra }))) onDone(msg); };
  return (
    <Modal title={p.firm_name} onClose={onClose}
      footer={<>{p.status !== 'invited' && <button className={`btn ${p.status === 'active' ? 'danger' : ''}`} style={{ marginRight: 'auto' }} disabled={busy}
        onClick={() => save({ status: p.status === 'active' ? 'suspended' : 'active' }, p.status === 'active' ? 'Partner suspended. Their portal access is cut off now.' : 'Partner reactivated')}>
        {p.status === 'active' ? 'Suspend' : 'Reactivate'}</button>}
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => save()}>Save</button></>}>
      {error && <div className="alert bad">{error.message}</div>}
      <div className="row"><Field label="Commission (%)" hint="Applies to bookings from now on"><input className="input" inputMode="decimal" value={pct} onChange={e => setPct(e.target.value)} /></Field>
        <Field label="Protection (days)" hint="Applies to new registrations"><input className="input" inputMode="numeric" value={days} onChange={e => setDays(e.target.value)} /></Field></div>
    </Modal>
  );
}

function Commissions() {
  const { me } = useMe();
  const toast = useToast();
  const [status, setStatus] = useState('pending');
  const q = useLoad<any[]>(() => tenantApi.get(`/commissions?status=${status}`), [status]);
  const [paying, setPaying] = useState<any>(null);
  const [ref, setRef] = useState('');
  async function act(fn: () => Promise<any>, m: string) { try { await fn(); toast(m); setPaying(null); setRef(''); q.reload(); } catch (e: any) { toast(e.message, true); } }
  const canApprove = ['owner', 'admin', 'sales_manager'].includes(me.user.role), canPay = ['owner', 'admin', 'finance'].includes(me.user.role);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  return (
    <>
      <div className="tabs" style={{ borderBottom: 'none' }}>{['pending', 'approved', 'paid', 'cancelled'].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{humanize(s)}</button>)}</div>
      <div className="table-wrap">{!q.data ? <Loading /> : !q.data.length ? <Empty title={`No ${status} commissions`} /> : (
        <table><thead><tr><th>Partner</th><th>Buyer and unit</th><th>Agreed price</th><th>Commission</th><th>{status === 'paid' ? 'Paid' : 'Created'}</th><th /></tr></thead>
          <tbody>{q.data.map(c => (
            <tr key={c.id}><td><b>{c.firm_name}</b></td><td>{c.buyer}<span className="sub">{c.project}, {c.tower}-{c.unit_no}</span></td>
              <td className="money">{inr(c.base_amount)}</td><td><span className="money">₹{Number(c.amount).toLocaleString('en-IN')}</span><span className="sub">{Number(c.pct)}%</span></td>
              <td className="muted">{status === 'paid' ? <>{when(c.paid_at)}<span className="sub num">{c.paid_reference}</span></> : when(c.created_at)}</td>
              <td style={{ textAlign: 'right' }}>
                {c.status === 'pending' && canApprove && !me.support_session && <button className="btn sm primary" onClick={() => act(() => tenantApi.post(`/commissions/${c.id}/approve`), 'Approved for payment')}>Approve</button>}
                {c.status === 'approved' && canPay && !me.support_session && <button className="btn sm primary" onClick={() => setPaying(c)}>Mark paid</button>}
              </td></tr>))}</tbody></table>)}
      </div>
      {paying && <Modal title={`Pay ${paying.firm_name}`} onClose={() => setPaying(null)}
        footer={<><button className="btn" onClick={() => setPaying(null)}>Cancel</button><button className="btn primary" disabled={ref.trim().length < 3}
          onClick={() => act(() => tenantApi.post(`/commissions/${paying.id}/pay`, { reference: ref }), 'Marked as paid')}>Mark paid</button></>}>
        <p style={{ marginBottom: 10 }}>₹{Number(paying.amount).toLocaleString('en-IN')} for {paying.buyer}'s booking. Pay it from your bank first, then record the reference here.</p>
        <Field label="Payment reference" hint="NEFT UTR or cheque number"><input className="input" value={ref} onChange={e => setRef(e.target.value)} autoFocus /></Field>
      </Modal>}
    </>
  );
}
