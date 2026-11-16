import { createContext, FormEvent, Fragment, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { absorbHandoff, onSignedOut, session, tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, initials, Loading, Logo, useLoad, useSubmit, useTheme, useToast, when } from '../lib/ui';
import Dashboard from './Dashboard';
import { LeadDetail, LeadsList } from './Leads';
import Pipeline from './Pipeline';
import MyDay from './MyDay';
import Team from './Team';
import Field_ from './Field';
import { Integrations } from '../lib/Integrations';
import { InventoryList, ProjectView } from './Inventory';
import { BookingDetail, BookingsList } from './Bookings';
import Visits from './Visits';
import { ApiKeys, AssignmentRules } from './LeadCapture';
import { Inbox } from './Comms';
import Reports from './Reports';
import Partners from './Partners';
import { SuspendedScreen, TenantBilling } from '../lib/Billing';
import { ChangePassword } from '../lib/Password';

export interface Me {
  user: { id: string; name: string; role: string };
  workspace: { id: string; name: string; subdomain: string; status: string; trial_ends_at: string | null };
  features: Record<string, boolean>;
  limits: Record<string, number>;
  support_session: { mode: string } | null;
}
const MeCtx = createContext<{ me: Me; reload: () => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;
export const isManager = (role: string) => ['owner', 'admin', 'sales_manager', 'team_leader'].includes(role);
export const isAdmin = (role: string) => ['owner', 'admin'].includes(role);

export default function CrmApp() {
  absorbHandoff();
  const nav = useNavigate();
  useEffect(() => onSignedOut(realm => { if (realm === 'tenant') nav('/login', { replace: true }); }), [nav]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/invite" element={<AcceptInvite />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/reset" element={<Reset />} />
      <Route path="/*" element={session.token('tenant') ? <Shell /> : <Navigate to="/login" replace />} />
    </Routes>
  );
}

function Shell() {
  const { data: me, error, reload } = useLoad<Me>(() => tenantApi.get('/me'));
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const [pw, setPw] = useState(false);
  if (error?.code === 'workspace_suspended') return <SuspendedScreen onSignOut={() => { session.clear('tenant'); nav('/login'); }} />;
  if (error) return <div className="page"><ErrorState error={error} retry={reload} /></div>;
  if (!me) return <Loading />;

  const signOut = () => { session.clear('tenant'); nav('/login'); };
  const trialEnds = me.workspace.trial_ends_at ? new Date(me.workspace.trial_ends_at) : null;
  const expired = me.workspace.status === 'trial' && trialEnds && trialEnds < new Date();
  const daysLeft = trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / 864e5) : 0;
  const items = [
    { to: '/', ico: '◧', label: 'Dashboard', end: true },
    { to: '/my-day', ico: '◷', label: 'My day' },
    { to: '/leads', ico: '◉', label: 'Leads' },
    { to: '/inbox', ico: '✉', label: 'Inbox', locked: !me.features.whatsapp },
    { to: '/pipeline', ico: '▥', label: 'Pipeline' },
    { to: '/visits', ico: '⌂', label: 'Site visits' },
    { to: '/inventory', ico: '▦', label: 'Inventory' },
    { to: '/bookings', ico: '₹', label: 'Bookings' },
    { to: '/field', ico: '⌖', label: 'Field team', locked: !me.features.field_tracking },
    ...(['owner', 'admin', 'sales_manager', 'finance'].includes(me.user.role) ? [{ to: '/partners', ico: '⚑', label: 'Partners', locked: !me.features.cp_portal }] : []),
    ...(['owner', 'admin', 'sales_manager', 'team_leader'].includes(me.user.role) || me.support_session ? [{ to: '/team', ico: '◎', label: 'Team' }] : []),
    ...(['owner', 'admin', 'sales_manager', 'team_leader', 'marketing', 'finance'].includes(me.user.role) || me.support_session ? [{ to: '/reports', ico: '◔', label: 'Reports' }] : []),
  ];

  // A page typed into the address bar gets the same answer as the menu: if your role doesn't have it, say so plainly.
  const can = (...roles: string[]) => roles.includes(me.user.role) || !!me.support_session;
  const NoAccess = <Empty title="You don't have access to this page" action={<NavLink className="btn" to="/">Go to dashboard</NavLink>}>Your role doesn't include it. Ask your admin if you need it.</Empty>;

  return (
    <MeCtx.Provider value={{ me, reload }}>
      <div className="frame">
        <aside className="rail">
          <div className="brand"><img className="brand-mark-img" src="/hxg-mark.png" alt="" /><div>{me.workspace.name}<small>HXG Connect</small></div></div>
          <nav className="nav" aria-label="Main">
            {items.map(i => (
              <NavLink key={i.to} to={i.to} end={i.end}>
                <span className="ico" aria-hidden>{i.ico}</span><span className="lbl">{i.label}</span>
                {i.locked && <span className="lock" title="Not in your plan">Upgrade</span>}
              </NavLink>
            ))}
            {isAdmin(me.user.role) && <><div className="nav-sep" /><NavLink to="/settings"><span className="ico">⚙</span><span className="lbl">Settings</span></NavLink></>}
          </nav>
          <div className="rail-foot">
            <div className="avatar">{initials(me.user.name)}</div>
            <div className="who"><b>{me.user.name}</b><span className="small muted">{humanize(me.user.role)}</span></div>
            <div className="acts">
              <button className="btn ghost sm" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? '☀' : '☾'}</button>
              <button className="btn ghost sm" onClick={() => setPw(true)} disabled={!!me.support_session}>Password</button>
              <button className="btn ghost sm" onClick={signOut}>Sign out</button>
            </div>
          </div>
          {pw && <ChangePassword realm="tenant" onClose={() => setPw(false)} />}
        </aside>
        <div className="main">
          {me.support_session && (
            <div className="banner support"><b>HXG Connect support is viewing this workspace</b>
              <span>{me.support_session.mode === 'read_only' ? 'Read-only. Nothing can be changed.' : 'Full access was granted.'}</span></div>
          )}
          {me.workspace.status === 'past_due' && (
            <div className="banner expired"><b>Payment overdue.</b><span>{me.user.role === 'owner' ? <>Pay the open invoice in <NavLink to="/settings">Settings</NavLink> to avoid interruption.</> : 'Ask your account owner to pay the open invoice to avoid interruption.'}</span></div>)}
          {expired ? (
            <div className="banner expired"><b>Your trial has ended.</b><span>You can still see everything. Ask your account owner to choose a plan to keep adding leads.</span></div>
          ) : me.workspace.status === 'trial' && daysLeft <= 7 ? (
            <div className="banner trial"><b>{daysLeft} day{daysLeft === 1 ? '' : 's'} left in your trial.</b></div>
          ) : null}
          <div className="page">
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="my-day" element={<MyDay />} />
              <Route path="leads" element={<LeadsList />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="leads/:id" element={<LeadDetail />} />
              <Route path="pipeline" element={<Pipeline />} />
              <Route path="visits" element={<Visits />} />
              <Route path="inventory" element={<InventoryList />} />
              <Route path="inventory/:id" element={<ProjectView />} />
              <Route path="bookings" element={<BookingsList />} />
              <Route path="bookings/:id" element={<BookingDetail />} />
              <Route path="field" element={<Field_ />} />
              <Route path="team" element={can('owner', 'admin', 'sales_manager', 'team_leader') ? <Team /> : NoAccess} />
              <Route path="reports" element={can('owner', 'admin', 'sales_manager', 'team_leader', 'marketing', 'finance') ? <Reports /> : NoAccess} />
              <Route path="partners" element={can('owner', 'admin', 'sales_manager', 'finance') ? <Partners /> : NoAccess} />
              <Route path="settings" element={can('owner', 'admin') ? <Settings /> : NoAccess} />
              <Route path="*" element={<Empty title="Page not found" action={<NavLink className="btn" to="/">Go to dashboard</NavLink>} />} />
            </Routes>
          </div>
        </div>
      </div>
    </MeCtx.Provider>
  );
}

// ---------------------------------------------------------------------
export function FloorPlan() {
  // Line drawing of a 3BHK plan: the login screen's one decorative moment.
  return (
    <svg className="plan" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="20" y="20" width="360" height="260" /><path d="M20 140h140v140M160 20v80M160 140h60M260 20v120h120M260 200h120M220 140v140" />
        <path d="M160 100a40 40 0 0 1 40 40M260 140a30 30 0 0 0 30 30M220 200a28 28 0 0 1 28-28" strokeWidth="1" />
        <rect x="40" y="40" width="70" height="44" strokeWidth="1" /><rect x="285" y="225" width="60" height="34" strokeWidth="1" />
      </g>
    </svg>
  );
}

function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const [ws, setWs] = useState(session.workspace() ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!session.onSubdomain()) session.setWorkspace(ws);
    const r = await run(() => tenantApi.post<{ token: string }>('/auth/login', { email, password }));
    if (r) { session.set('tenant', r.token); nav((loc.state as { from?: string })?.from ?? '/', { replace: true }); }
  }

  return (
    <div className="auth">
      <div className="auth-art">
        <FloorPlan />
        <div style={{ position: 'relative' }}><Logo height={52} /></div>
        <div><h1>Every enquiry, from first call to possession.</h1><p style={{ marginTop: 12 }}>Sign in to your company's workspace.</p></div>
      </div>
      <div className="auth-form">
        <form onSubmit={submit} noValidate>
          <h2>Sign in</h2>
          <p className="lede">{session.onSubdomain() ? session.workspace() : 'Use the workspace name your company was given.'}</p>
          {error && <div className="alert bad">{error.message}</div>}
          {!session.onSubdomain() && (
            <Field label="Workspace" hint="For example: sunrise">
              <input className="input" value={ws} onChange={e => setWs(e.target.value)} autoComplete="organization" required />
            </Field>
          )}
          <Field label="Work email" error={error?.field('email')}>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required />
          </Field>
          <Field label="Password">
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>
          <button className="btn primary block" disabled={busy || !email || !password || (!session.onSubdomain() && !ws)}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="small" style={{ marginTop: 14, textAlign: 'center' }}><a href="/forgot" onClick={e => { e.preventDefault(); if (!session.onSubdomain() && ws) session.setWorkspace(ws); nav('/forgot'); }}>Forgot password?</a></p>
          <p className="small faint" style={{ marginTop: 18, textAlign: 'center' }}><a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a> · <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a></p>
        </form>
      </div>
    </div>
  );
}

