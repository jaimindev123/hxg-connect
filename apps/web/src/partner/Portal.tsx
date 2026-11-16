import { FormEvent, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { onSignedOut, partnerApi, session } from '../lib/api';
import { Empty, ErrorState, Field, humanize, inr, Loading, Logo, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { FloorPlan } from '../crm/App';

/** The broker-facing portal: its own sign-in, and nothing of the CRM. */
export default function PartnerApp() {
  const nav = useNavigate();
  useEffect(() => onSignedOut(r => { if (r === 'partner') nav('/partner/login', { replace: true }); }), [nav]);
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route path="invite" element={<Invite />} />
      <Route path="*" element={session.token('partner') ? <Home /> : <Navigate to="/partner/login" replace />} />
    </Routes>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth"><div className="auth-art"><FloorPlan /><div style={{ position: 'relative' }}><Logo height={52} /><div className="small muted" style={{ marginTop: 8 }}>HXG Connect partner portal</div></div>
      <div><h1>{title}</h1><p style={{ marginTop: 12 }}>Register buyers, follow them to booking, and track your commission.</p></div></div>
      <div className="auth-form">{children}</div></div>
  );
}

function Login() {
  const nav = useNavigate();
  const [ws, setWs] = useState(session.workspace() ?? '');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!session.onSubdomain()) session.setWorkspace(ws);
    const r = await run(() => partnerApi.post<{ token: string }>('/partner/auth/login', { email, password }));
    if (r) { session.set('partner', r.token); nav('/partner', { replace: true }); }
  }
  return (
    <Shell title="Sign in to register your buyers.">
      <form onSubmit={submit}><h2>Partner sign in</h2><p className="lede">Use the email the developer invited.</p>
        {error && <div className="alert bad">{error.message}</div>}
        {!session.onSubdomain() && <Field label="Developer workspace"><input className="input" value={ws} onChange={e => setWs(e.target.value)} /></Field>}
        <Field label="Email"><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></Field>
        <Field label="Password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <button className="btn primary block" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button></form>
    </Shell>
  );
}

function Invite() {
  const nav = useNavigate();
  const p = new URLSearchParams(location.hash.slice(1));
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (p.get('ws')) session.setWorkspace(p.get('ws')!);
    const r = await run(() => partnerApi.post<{ token: string }>('/partner/auth/accept-invite', { token: p.get('token'), password }));
    if (r) { session.set('partner', r.token); history.replaceState(null, '', '/partner/invite'); nav('/partner', { replace: true }); }
  }
  return (
    <Shell title="You've been invited as a channel partner.">
      {!p.get('token') ? <Empty title="This invite link is incomplete" /> : (
        <form onSubmit={submit}><h2>Set your password</h2><p className="lede">At least 10 characters.</p>
          {error && <div className="alert bad">{error.field('password') ?? error.message}</div>}
          <Field label="Password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
          <button className="btn primary block" disabled={busy || password.length < 10}>Open the portal</button></form>)}
    </Shell>
  );
}

