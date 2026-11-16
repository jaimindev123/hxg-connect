import { FormEvent, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, onSignedOut, platformApi, session } from '../lib/api';
import { Empty, ErrorState, Field, humanize, initials, inr, Loading, Logo, Modal, useLoad, useSubmit, useTheme, useToast, when } from '../lib/ui';
import { FloorPlan } from '../crm/App';
import { Clients, SupportSessions } from './Clients';
import { Integrations } from '../lib/Integrations';
import { PlatformBilling } from '../lib/Billing';
import { ChangePassword } from '../lib/Password';
import { TwoStep } from './TwoStep';

export default function PlatformApp() {
  const nav = useNavigate();
  useEffect(() => onSignedOut(r => { if (r === 'platform') nav('/platform/login', { replace: true }); }), [nav]);
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route path="platform/login" element={<Login />} />
      <Route path="*" element={session.token('platform') ? <Shell /> : <Navigate to="/platform/login" replace />} />
    </Routes>
  );
}

function claims(): { name: string; role: string } {
  try { return JSON.parse(atob(session.token('platform')!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return { name: '', role: '' }; }
}
export const platformRole = () => claims().role;

function Shell() {
  const nav = useNavigate();
  const { theme, toggle } = useTheme();
  const me = claims();
  const [pw, setPw] = useState(false);
  return (
    <div className="frame">
      <aside className="rail">
        <div className="brand"><img className="brand-mark-img" src="/hxg-mark.png" alt="" /><div>HXG Connect<small>Platform console</small></div></div>
        <nav className="nav" aria-label="Platform">
          <NavLink to="/platform" end><span className="ico">◧</span><span className="lbl">Overview</span></NavLink>
          <NavLink to="/platform/clients"><span className="ico">▤</span><span className="lbl">Clients</span></NavLink>
          <NavLink to="/platform/support"><span className="ico">⚿</span><span className="lbl">Support sessions</span></NavLink>
          <NavLink to="/platform/billing"><span className="ico">₹</span><span className="lbl">Billing</span></NavLink>
          <NavLink to="/platform/plans"><span className="ico">◇</span><span className="lbl">Plans</span></NavLink>
          {me.role === 'super_admin' && <NavLink to="/platform/staff"><span className="ico">◎</span><span className="lbl">Staff</span></NavLink>}
          <div className="nav-sep" />
          <NavLink to="/platform/settings"><span className="ico">⚙</span><span className="lbl">Settings</span></NavLink>
        </nav>
        <div className="rail-foot">
          <div className="avatar">{initials(me.name ?? '')}</div>
          <div className="who"><b>{me.name}</b><span className="small muted">{humanize(me.role ?? '')}</span></div>
          <div className="acts">
            <button className="btn ghost sm" onClick={toggle} aria-label="Toggle theme">{theme === 'dark' ? '☀' : '☾'}</button>
            <button className="btn ghost sm" onClick={() => setPw(true)}>Password</button>
            <button className="btn ghost sm" onClick={() => { session.clear('platform'); nav('/platform/login'); }}>Sign out</button>
          </div>
        </div>
        {pw && <ChangePassword realm="platform" onClose={() => setPw(false)} />}
      </aside>
      <div className="main"><div className="page">
        <Routes>
          <Route index element={<Overview />} />
          <Route path="clients" element={<Clients />} />
          <Route path="support" element={<SupportSessions />} />
          <Route path="plans" element={<Plans canEdit={me.role === 'super_admin'} />} />
          <Route path="staff" element={<Staff />} />
          <Route path="settings" element={<Settings />} />
          <Route path="billing" element={<PlatformBilling canEdit={['super_admin', 'admin_billing'].includes(me.role)} />} />
          <Route path="*" element={<Empty title="Page not found" />} />
        </Routes>
      </div></div>
    </div>
  );
}

function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step2, setStep2] = useState(false);
  const { busy, error, run, setError } = useSubmit();
  useEffect(() => { if (error?.code === 'two_factor_required') { setStep2(true); setError(null); } }, [error, setError]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => platformApi.post<{ token: string }>('/platform/auth/login', { email, password, ...(step2 && { code: code.trim() }) }));
    if (r) { session.set('platform', r.token); nav('/platform', { replace: true }); }
  }
  return (
    <div className="auth">
      <div className="auth-art"><FloorPlan /><div style={{ position: 'relative' }}><Logo height={52} /></div>
        <div><h1>Platform console</h1><p style={{ marginTop: 12 }}>For HXG Connect staff only. Client teams sign in on their own workspace address.</p></div></div>
      <div className="auth-form">
        <form onSubmit={submit}>
          <h2>Staff sign in</h2><p className="lede">Every action here is recorded.</p>
          {error && <div className="alert bad">{error.message}</div>}
          <Field label="Email"><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></Field>
          <Field label="Password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          {step2 && <Field label="Authenticator code" hint="The 6-digit code from your authenticator app, or one of your backup codes">
            <input className="input num" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} autoFocus /></Field>}
          <button className="btn primary block" disabled={busy || !email || !password || (step2 && !code.trim())}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="small faint" style={{ marginTop: 18, textAlign: 'center' }}><a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a> · <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a></p>
        </form>
      </div>
    </div>
  );
}