function AcceptInvite() {
  const nav = useNavigate();
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ws = params.get('ws');
    if (ws) session.setWorkspace(ws);
    const r = await run(() => tenantApi.post<{ token: string }>('/auth/accept-invite', { token, password }));
    if (r) { session.set('tenant', r.token); history.replaceState(null, '', '/invite'); nav('/', { replace: true }); }
  }

  return (
    <div className="auth">
      <div className="auth-art"><FloorPlan /><div /><div><h1>You've been invited to HXG Connect.</h1><p style={{ marginTop: 12 }}>Set a password to open your workspace.</p></div></div>
      <div className="auth-form">
        {!token ? <Empty title="This invite link is incomplete">Ask your admin to send it again.</Empty> : (
          <form onSubmit={submit}>
            <h2>Set your password</h2>
            <p className="lede">At least 10 characters. A short phrase works well.</p>
            {error && <div className="alert bad">{error.field('password') ?? error.message}</div>}
            <Field label="Password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Confirm password" error={confirm && confirm !== password ? 'Passwords don\'t match' : undefined}>
              <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
            </Field>
            <button className="btn primary block" disabled={busy || password.length < 10 || password !== confirm}>{busy ? 'Setting up…' : 'Open my workspace'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Forgot() {
  const nav = useNavigate();
  const [ws, setWs] = useState(session.workspace() ?? '');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!session.onSubdomain()) session.setWorkspace(ws);
    const r = await run(() => tenantApi.post<{ message: string }>('/auth/forgot', { email }));
    if (r) setDone(r.message);
  }
  return (
    <div className="auth"><div className="auth-art"><FloorPlan /><div style={{ position: 'relative' }}><Logo height={52} /></div><div><h1>Reset your password.</h1></div></div>
      <div className="auth-form">{done ? <div style={{ width: 'min(360px, 100%)' }}><div className="alert info">{done} Check your email, including spam. If email isn't set up for your company, ask your admin for a reset link.</div><button className="btn block" onClick={() => nav('/login')}>Back to sign in</button></div> : (
        <form onSubmit={submit}><h2>Forgot password</h2><p className="lede">We'll email you a link to set a new one.</p>
          {error && <div className="alert bad">{error.message}</div>}
          {!session.onSubdomain() && <Field label="Workspace"><input className="input" value={ws} onChange={e => setWs(e.target.value)} /></Field>}
          <Field label="Work email"><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></Field>
          <button className="btn primary block" disabled={busy || !email || (!session.onSubdomain() && !ws)}>Send reset link</button></form>)}</div></div>
  );
}

function Reset() {
  const nav = useNavigate();
  const params = new URLSearchParams(location.hash.slice(1));
  const [password, setPassword] = useState(''); const [again, setAgain] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (params.get('ws')) session.setWorkspace(params.get('ws')!);
    if (await run(() => tenantApi.post('/auth/reset', { token: params.get('token'), password }))) { history.replaceState(null, '', '/reset'); nav('/login', { replace: true }); }
  }
  return (
    <div className="auth"><div className="auth-art"><FloorPlan /><div style={{ position: 'relative' }}><Logo height={52} /></div><div><h1>Set a new password.</h1></div></div>
      <div className="auth-form">{!params.get('token') ? <Empty title="This reset link is incomplete">Ask for a new one.</Empty> : (
        <form onSubmit={submit}><h2>New password</h2><p className="lede">At least 10 characters. The link works once.</p>
          {error && <div className="alert bad">{error.field('password') ?? error.message}</div>}
          <Field label="New password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
          <Field label="Again" error={again && again !== password ? "Passwords don't match" : undefined}><input className="input" type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" /></Field>
          <button className="btn primary block" disabled={busy || password.length < 10 || password !== again}>Save and sign in</button></form>)}</div></div>
  );
}

