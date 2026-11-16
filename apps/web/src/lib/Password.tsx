import { FormEvent, useState } from 'react';
import { api, Realm } from './api';
import { Field, Modal, useSubmit, useToast } from './ui';

export function ChangePassword({ realm, onClose }: { realm: Realm; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const { busy, error, run } = useSubmit();
  const min = realm === 'platform' ? 12 : 10;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api(realm, 'PATCH', realm === 'platform' ? '/platform/me/password' : '/me/password', { current, password: next }))) { toast('Password changed'); onClose(); }
  }
  return (
    <Modal title="Change password" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="pw" disabled={busy || next.length < min || next !== again}>Change password</button></>}>
      <form id="pw" onSubmit={submit}>
        {error && <div className="alert bad">{error.field('password') ?? error.message}</div>}
        <Field label="Current password"><input className="input" type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" autoFocus /></Field>
        <Field label="New password" hint={`At least ${min} characters`}><input className="input" type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="New password again" error={again && again !== next ? "Passwords don't match" : undefined}><input className="input" type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" /></Field>
      </form>
    </Modal>
  );
}
