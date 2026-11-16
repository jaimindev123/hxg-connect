import { FormEvent, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { platformApi } from '../lib/api';
import { Field, Loading, Modal, useLoad, useSubmit, useToast } from '../lib/ui';

/** Two-step sign-in for console staff: password, then a code from an
 *  authenticator app. Shown in console Settings. */
export function TwoStep() {
  const toast = useToast();
  const st = useLoad<{ enabled: boolean; backup_codes_left: number }>(() => platformApi.get('/platform/me/two-factor'));
  const [mode, setMode] = useState<null | 'on' | 'off'>(null);
  if (!st.data) return <Loading />;
  return (
    <div className="panel panel-pad">
      {st.data.enabled ? (
        <>
          <p><b>On.</b> Signing in to this console needs your password and a code from your authenticator app.</p>
          <p className="small muted" style={{ margin: '6px 0 12px' }}>{st.data.backup_codes_left} backup code{st.data.backup_codes_left === 1 ? '' : 's'} left. To move to a new phone or get fresh backup codes, turn it off and set it up again.</p>
          <button className="btn danger" onClick={() => setMode('off')}>Turn off</button>
        </>
      ) : (
        <>
          <p><b>Off.</b> Anyone who learns your password can open this console, and with it every client's account.</p>
          <p className="small muted" style={{ margin: '6px 0 12px' }}>Takes two minutes. You need an authenticator app on your phone: Google Authenticator, Microsoft Authenticator or Authy.</p>
          <button className="btn primary" onClick={() => setMode('on')}>Turn on two-step sign-in</button>
        </>
      )}
      {mode === 'on' && <TurnOn onClose={() => { setMode(null); st.reload(); }} />}
      {mode === 'off' && <TurnOff onClose={done => { setMode(null); if (done) { toast('Two-step sign-in is off'); st.reload(); } }} />}
    </div>
  );
}

function TurnOn({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState<string[] | null>(null);
  const { busy, error, run } = useSubmit();
  useEffect(() => { if (setup) QRCode.toString(setup.uri, { type: 'svg', margin: 1, width: 200 }).then(setQr).catch(() => setQr('')); }, [setup]);

  async function start(e: FormEvent) { e.preventDefault(); const r = await run(() => platformApi.post<{ secret: string; uri: string }>('/platform/me/two-factor/setup', { password })); if (r) setSetup(r); }
  async function confirm(e: FormEvent) { e.preventDefault(); const r = await run(() => platformApi.post<{ backup_codes: string[] }>('/platform/me/two-factor/enable', { code })); if (r) setBackup(r.backup_codes); }
  const copy = () => navigator.clipboard.writeText(backup!.join('\n'));

  if (backup) return (
    <Modal title="Save your backup codes" onClose={onClose} footer={<><button className="btn" onClick={copy}>Copy codes</button><button className="btn primary" onClick={onClose}>I've saved them</button></>}>
      <p>Two-step sign-in is on. If you lose your phone, each of these codes signs you in once. They are shown only now.</p>
      <pre className="num" style={{ margin: '12px 0', padding: 12, border: '1px solid var(--line)', borderRadius: 8, columns: 2, lineHeight: 1.9 }}>{backup.join('\n')}</pre>
      <p className="small muted">Keep them in your password manager, not on the same phone.</p>
    </Modal>);

  if (setup) return (
    <Modal title="Scan and confirm" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="tf2" disabled={busy || code.replace(/\s/g, '').length !== 6}>Turn on</button></>}>
      <form id="tf2" onSubmit={confirm}>
        {error && <div className="alert bad">{error.message}</div>}
        <p>1. Open your authenticator app, add an account, and scan this code.</p>
        <div style={{ background: '#fff', width: 216, padding: 8, margin: '10px 0', borderRadius: 8, border: '1px solid var(--line)' }} dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR code for your authenticator app" />
        <p className="small muted" style={{ marginBottom: 14 }}>Can't scan? Type this key into the app instead: <b className="num" style={{ wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</b></p>
        <Field label="2. Enter the 6-digit code the app shows"><input className="input num" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} autoFocus /></Field>
      </form>
    </Modal>);

  return (
    <Modal title="Turn on two-step sign-in" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="tf1" disabled={busy || !password}>Continue</button></>}>
      <form id="tf1" onSubmit={start}>
        {error && <div className="alert bad">{error.message}</div>}
        <Field label="Your password" hint="To confirm it's you"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>
      </form>
    </Modal>);
}

function TurnOff({ onClose }: { onClose: (done: boolean) => void }) {
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) { e.preventDefault(); if (await run(() => platformApi.post('/platform/me/two-factor/disable', { password }))) onClose(true); }
  return (
    <Modal title="Turn off two-step sign-in" onClose={() => onClose(false)} footer={<><button className="btn" onClick={() => onClose(false)}>Cancel</button><button className="btn danger" form="tf3" disabled={busy || !password}>Turn off</button></>}>
      <form id="tf3" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <p style={{ marginBottom: 12 }}>Your password alone will open the console again. Your backup codes stop working.</p>
        <Field label="Your password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>
      </form>
    </Modal>);
}
