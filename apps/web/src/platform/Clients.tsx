import { FormEvent, useState } from 'react';
import { platformApi, session, baseDomain } from '../lib/api';
import { Empty, ErrorState, Field, humanize, inr, Loading, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { platformRole } from './App';

const STATUS_CHIP: Record<string, string> = { active: 'ok', trial: 'act', past_due: 'bad', suspended: 'bad', churned: '' };

/** Per-client switches. They override the plan for this one client only. */
const FEATURE_SWITCHES: [key: string, label: string, hint: string][] = [
  ['telephony', 'Calling and call recording', 'Click-to-call through Exotel, Knowlarity, MyOperator or Twilio, with call logs and recordings. Off: Call opens the phone\'s dialer, nothing is recorded, and calling settings are hidden from the client.'],
  ['call_recording', 'Keep call recordings', 'Off: calls still go through their provider and are logged, but are placed without recording and no recording is stored.'],
  ['whatsapp', 'WhatsApp', 'Templates, replies and the inbox through their own WhatsApp Business number.'],
  ['field_tracking', 'Field check-ins', 'Selfie and GPS check-ins with the manager\'s live board.'],
  ['cp_portal', 'Partner portal', 'Brokers register buyers with protection; commission on bookings.'],
];

export function Clients() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useLoad<any[]>(() => platformApi.get(`/platform/tenants?${new URLSearchParams({ ...(q && { q }), ...(status && { status }) })}`), [q, status]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const role = platformRole();
  const canProvision = role === 'super_admin' || role === 'admin_sales';

  return (
    <>
      <div className="page-head"><div className="grow"><h1>Clients</h1><p>Every company using HXG Connect.</p></div>
        {canProvision && <button className="btn primary" onClick={() => setCreating(true)}>New client</button>}</div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Search company or workspace" value={q} onChange={e => setQ(e.target.value)} aria-label="Search clients" />
        <select className="input" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>{['trial', 'active', 'past_due', 'suspended', 'churned'].map(s => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
      </div>
      {list.error ? <ErrorState error={list.error} retry={list.reload} /> : (
        <div className="table-wrap">
          {!list.data ? <Loading /> : !list.data.length ? <Empty title={q || status ? 'No clients match' : 'No clients yet'}
            action={!q && !status && canProvision ? <button className="btn primary" onClick={() => setCreating(true)}>Provision your first client</button> : undefined} /> : (
            <table>
              <thead><tr><th>Company</th><th>Plan</th><th>Status</th><th>Users</th><th>Leads</th><th>MRR</th><th>Since</th></tr></thead>
              <tbody>
                {list.data.map(t => (
                  <tr key={t.id} className="click" onClick={() => setOpen(t.id)}>
                    <td><b>{t.name}</b><span className="sub">{t.subdomain}</span></td>
                    <td>{t.plan_name}</td>
                    <td><span className={`chip ${STATUS_CHIP[t.status]}`}>{humanize(t.status)}</span>
                      {t.status === 'trial' && t.trial_ends_at && <span className="sub">ends {when(t.trial_ends_at)}</span>}</td>
                    <td className="num">{t.users}<span className="faint"> / {t.limits.users?.toLocaleString('en-IN')}</span></td>
                    <td className="num">{t.leads.toLocaleString('en-IN')}</td>
                    <td className="money">{t.status === 'active' || t.status === 'past_due' ? inr(t.mrr) : '—'}</td>
                    <td className="muted">{new Date(t.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {creating && <Provision onClose={() => setCreating(false)} onDone={() => list.reload()} />}
      {open && <ClientDrawer id={open} onClose={() => setOpen(null)} onChanged={() => list.reload()} />}
    </>
  );
}

function Provision({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', subdomain: '', plan_code: 'growth', owner_name: '', owner_email: '', trial_days: '14' });
  const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useSubmit();
  const toast = useToast();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => platformApi.post('/platform/tenants', {
      name: f.name, subdomain: f.subdomain, plan_code: f.plan_code, trial_days: Number(f.trial_days),
      owner: { name: f.owner_name, email: f.owner_email },
    }));
    if (r) { setResult(r); onDone(); }
  }

  if (result) {
    const link = result.invite_link;
    return (
      <Modal title={`${result.tenant.name} is live`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p style={{ marginBottom: 6 }}>Workspace: <b>{result.workspace_url}</b></p>
        <p className="muted small" style={{ marginBottom: 12 }}>{result.invite_emailed ? `Invitation emailed to ${f.owner_email}. The link is here too, in case it lands in spam.` : `Send this one-time link to ${f.owner_name}. It expires in 72 hours. Set up email in Settings to send these automatically.`}</p>
        <div className="row"><input className="input" readOnly value={link} onFocus={e => e.target.select()} />
          <button className="btn" style={{ flex: 'none' }} onClick={() => { navigator.clipboard.writeText(link); toast('Link copied'); }}>Copy</button></div>
      </Modal>
    );
  }
  return (
    <Modal title="New client" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="prov" disabled={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</button></>}>
      <form id="prov" onSubmit={submit}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        <div className="row">
          <Field label="Company name" error={error?.field('name')}><input className="input" value={f.name} autoFocus
            onChange={e => setF({ ...f, name: e.target.value, subdomain: f.subdomain && f.subdomain !== slug(f.name) ? f.subdomain : slug(e.target.value) })} /></Field>
          <Field label="Workspace address" error={error?.field('subdomain')} hint={f.subdomain ? (baseDomain() ? `${f.subdomain}.${baseDomain()}` : `They sign in with the workspace name "${f.subdomain}"`) : 'Lowercase letters, digits, hyphens'}>
            <input className="input" value={f.subdomain} onChange={e => setF({ ...f, subdomain: slug(e.target.value) })} /></Field>
        </div>
        <div className="row">
          <Field label="Plan"><select className="input" value={f.plan_code} onChange={e => setF({ ...f, plan_code: e.target.value })}>
            <option value="starter">Starter</option><option value="growth">Growth</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></Field>
          <Field label="Trial length" hint="0 starts them as paying"><select className="input" value={f.trial_days} onChange={e => setF({ ...f, trial_days: e.target.value })}>
            {['0', '7', '14', '30'].map(d => <option key={d} value={d}>{d === '0' ? 'No trial' : `${d} days`}</option>)}</select></Field>
        </div>
        <div className="row">
          <Field label="Owner's name" error={error?.field('owner.name')}><input className="input" value={f.owner_name} onChange={e => setF({ ...f, owner_name: e.target.value })} /></Field>
          <Field label="Owner's email" error={error?.field('owner.email')}><input className="input" type="email" value={f.owner_email} onChange={e => setF({ ...f, owner_email: e.target.value })} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function ClientDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const t = useLoad<any>(() => platformApi.get(`/platform/tenants/${id}`), [id]);
  const [action, setAction] = useState<'suspend' | 'support' | null>(null);
  const [text, setText] = useState('');
  const role = platformRole();
  const can = (...r: string[]) => r.includes(role);

  async function act(fn: () => Promise<any>, msg: string) {
    try { await fn(); toast(msg); setAction(null); setText(''); t.reload(); onChanged(); }
    catch (e: any) { toast(e.message, true); }
  }
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label="Client details">
        {!t.data ? (t.error ? <ErrorState error={t.error} /> : <Loading />) : (() => {
          const c = t.data;
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start' }}><div style={{ flex: 1 }}><h2>{c.name}</h2><p className="muted small">{baseDomain() ? `${c.subdomain}.${baseDomain()}` : `Workspace name: ${c.subdomain}`}</p></div>
                <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>
              <dl className="kv">
                <dt>Status</dt><dd><span className={`chip ${STATUS_CHIP[c.status]}`}>{humanize(c.status)}</span></dd>
                <dt>Plan</dt><dd>{c.plan_name}</dd>
                {c.trial_ends_at && <><dt>Trial ends</dt><dd>{new Date(c.trial_ends_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}</dd></>}
                <dt>Users</dt><dd className="num">{c.users} of {c.limits.users?.toLocaleString('en-IN')}</dd>
                <dt>Leads</dt><dd className="num">{c.leads.toLocaleString('en-IN')}</dd>
                <dt>Owner</dt><dd>{c.owner_email}</dd>
                <dt>Client since</dt><dd>{new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</dd>
              </dl>

              <h3 style={{ marginBottom: 8 }}>Change plan</h3>
              <div className="row" style={{ marginBottom: 20 }}>
                <select className="input" defaultValue={c.plan_code} disabled={!can('super_admin', 'admin_sales', 'admin_billing')}
                  onChange={e => act(() => platformApi.patch(`/platform/tenants/${id}/plan`, { plan_code: e.target.value }), `Moved to ${humanize(e.target.value)}`)}>
                  {['starter', 'growth', 'pro', 'enterprise'].map(p => <option key={p} value={p}>{humanize(p)}</option>)}</select>
              </div>

              <h3 style={{ marginBottom: 4 }}>Features for this client</h3>
              <p className="small muted" style={{ marginBottom: 8 }}>Switch a module off for this client without changing their plan, for example calling when they don't pay for Exotel or Knowlarity. Their saved keys are kept, so switching back on just works.</p>
              <div className="panel" style={{ marginBottom: 20 }}>
                {FEATURE_SWITCHES.map(([k, label, hint]) => {
                  const on = k === 'call_recording' ? !!c.features?.telephony && c.features?.call_recording !== false : !!c.features?.[k];
                  const blocked = !can('super_admin', 'admin_sales') || (k === 'call_recording' && !c.features?.telephony);
                  const plan = k === 'call_recording' ? c.plan_features?.telephony : c.plan_features?.[k];
                  return (
                    <label key={k} className="list-item" style={{ cursor: blocked ? 'default' : 'pointer', alignItems: 'flex-start' }}>
                      <input type="checkbox" style={{ marginTop: 4 }} checked={on} disabled={blocked}
                        onChange={() => act(() => platformApi.patch(`/platform/tenants/${id}/overrides`, { features: { [k]: !on } }), `${label} turned ${on ? 'off' : 'on'} for ${c.name}`)} />
                      <div className="grow"><b>{label}</b><div className="small muted">{hint}{plan ? '' : ' Not in their plan: switching on gives it to them anyway.'}</div></div>
                    </label>
                  );
                })}
              </div>

              <h3 style={{ marginBottom: 8 }}>Actions</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {c.status === 'trial' && can('super_admin', 'admin_sales') &&
                  <button className="btn" onClick={() => act(() => platformApi.post(`/platform/tenants/${id}/extend-trial`, { days: 7 }), 'Trial extended by 7 days')}>Extend trial 7 days</button>}
                {c.status !== 'suspended' && can('super_admin', 'admin_billing') && <button className="btn danger" onClick={() => setAction('suspend')}>Suspend</button>}
                {c.status === 'suspended' && can('super_admin', 'admin_billing') &&
                  <button className="btn primary" onClick={() => act(() => platformApi.post(`/platform/tenants/${id}/restore`), 'Workspace restored')}>Restore</button>}
                {can('super_admin', 'admin_support') && <button className="btn" onClick={() => setAction('support')}>Request support access</button>}
              </div>

              {action && (
                <div className="next-box" style={{ marginTop: 16 }}>
                  <Field label={action === 'suspend' ? 'Reason for suspending (the team is locked out immediately; data is kept)' : 'Reason the client will see'}>
                    <textarea className="input" value={text} onChange={e => setText(e.target.value)}
                      placeholder={action === 'suspend' ? 'Invoice EF-2026-118 unpaid for 60 days' : 'Investigating the export issue you reported on Tuesday'} /></Field>
                  <div className="row"><button className="btn" onClick={() => setAction(null)}>Cancel</button>
                    {action === 'suspend'
                      ? <button className="btn danger" disabled={text.trim().length < 5} onClick={() => act(() => platformApi.post(`/platform/tenants/${id}/suspend`, { reason: text }), `${c.name} suspended`)}>Suspend now</button>
                      : <button className="btn primary" disabled={text.trim().length < 10} onClick={() => act(() => platformApi.post('/platform/impersonation', { tenant_id: id, reason: text }), 'Request sent. The client approves it in their settings.')}>Send request</button>}
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </aside>
    </>
  );
}

export function SupportSessions() {
  const toast = useToast();
  const s = useLoad<any[]>(() => platformApi.get('/platform/impersonation'));
  async function openWorkspace(row: any) {
    try {
      const r = await platformApi.post(`/platform/impersonation/${row.id}/token`);
      const ws = (await platformApi.get(`/platform/tenants/${row.tenant_id}`)).subdomain;
      window.open(`${session.workspaceUrl(ws)}/#imp=${encodeURIComponent(r.token)}&ws=${ws}`, '_blank', 'noopener');
    } catch (e: any) { toast(e.message, true); }
  }
  if (s.error) return <ErrorState error={s.error} retry={s.reload} />;
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Support sessions</h1>
        <p>You can open a client's workspace only after they approve. Sessions last 60 minutes and are read-only unless a super admin asked for more.</p></div>
        <button className="btn" onClick={s.reload}>Refresh</button></div>
      <div className="table-wrap">
        {!s.data ? <Loading /> : !s.data.length ? <Empty title="No requests yet">Request access from a client's page under Clients.</Empty> : (
          <table><thead><tr><th>Client</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>{s.data.map(r => {
              const live = r.status === 'approved' && new Date(r.expires_at) > new Date();
              return (
                <tr key={r.id}>
                  <td><b>{r.tenant}</b><span className="sub">{when(r.created_at)}</span></td>
                  <td style={{ maxWidth: 360 }}>{r.reason}</td>
                  <td><span className={`chip ${live ? 'warn' : r.status === 'pending' ? 'act' : ''}`}>{live ? `Approved until ${new Date(r.expires_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : humanize(r.status === 'approved' ? 'expired' : r.status)}</span></td>
                  <td style={{ textAlign: 'right' }}>{live && <button className="btn sm primary" onClick={() => openWorkspace(r)}>Open workspace</button>}</td>
                </tr>);
            })}</tbody></table>
        )}
      </div>
    </>
  );
}
