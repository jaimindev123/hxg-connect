import { FormEvent, useState } from 'react';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, initials, Loading, Modal, useLoad, useSubmit, useToast } from '../lib/ui';
import { isAdmin, isManager, useMe } from './App';

export default function Team() {
  const { me } = useMe();
  const toast = useToast();
  const users = useLoad<any[]>(() => tenantApi.get('/users'));
  const roles = useLoad<any[]>(() => tenantApi.get('/users/roles'));
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  if (users.error) return <ErrorState error={users.error} retry={users.reload} />;
  if (!users.data) return <Loading />;

  const seats = users.data.filter(u => u.status !== 'inactive').length;
  const limit = me.limits.users;
  const full = limit !== undefined && seats >= limit;
  const admin = isAdmin(me.user.role);
  const leader = me.user.role === 'team_leader';   // sees only their own team
  const managers = users.data.filter(u => isManager(u.role) && u.status === 'active');

  return (
    <>
      <div className="page-head">
        <div className="grow"><h1>{leader ? 'Your team' : 'Team'}</h1>
          {leader
            ? <p>You and the <span className="num">{users.data.length - 1}</span> {users.data.length === 2 ? 'person' : 'people'} who report to you.</p>
            : <p><span className="num">{seats}</span> of <span className="num">{limit?.toLocaleString('en-IN')}</span> seats used{full ? '. Your plan is full.' : ''}</p>}</div>
        {admin && <button className="btn primary" onClick={() => setInviting(true)} disabled={full} title={full ? 'All seats are in use' : undefined}>Invite someone</button>}
      </div>
      {full && admin && <div className="alert info">All seats are in use. Deactivate someone who has left, or ask your account owner to upgrade.</div>}
      <div className="table-wrap">
        {!users.data.length ? <Empty title="Just you so far" /> : (
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Reports to</th><th>Status</th>{admin && <th />}</tr></thead>
            <tbody>
              {users.data.map(u => (
                <tr key={u.id}>
                  <td><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><div className="avatar">{initials(u.name)}</div>
                    <div><b>{u.name}</b>{u.id === me.user.id && <span className="faint"> (you)</span>}<span className="sub">{u.email}</span></div></div></td>
                  <td>{u.role_name}</td>
                  <td>{u.manager_name ?? <span className="faint">—</span>}</td>
                  <td><span className={`chip ${u.status === 'active' ? 'ok' : u.status === 'invited' ? 'act' : ''}`}>{humanize(u.status)}</span></td>
                  {admin && <td style={{ textAlign: 'right' }}>{u.role !== 'owner' && <button className="btn sm" onClick={() => setEditing(u)}>Edit</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {inviting && <Invite roles={roles.data ?? []} managers={managers} onClose={() => setInviting(false)} onDone={() => users.reload()} />}
      {editing && <EditUser user={editing} roles={roles.data ?? []} managers={managers.filter(m => m.id !== editing.id)}
        onClose={() => setEditing(null)} onDone={msg => { setEditing(null); toast(msg); users.reload(); }} />}
    </>
  );
}

function Invite({ roles, managers, onClose, onDone }: { roles: any[]; managers: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'sales_executive', manager_id: '' });
  const [link, setLink] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(false);
  const { busy, error, run } = useSubmit();
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post('/users', { ...f, manager_id: f.manager_id || undefined }));
    if (r) {
      setLink(r.invite_link);
      setEmailed(!!r.invite_emailed);
      onDone();
    }
  }

  if (link) return (
    <Modal title="Invitation ready" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <p style={{ marginBottom: 10 }}>{emailed ? `We've emailed ${f.email} an invitation. You can also send this link yourself.` : `Send this link to ${f.name}. It works once and expires in 72 hours.`}</p>
      <div className="row"><input className="input" readOnly value={link} onFocus={e => e.target.select()} />
        <button className="btn" style={{ flex: 'none' }} onClick={() => { navigator.clipboard.writeText(link); toast('Link copied'); }}>Copy</button></div>
    </Modal>
  );

  return (
    <Modal title="Invite someone" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="invite" disabled={busy || !f.name || !f.email}>{busy ? 'Inviting…' : 'Create invitation'}</button></>}>
      <form id="invite" onSubmit={submit}>
        {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
        <Field label="Name" error={error?.field('name')}><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Work email" error={error?.field('email')}><input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <div className="row">
          <Field label="Role"><select className="input" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{roles.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}</select></Field>
          <Field label="Reports to" hint="Their field check-ins go to this person"><select className="input" value={f.manager_id} onChange={e => setF({ ...f, manager_id: e.target.value })}>
            <option value="">Nobody</option>{managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        </div>
      </form>
    </Modal>
  );
}

function EditUser({ user, roles, managers, onClose, onDone }: { user: any; roles: any[]; managers: any[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [role, setRole] = useState(user.role);
  const [manager, setManager] = useState(user.manager_id ?? '');
  const { busy, error, run } = useSubmit();
  const [link, setLink] = useState('');
  const toast = useToast();
  const save = async (extra: object = {}, msg = 'Saved') => {
    const r = await run(() => tenantApi.patch(`/users/${user.id}`, { role, manager_id: manager || null, ...extra }));
    if (r) onDone(msg);
  };
  const active = user.status !== 'inactive';
  return (
    <Modal title={`Edit ${user.name}`} onClose={onClose}
      footer={<>
        <button className={`btn ${active ? 'danger' : ''}`} style={{ marginRight: 'auto' }} disabled={busy}
          onClick={() => save({ status: active ? 'inactive' : 'active' }, active ? `${user.name} deactivated` : `${user.name} reactivated`)}>
          {active ? 'Deactivate' : 'Reactivate'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => save()}>Save changes</button></>}>
      {error && <div className="alert bad">{error.message}</div>}
      <Field label="Role"><select className="input" value={role} onChange={e => setRole(e.target.value)}>{roles.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}</select></Field>
      <Field label="Reports to"><select className="input" value={manager} onChange={e => setManager(e.target.value)}>
        <option value="">Nobody</option>{managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      {active && <p className="small muted">Deactivating frees their seat and blocks sign-in. Their leads and history stay.</p>}
      {user.status === 'active' && <div style={{ marginTop: 12 }}>{link ? <div className="row"><input className="input" readOnly value={link} onFocus={e => e.target.select()} />
        <button className="btn" style={{ flex: 'none' }} onClick={() => { navigator.clipboard.writeText(link); toast('Reset link copied. It works once, for 1 hour.'); }}>Copy</button></div>
        : <button className="btn sm" onClick={async () => { const r = await run(() => tenantApi.post(`/users/${user.id}/reset-link`)); if (r) setLink(r.reset_link); }}>Make a password reset link</button>}</div>}
    </Modal>
  );
}