// ---------------------------------------------------------------------
function Settings() {
  const { me } = useMe();
  const toast = useToast();
  const reqs = useLoad<any[]>(() => tenantApi.get('/support-access'));
  const decide = async (id: string, action: 'approve' | 'reject' | 'end') => {
    try {
      await tenantApi.post(`/support-access/${id}/${action}`);
      toast(action === 'approve' ? 'Access approved for 60 minutes' : action === 'end' ? 'Support session ended' : 'Request declined');
      reqs.reload();
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <>
      <div className="page-head"><div className="grow"><h1>Settings</h1><p>Connected services, who can access this workspace, and your plan.</p></div></div>
      <div className="section">
        <div className="section-head"><h2>Lead capture</h2></div>
        {!me.support_session && <><div className="section"><AssignmentRules /></div><ApiKeys /></>}
      </div>
      <div className="section">
        <div className="section-head"><h2>Integrations</h2></div>
        <p className="muted small" style={{ marginBottom: 12 }}>Connect your own accounts. Keys are encrypted and never shown again after saving. You can add or change them any time.</p>
        <Integrations realm="tenant" readOnly={!!me.support_session} />
      </div>
      {me.user.role === 'owner' && !me.support_session && <div className="section"><div className="section-head"><h2>Billing</h2></div><TenantBilling /></div>}
      <div className="section">
        <div className="section-head"><h2>Support access</h2></div>
        <p className="muted small" style={{ marginBottom: 10 }}>HXG Connect support can only see your workspace after you approve a request. Access lasts 60 minutes and you can end it any time.</p>
        <div className="table-wrap">
          {reqs.loading && !reqs.data ? <Loading /> : !reqs.data?.length ? <Empty title="No access requests" /> : (
            <table><thead><tr><th>Requested by</th><th>Reason</th><th>Access</th><th>Status</th><th /></tr></thead>
              <tbody>{reqs.data.map(r => (
                <tr key={r.id}>
                  <td>{r.requested_by}<span className="sub">{when(r.created_at)}</span></td>
                  <td style={{ maxWidth: 340 }}>{r.reason}</td>
                  <td>{r.mode === 'read_only' ? 'View only' : 'Full'}</td>
                  <td><span className={`chip ${r.status === 'approved' ? 'warn' : r.status === 'pending' ? 'act' : ''}`}>{humanize(r.status)}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.status === 'pending' && !me.support_session && <>
                      <button className="btn sm" onClick={() => decide(r.id, 'reject')}>Decline</button>{' '}
                      <button className="btn sm primary" onClick={() => decide(r.id, 'approve')}>Approve</button></>}
                    {r.status === 'approved' && <button className="btn sm danger" onClick={() => decide(r.id, 'end')}>End session</button>}
                  </td>
                </tr>))}
              </tbody></table>
          )}
        </div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Your plan</h2></div>
        <div className="panel panel-pad">
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Users</dt><dd className="num">{me.limits.users?.toLocaleString('en-IN')}</dd>
            <dt>Leads</dt><dd className="num">{me.limits.leads?.toLocaleString('en-IN')}</dd>
            {Object.entries(me.features).map(([k, v]) => (<Fragment key={k}><dt>{humanize(k)}</dt><dd>{v ? 'Included' : <span className="faint">Not included</span>}</dd></Fragment>))}
          </dl>
        </div>
      </div>
    </>
  );
}