function Overview() {
  const o = useLoad<any>(() => platformApi.get('/platform/overview'));
  if (o.error) return <ErrorState error={o.error} retry={o.reload} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Overview</h1><p>Across every client workspace.</p></div></div>
      <div className="figures">
        <div className="figure money"><div className="v">{inr(d.mrr)}</div><div className="l">Monthly recurring revenue</div></div>
        <div className="figure"><div className="v">{d.active}</div><div className="l">Paying clients</div></div>
        <div className="figure"><div className="v">{d.trials}</div><div className="l">On trial{d.trials_ending > 0 ? `, ${d.trials_ending} end${d.trials_ending === 1 ? 's' : ''} this week` : ''}</div></div>
        <div className={`figure ${d.past_due ? 'alert' : ''}`}><div className="v">{d.past_due}</div><div className="l">Past due</div></div>
        <div className="figure"><div className="v">{d.seats.toLocaleString('en-IN')}</div><div className="l">Seats in use</div></div>
        <div className="figure"><div className="v">{Number(d.leads).toLocaleString('en-IN')}</div><div className="l">Leads managed</div></div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Recent activity</h2></div>
        <div className="table-wrap">
          {!d.recent.length ? <Empty title="Nothing yet">Provision your first client to get started.</Empty> : (
            <table><tbody>{d.recent.map((r: any, i: number) => (
              <tr key={i}><td className="muted" style={{ width: 150 }}>{when(r.at)}</td><td><b>{r.actor ?? 'System'}</b> {humanize(r.action.split('.').pop()!).toLowerCase()} {r.tenant && <span>for {r.tenant}</span>}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </div>
    </>
  );
}

const PLAN_FEATURES: Record<string, string> = { telephony: 'Calling and call recording', whatsapp: 'WhatsApp', field_tracking: 'Field check-ins', cp_portal: 'Partner portal' };

function Plans({ canEdit }: { canEdit: boolean }) {
  const p = useLoad<any[]>(() => platformApi.get('/platform/plans'));
  const [editing, setEditing] = useState<any>(null);
  if (p.error) return <ErrorState error={p.error} retry={p.reload} />;
  if (!p.data) return <Loading />;
  const features = Array.from(new Set([...Object.keys(PLAN_FEATURES), ...p.data.flatMap(x => Object.keys(x.features))]));
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Plans</h1><p>What each tier costs and includes. New prices apply from the next invoice. Contract exceptions are set per client.</p></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th /> {p.data.map(x => <th key={x.code}>{x.name}{!x.is_public && <span className="faint"> (private)</span>}</th>)}</tr></thead>
          <tbody>
            <tr><td className="muted">Price per user / month</td>{p.data.map(x => <td key={x.code} className="money">{Number(x.price_per_user) ? inr(Number(x.price_per_user)) : 'Custom'}</td>)}</tr>
            <tr><td className="muted">Users</td>{p.data.map(x => <td key={x.code} className="num">{x.limits.users?.toLocaleString('en-IN') ?? 'No limit'}</td>)}</tr>
            <tr><td className="muted">Leads</td>{p.data.map(x => <td key={x.code} className="num">{x.limits.leads?.toLocaleString('en-IN') ?? 'No limit'}</td>)}</tr>
            {features.map(f => <tr key={f}><td className="muted">{PLAN_FEATURES[f] ?? humanize(f)}</td>{p.data!.map(x => <td key={x.code}>{x.features[f] ? 'Included' : <span className="faint">—</span>}</td>)}</tr>)}
            {canEdit && <tr><td />{p.data.map(x => <td key={x.code}><button className="btn sm" onClick={() => setEditing(x)}>Edit</button></td>)}</tr>}
          </tbody>
        </table>
      </div>
      {editing && <PlanEditor plan={editing} features={features} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); p.reload(); }} />}
    </>
  );
}