function Home() {
  const nav = useNavigate();
  const toast = useToast();
  const me = useLoad<any>(() => partnerApi.get('/partner/me'));
  const leads = useLoad<any[]>(() => partnerApi.get('/partner/leads'));
  const comm = useLoad<any[]>(() => partnerApi.get('/partner/commissions'));
  const [f, setF] = useState({ name: '', phone: '', email: '', budget: '', requirement: '', note: '' });
  const { busy, error, run } = useSubmit();
  async function register(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => partnerApi.post('/partner/leads', Object.fromEntries(Object.entries(f).filter(([, v]) => v))));
    if (r) { toast(`${f.name} is registered to you until ${new Date(r.protected_until).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}`); setF({ name: '', phone: '', email: '', budget: '', requirement: '', note: '' }); leads.reload(); }
  }
  if (me.error) return <div className="page"><ErrorState error={me.error} /></div>;
  if (!me.data) return <Loading />;
  const earned = (comm.data ?? []).filter(c => c.status !== 'cancelled').reduce((n, c) => n + Number(c.amount), 0);
  const paid = (comm.data ?? []).filter(c => c.status === 'paid').reduce((n, c) => n + Number(c.amount), 0);
  return (
    <div className="page" style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="page-head"><div className="grow"><h1>{me.data.firm_name}</h1>
        <p>Partner of {me.data.developer}. {Number(me.data.commission_pct)}% commission; buyers stay yours for {me.data.protection_days} days after you register them.</p></div>
        <button className="btn" onClick={() => { session.clear('partner'); nav('/partner/login'); }}>Sign out</button></div>
      <div className="figures">
        <div className="figure"><div className="v">{leads.data?.length ?? '—'}</div><div className="l">Buyers registered</div></div>
        <div className="figure"><div className="v">{leads.data?.filter(l => l.booked).length ?? '—'}</div><div className="l">Booked</div></div>
        <div className="figure money"><div className="v">{inr(earned) === '—' ? '₹0' : inr(earned)}</div><div className="l">Commission earned</div></div>
        <div className="figure"><div className="v">{inr(paid) === '—' ? '₹0' : inr(paid)}</div><div className="l">Paid to you</div></div>
      </div>
      <div className="grid-2">
        <div>
          <div className="section"><div className="section-head"><h2>Your buyers</h2></div>
            <div className="table-wrap">{!leads.data ? <Loading /> : !leads.data.length ? <Empty title="No buyers yet">Register your first buyer with the form.</Empty> : (
              <table><thead><tr><th>Buyer</th><th>Stage</th><th>Protected until</th></tr></thead>
                <tbody>{leads.data.map(l => { const live = new Date(l.cp_protected_until) > new Date();
                  return <tr key={l.id}><td><b>{l.name}</b><span className="sub num">{l.primary_phone}</span></td>
                    <td><span className={`chip ${l.booked ? 'ok' : l.status === 'lost' ? 'bad' : ''}`}>{l.booked ? 'Booked' : l.stage}</span></td>
                    <td className={live ? '' : 'overdue-text'}>{l.booked ? <span className="muted">Booked</span> : live ? new Date(l.cp_protected_until).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'Expired'}</td></tr>; })}</tbody></table>)}
            </div></div>
          <div className="section"><div className="section-head"><h2>Commission</h2></div>
            <div className="table-wrap">{!comm.data ? <Loading /> : !comm.data.length ? <Empty title="No commission yet">It appears here when one of your buyers books.</Empty> : (
              <table><thead><tr><th>Buyer and unit</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>{comm.data.map(c => <tr key={c.id}><td>{c.buyer}<span className="sub">{c.project}, {c.tower}-{c.unit_no}</span></td>
                  <td className="money">₹{Number(c.amount).toLocaleString('en-IN')}</td>
                  <td><span className={`chip ${c.status === 'paid' ? 'ok' : c.status === 'cancelled' ? 'bad' : 'warn'}`}>{humanize(c.status)}</span>
                    {c.status === 'paid' && <span className="sub">{when(c.paid_at)}, {c.paid_reference}</span>}</td></tr>)}</tbody></table>)}
            </div></div>
        </div>
        <div className="section"><div className="section-head"><h2>Register a buyer</h2></div>
          <form className="panel panel-pad" onSubmit={register}>
            {error && <div className="alert bad">{error.message}</div>}
            <Field label="Buyer's name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Mobile" error={error?.field('phone')}><input className="input" inputMode="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
            <div className="row"><Field label="Budget"><input className="input" value={f.budget} onChange={e => setF({ ...f, budget: e.target.value })} placeholder="75 lakh" /></Field>
              <Field label="Looking for"><input className="input" value={f.requirement} onChange={e => setF({ ...f, requirement: e.target.value })} placeholder="3BHK flat" /></Field></div>
            <Field label="Note for the sales team"><textarea className="input" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="Visiting Sunday with family" /></Field>
            <button className="btn primary block" disabled={busy || !f.name || f.phone.length < 10}>{busy ? 'Registering…' : 'Register buyer'}</button>
            <p className="small muted" style={{ marginTop: 8 }}>If the developer already has this buyer, registration is refused. Buyers you register are matched by mobile number.</p>
          </form></div>
      </div>
    </div>
  );
}
