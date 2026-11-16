import { FormEvent, useEffect, useState } from 'react';
import { api, platformApi, Realm, session, tenantApi } from './api';
import { Empty, ErrorState, Field, humanize, Loading, Modal, useLoad, useSubmit, useToast } from './ui';

export const GST_STATES: [string, string][] = [['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'],
  ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'],
  ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'],
  ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'], ['38', 'Ladakh']];
const rupees = (n: unknown) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const date = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Invoices are HTML pages behind auth: fetch, then open as a printable tab. */
async function openInvoice(realm: Realm, path: string) {
  const ws = session.workspace();
  const r = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${session.token(realm)}`, ...(realm !== 'platform' && ws && { 'x-tenant': ws }) } });
  if (!r.ok) throw new Error('Invoice unavailable');
  window.open(URL.createObjectURL(new Blob([await r.text()], { type: 'text/html' })), '_blank', 'noopener');
}

function InvoiceTable({ rows, onPay }: { rows: any[]; onPay?: (inv: any) => void }) {
  const toast = useToast();
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Period</th><th>Users</th><th>Total</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map(i => (
        <tr key={i.id} className={i.overdue ? 'urgent' : ''}>
          <td className="num"><b>{i.number}</b><span className="sub">Issued {date(i.issued_on)}</span></td>
          <td>{new Date(i.period_start).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</td>
          <td className="num">{i.seats}</td><td className="money">{rupees(i.total)}</td>
          <td><span className={`chip ${i.status === 'paid' ? 'ok' : i.overdue ? 'bad' : 'warn'}`}>{i.status === 'paid' ? 'Paid' : i.overdue ? 'Overdue' : `Due ${date(i.due_date)}`}</span></td>
          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
            <button className="btn sm" onClick={() => openInvoice('tenant', `/billing/invoices/${i.id}/html`).catch(e => toast(e.message, true))}>View</button>{' '}
            {i.status === 'due' && onPay && <button className="btn sm primary" onClick={() => onPay(i)}>Pay now</button>}</td>
        </tr>))}</tbody></table></div>
  );
}

function usePay() {
  const toast = useToast();
  return async (inv: any) => {
    try { const r = await tenantApi.post(`/billing/invoices/${inv.id}/pay`); window.open(r.url, '_blank', 'noopener'); toast('Razorpay opened in a new tab. Access is restored as soon as payment goes through.'); }
    catch (e: any) { toast(e.message, true); }
  };
}

/** Client owner: GST details and invoices, inside Settings. */
export function TenantBilling() {
  const toast = useToast();
  const profile = useLoad<any>(() => tenantApi.get('/billing/profile'));
  const invoices = useLoad<any[]>(() => tenantApi.get('/billing/invoices'));
  const [f, setF] = useState({ legal_name: '', gstin: '', state_code: '', email: '', address: '' });
  const { busy, error, run } = useSubmit();
  const pay = usePay();
  useEffect(() => { if (profile.data) setF({ ...profile.data, gstin: profile.data.gstin ?? '', address: profile.data.address ?? '' }); }, [profile.data]);
  async function save(e: FormEvent) { e.preventDefault(); if (await run(() => api('tenant', 'PUT', '/billing/profile', f))) { toast('Billing details saved. They apply from your next invoice.'); profile.reload(); } }
  if (invoices.error) return <ErrorState error={invoices.error} retry={invoices.reload} />;
  return (
    <>
      <div className="section-head"><h3>Invoices</h3></div>
      {!invoices.data ? <Loading /> : !invoices.data.length ? <div className="panel"><Empty title="No invoices yet">Your first invoice is issued on the 1st after your trial.</Empty></div>
        : <InvoiceTable rows={invoices.data} onPay={pay} />}
      <div className="section-head" style={{ marginTop: 18 }}><h3>GST details for invoices</h3></div>
      <form className="panel panel-pad" onSubmit={save}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        <div className="row">
          <Field label="Legal name" error={error?.field('legal_name')}><input className="input" value={f.legal_name} onChange={e => setF({ ...f, legal_name: e.target.value })} /></Field>
          <Field label="GSTIN (optional)" error={error?.field('gstin')} hint="Add it to claim input tax credit"><input className="input num" value={f.gstin} onChange={e => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field>
        </div>
        <div className="row">
          <Field label="State" error={error?.field('state_code')}><select className="input" value={f.state_code} onChange={e => setF({ ...f, state_code: e.target.value })}>
            <option value="">Choose…</option>{GST_STATES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
          <Field label="Invoices go to" error={error?.field('email')}><input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <Field label="Billing address"><input className="input" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></Field>
        <button className="btn primary" disabled={busy || !f.legal_name || !f.state_code || !f.email}>Save billing details</button>
      </form>
    </>
  );
}

/** Shown instead of the app when the workspace is suspended. */
export function SuspendedScreen({ onSignOut }: { onSignOut: () => void }) {
  const invoices = useLoad<any[]>(() => tenantApi.get('/billing/invoices'));
  const pay = usePay();
  const due = invoices.data?.filter(i => i.status === 'due') ?? [];
  return (
    <div className="page" style={{ maxWidth: 820, margin: '40px auto' }}>
      <h1>This workspace is paused</h1>
      {invoices.error ? <p className="muted" style={{ margin: '8px 0 20px' }}>Your data is safe. Only your account owner can restore access, usually by paying an overdue invoice.</p> : <>
        <p className="muted" style={{ margin: '8px 0 20px' }}>Your data is safe and nothing has been deleted. Pay the overdue invoice{due.length === 1 ? '' : 's'} below and everyone gets back in automatically.</p>
        {!invoices.data ? <Loading /> : due.length ? <InvoiceTable rows={due} onPay={pay} /> : <div className="alert info">Nothing is outstanding. If you're still locked out, contact HXG Connect support.</div>}</>}
      <button className="btn" style={{ marginTop: 20 }} onClick={onSignOut}>Sign out</button>
    </div>
  );
}

// =====================================================================
export function PlatformBilling({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState('due');
  const list = useLoad<any[]>(() => platformApi.get(`/platform/billing/invoices?status=${status}`), [status]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paying, setPaying] = useState<any>(null);
  const [ref, setRef] = useState('');
  async function act(fn: () => Promise<any>, msg: (r: any) => string) { try { const r = await fn(); toast(msg(r)); list.reload(); } catch (e: any) { toast(e.message, true); } }
  const gst = useLoad<any>(() => platformApi.get('/platform/billing/settings'), [settingsOpen]);
  return (
    <>
      {gst.data && !gst.data.ready && (
        <div className="alert bad" role="alert"><b>No invoices will go out yet.</b> Your business name, address and GST details aren't filled in.
          {canEdit && <> <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setSettingsOpen(true)}>Add them now</button></>}</div>)}
      <div className="page-head"><div className="grow"><h1>Billing</h1><p>Invoices go out on the 1st for every paying client. Overdue clients move to past due, then suspended after the grace period.</p></div>
        {canEdit && <><button className="btn" onClick={() => setSettingsOpen(true)}>GST settings</button>
          <button className="btn" onClick={() => act(() => platformApi.post('/platform/billing/run-dunning'), r => `Dunning: ${r.past_due} past due, ${r.suspended} suspended, ${r.cleared} cleared`)}>Run dunning</button>
          <button className="btn primary" onClick={() => act(() => platformApi.post('/platform/billing/run-invoices', {}), r => `${r.created} invoice${r.created === 1 ? '' : 's'} issued for ${r.month}`)}>Issue this month's invoices</button></>}
      </div>
      <div className="tabs">{['due', 'paid', 'void'].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s === 'due' ? 'Unpaid' : humanize(s)}</button>)}</div>
      {list.error ? <ErrorState error={list.error} retry={list.reload} /> : (
        <div className="table-wrap">{!list.data ? <Loading /> : !list.data.length ? <Empty title={`No ${status === 'due' ? 'unpaid' : status} invoices`} /> : (
          <table><thead><tr><th>Invoice</th><th>Client</th><th>Total</th><th>{status === 'paid' ? 'Paid' : 'Due'}</th><th /></tr></thead>
            <tbody>{list.data.map(i => (
              <tr key={i.id} className={i.overdue ? 'urgent' : ''}>
                <td className="num"><b>{i.number}</b><span className="sub">{i.seats} users, issued {date(i.issued_on)}</span></td>
                <td>{i.tenant}<span className="sub">{humanize(i.tenant_status)}</span></td>
                <td className="money">{rupees(i.total)}</td>
                <td className={i.overdue ? 'overdue-text' : ''}>{status === 'paid' ? <>{date(i.paid_at)}<span className="sub num">{i.paid_reference}</span></> : date(i.due_date)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => openInvoice('platform', `/platform/billing/invoices/${i.id}/html`).catch(e => toast(e.message, true))}>View</button>{' '}
                  {i.status === 'due' && canEdit && <button className="btn sm primary" onClick={() => setPaying(i)}>Mark paid</button>}</td>
              </tr>))}</tbody></table>)}
        </div>)}
      {paying && <Modal title={`Record payment for ${paying.number}`} onClose={() => setPaying(null)}
        footer={<><button className="btn" onClick={() => setPaying(null)}>Cancel</button><button className="btn primary" disabled={ref.trim().length < 3}
          onClick={() => act(() => platformApi.post(`/platform/billing/invoices/${paying.id}/mark-paid`, { reference: ref }), () => 'Marked paid. A suspension for non-payment is lifted automatically.').then(() => { setPaying(null); setRef(''); })}>Mark paid</button></>}>
        <p style={{ marginBottom: 10 }}>{paying.tenant}, {rupees(paying.total)}. Check the money has arrived in your bank first.</p>
        <Field label="Bank reference" hint="NEFT/RTGS UTR or cheque number"><input className="input" value={ref} onChange={e => setRef(e.target.value)} autoFocus /></Field>
      </Modal>}
      {settingsOpen && <BillingSettings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

function BillingSettings({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const s = useLoad<any>(() => platformApi.get('/platform/billing/settings'));
  const [f, setF] = useState<any>(null);
  const { busy, error, run } = useSubmit();
  useEffect(() => { if (s.data && !f) setF({ ...s.data, gstin: s.data.gstin ?? '' }); }, [s.data, f]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api('platform', 'PUT', '/platform/billing/settings', { ...f, gstin: f.gstin || null, due_days: Number(f.due_days), grace_days: Number(f.grace_days) }))) { toast('Billing settings saved'); onClose(); }
  }
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="GST and invoice settings" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="bs" disabled={busy || !f}>Save</button></>}>
      {!f ? <Loading /> : <form id="bs" onSubmit={save}>
        {error && <div className="alert bad">{error.issues[0]?.message ?? error.message}</div>}
        <div className="row"><Field label="Your legal name"><input className="input" value={f.legal_name} onChange={set('legal_name')} /></Field>
          <Field label="Your GSTIN" hint="Leave blank if not GST-registered: invoices then carry no tax"><input className="input num" value={f.gstin} onChange={e => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field></div>
        <div className="row"><Field label="Your state"><select className="input" value={f.state_code} onChange={set('state_code')}>{GST_STATES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
          <Field label="SAC code" hint="997331 is common for SaaS; confirm with your CA"><input className="input num" value={f.sac} onChange={set('sac')} /></Field>
          <Field label="Invoice prefix"><input className="input num" value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field></div>
        <Field label="Registered address"><input className="input" value={f.address} onChange={set('address')} /></Field>
        <Field label="Bank details printed on unpaid invoices"><input className="input" value={f.bank_details} onChange={set('bank_details')} placeholder="HDFC Bank, A/c 5020…, IFSC HDFC0000123" /></Field>
        <div className="row"><Field label="Payment due after (days)"><input className="input" inputMode="numeric" value={f.due_days} onChange={set('due_days')} /></Field>
          <Field label="Suspend after overdue (days)"><input className="input" inputMode="numeric" value={f.grace_days} onChange={set('grace_days')} /></Field></div>
      </form>}
    </Modal>
  );
}