function PlanEditor({ plan, features, onClose, onSaved }: { plan: any; features: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: plan.name as string, price: String(Number(plan.price_per_user)), users: String(plan.limits.users ?? ''), leads: String(plan.limits.leads ?? ''),
    features: { ...plan.features } as Record<string, boolean>, is_public: !!plan.is_public });
  const { busy, error, run } = useSubmit();
  const whole = (v: string) => /^\d+$/.test(v.trim());
  const valid = f.name.trim().length >= 2 && /^\d+(\.\d{1,2})?$/.test(f.price.trim()) && whole(f.users) && Number(f.users) > 0 && whole(f.leads) && Number(f.leads) > 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name: f.name.trim(), price_per_user: Number(f.price), limits: { ...plan.limits, users: Number(f.users), leads: Number(f.leads) },
      features: Object.fromEntries(features.map(k => [k, !!f.features[k]])), is_public: f.is_public };
    if (await run(() => api('platform', 'PUT', `/platform/plans/${plan.code}`, body))) { toast(`${f.name} plan saved`); onSaved(); }
  }
  return (
    <Modal title={`Edit the ${plan.name} plan`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="plan" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save plan'}</button></>}>
      <form id="plan" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <div className="row">
          <Field label="Plan name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Price per user, per month (₹)" hint="Before GST. 0 means a custom price agreed per client.">
            <input className="input" inputMode="decimal" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></Field>
        </div>
        <div className="row">
          <Field label="Users allowed"><input className="input" inputMode="numeric" value={f.users} onChange={e => setF({ ...f, users: e.target.value })} /></Field>
          <Field label="Leads allowed"><input className="input" inputMode="numeric" value={f.leads} onChange={e => setF({ ...f, leads: e.target.value })} /></Field>
        </div>
        <div className="panel" style={{ marginBottom: 12 }}>
          {features.map(k => (
            <label key={k} className="list-item" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={!!f.features[k]} onChange={() => setF({ ...f, features: { ...f.features, [k]: !f.features[k] } })} />
              <div className="grow">{PLAN_FEATURES[k] ?? humanize(k)}</div>
            </label>))}
        </div>
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={f.is_public} onChange={() => setF({ ...f, is_public: !f.is_public })} /> Offered to everyone (untick for a private plan you assign by hand)</label>
        <p className="small muted" style={{ marginTop: 10 }}>Clients already on this plan get the new limits and features straight away, and the new price on their next invoice.</p>
      </form>
    </Modal>
  );
}

function Staff() {
  const toast = useToast();
  const s = useLoad<any[]>(() => platformApi.get('/platform/users'));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', role: 'admin_support', password: '' });
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => platformApi.post('/platform/users', f))) { toast(`${f.name} added`); setAdding(false); s.reload(); }
  }
  if (s.error) return <ErrorState error={s.error} retry={s.reload} />;
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Staff</h1><p>Your team's access to this console.</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}>Add staff</button></div>
      <div className="table-wrap">
        {!s.data ? <Loading /> : (
          <table><thead><tr><th>Name</th><th>Role</th><th>Two-step sign-in</th><th>Since</th></tr></thead>
            <tbody>{s.data.map(u => <tr key={u.id}><td><b>{u.name}</b><span className="sub">{u.email}</span></td><td>{humanize(u.role.replace('admin_', ''))}</td>
              <td>{u.two_factor ? <><span className="chip ok">On</span> <button className="btn ghost sm" title="If they lost their phone" onClick={async () => {
                if (!confirm(`Reset two-step sign-in for ${u.name}? Their password alone will work until they set it up again.`)) return;
                try { await platformApi.post(`/platform/users/${u.id}/reset-two-factor`); toast(`Reset for ${u.name}`); s.reload(); } catch (e: any) { toast(e.message, true); } }}>Reset</button></> : <span className="chip bad">Off</span>}</td>
              <td className="muted">{new Date(u.created_at).toLocaleDateString('en-IN')}</td></tr>)}</tbody></table>
        )}
      </div>
      {adding && (
        <Modal title="Add staff" onClose={() => setAdding(false)}
          footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" form="staff" disabled={busy}>Add staff</button></>}>
          <form id="staff" onSubmit={submit}>
            {error && <div className="alert bad">{error.field('password') ?? error.message}</div>}
            <Field label="Name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Role" hint="Support can view client workspaces only with the client's approval">
              <select className="input" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
                <option value="admin_support">Support</option><option value="admin_sales">Sales and onboarding</option>
                <option value="admin_billing">Billing</option><option value="super_admin">Super admin</option></select></Field>
            <Field label="Temporary password" hint="12 characters or more. Ask them to change it."><input className="input" type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
          </form>
        </Modal>
      )}
    </>
  );
}

function Settings() {
  const role = platformRole();
  const toast = useToast();
  const st = useLoad<any>(() => platformApi.get('/platform/settings'));
  const [domain, setDomain] = useState('');
  const { busy, error, run } = useSubmit();
  if (st.error) return <ErrorState error={st.error} retry={st.reload} />;
  if (!st.data) return <Loading />;
  const d = st.data.base_domain as string | null;
  const isSuper = role === 'super_admin';

  async function save(value: string | null) {
    const r = await run(() => api('platform', 'PUT', '/platform/settings/domain', { base_domain: value }));
    if (r) { toast(value ? `Domain set to ${value}` : 'Domain removed'); setDomain(''); st.reload(); }
  }

  return (
    <>
      <div className="page-head"><div className="grow"><h1>Settings</h1><p>Your domain, and the accounts HXG Connect itself uses.</p></div></div>
      <div className="section">
        <div className="section-head"><h2>Two-step sign-in</h2></div>
        <TwoStep />
      </div>
      <div className="section">
        <div className="section-head"><h2>Domain</h2></div>
        <div className="panel panel-pad">
          {d ? (
            <>
              <p>Client workspaces live at <b>workspace.{d}</b>, and this console at <b>admin.{d}</b>.</p>
              <p className="small muted" style={{ margin: '6px 0 12px' }}>{st.data.server_origin} still works too, with the workspace typed at sign-in.</p>
              {isSuper && <button className="btn danger" disabled={busy} onClick={() => save(null)}>Remove domain</button>}
            </>
          ) : (
            <>
              <p><b>No domain yet.</b> Everything works at <b>{st.data.server_origin}</b>: clients type their workspace name when they sign in, and this console is at /platform.</p>
              {isSuper && (
                <>
                  <h3 style={{ margin: '16px 0 6px' }}>When you buy a domain</h3>
                  <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.8, marginBottom: 12 }}>
                    <li>At your DNS provider, point the domain, <b>admin.</b> and the wildcard <b>*.</b> record at this server's IP address.</li>
                    <li>Get an HTTPS certificate that covers <b>*.hxgconnect.com</b>. A wildcard needs a DNS challenge: Cloudflare's proxy or Caddy with a DNS plugin does this for you.</li>
                    <li>Enter the domain below. Subdomains switch on within a minute, with no redeploy.</li>
                  </ol>
                  {error && <div className="alert bad">{error.field('base_domain') ?? error.message}</div>}
                  <div className="row" style={{ maxWidth: 520 }}>
                    <input className="input" placeholder="yourcompany.com" value={domain} onChange={e => setDomain(e.target.value.trim().toLowerCase())} spellCheck={false} />
                    <button className="btn primary" style={{ flex: 'none' }} disabled={busy || !domain} onClick={() => save(domain)}>Use this domain</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Integrations</h2></div>
        <p className="muted small" style={{ marginBottom: 12 }}>HXG Connect's own accounts: the Razorpay account that bills your clients, and the email server that sends invitations. Each client connects their own calling, WhatsApp and payment accounts from their workspace settings.</p>
        <Integrations realm="platform" readOnly={role !== 'super_admin' && role !== 'admin_billing'} />
      </div>
    </>
  );
}
