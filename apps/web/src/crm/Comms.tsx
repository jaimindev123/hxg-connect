import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { session, tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, isoToLocal, Loading, localToIso, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { useMe } from './App';

const DISPOSITIONS = ['interested', 'not_interested', 'call_back', 'not_reachable', 'wrong_number', 'switched_off'];
const mmss = (s?: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

/** Click-to-call: rings the agent's phone, then the buyer. Asks for the
 *  agent's number the first time; falls back to the dialer if no provider. */
export function useClickToCall(onPlaced?: () => void) {
  const toast = useToast();
  const { me } = useMe();
  const [askFor, setAskFor] = useState<{ leadId: string; phone: string } | null>(null);
  async function call(leadId: string, phone: string) {
    if (!me.features.telephony) { location.href = `tel:${phone}`; return; }   // calling switched off: use the phone's own dialer
    try {
      await tenantApi.post('/calls/click-to-call', { lead_id: leadId });
      toast('Calling. Your phone rings first; pick up and we connect the buyer.');
      onPlaced?.();
    } catch (e: any) {
      if (e.code === 'agent_phone_missing') setAskFor({ leadId, phone });
      else if (e.code === 'calling_not_connected' || e.code === 'click_to_call_unsupported' || e.code === 'feature_not_in_plan') { location.href = `tel:${phone}`; }
      else toast(e.message, true);
    }
  }
  const prompt = askFor && <AgentPhone onClose={() => setAskFor(null)} onSaved={() => { const a = askFor; setAskFor(null); call(a.leadId, a.phone); }} />;
  return { call, prompt };
}

function AgentPhone({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [phone, setPhone] = useState('');
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) { e.preventDefault(); if (await run(() => tenantApi.patch('/me', { phone }))) onSaved(); }
  return (
    <Modal title="Your mobile number" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="ap" disabled={busy || phone.length < 10}>Save and call</button></>}>
      <form id="ap" onSubmit={submit}>
        {error && <div className="alert bad">{error.field('phone') ?? error.message}</div>}
        <p className="muted small" style={{ marginBottom: 10 }}>Calls ring your phone first, then the buyer, so they see your company's number, not yours. The call is recorded and logged on the lead.</p>
        <Field label="Mobile"><input className="input" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} autoFocus /></Field>
      </form>
    </Modal>
  );
}

// =====================================================================
export function CallsPanel({ leadId, refreshKey }: { leadId: string; refreshKey?: number }) {
  const { me } = useMe();
  const q = useLoad<any[]>(() => (me.features.telephony ? tenantApi.get(`/calls?lead_id=${leadId}`) : Promise.resolve([])), [leadId, refreshKey, me.features.telephony]);
  const [logging, setLogging] = useState<any>(null);
  if (!q.data?.length) return null;
  return (
    <div className="section">
      <div className="section-head"><h2>Calls</h2><span className="grow" /><button className="btn sm ghost" onClick={q.reload}>Refresh</button></div>
      <div className="panel">{q.data.map(c => (
        <div key={c.id} className={`list-item ${c.status === 'missed' ? 'urgent' : ''}`}>
          <div className="grow">
            <b>{c.direction === 'inbound' ? (c.status === 'missed' ? 'Missed call' : 'Incoming') : 'Outgoing'}</b>{' '}
            <span className="muted small">{when(c.started_at)}{c.duration_sec ? `, ${mmss(c.duration_sec)}` : ''}{c.user_name ? `, ${c.user_name}` : ''}</span>
            {c.disposition ? <div className="small">{humanize(c.disposition)}{c.disposition_note ? `: ${c.disposition_note}` : ''}</div>
              : !['initiated', 'ringing', 'in_progress'].includes(c.status) && c.direction === 'outbound' && <div className="small overdue-text">Outcome not logged</div>}
            {c.has_recording && <Recording callId={c.id} />}
          </div>
          {['initiated', 'ringing', 'in_progress'].includes(c.status) ? <span className="chip act">In progress</span>
            : !c.disposition && <button className="btn sm" onClick={() => setLogging(c)}>Log outcome</button>}
        </div>))}</div>
      {logging && <LogOutcome call={logging} onClose={() => setLogging(null)} onDone={() => { setLogging(null); q.reload(); }} />}
    </div>
  );
}

/** Audio needs the auth header, so fetch it as a blob, then play. */
function Recording({ callId }: { callId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function load() {
    setBusy(true);
    try {
      const ws = session.workspace();
      const r = await fetch(`/api/calls/${callId}/recording`, { headers: { authorization: `Bearer ${session.token('tenant')}`, ...(ws && { 'x-tenant': ws }) } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? 'Recording unavailable');
      setUrl(URL.createObjectURL(await r.blob()));
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  }
  return url ? <audio controls autoPlay src={url} style={{ display: 'block', marginTop: 6, width: '100%', maxWidth: 360 }} />
    : <button className="btn sm ghost" style={{ marginTop: 4, paddingLeft: 0 }} onClick={load} disabled={busy}>{busy ? 'Loading…' : '▶ Play recording'}</button>;
}

function LogOutcome({ call, onClose, onDone }: { call: any; onClose: () => void; onDone: () => void }) {
  const t = new Date(Date.now() + 864e5); t.setHours(11, 0, 0, 0);
  const [disp, setDisp] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState(true);
  const [due, setDue] = useState(isoToLocal(t));
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => tenantApi.post(`/calls/${call.id}/disposition`, { disposition: disp, note: note || undefined,
      ...(next && disp !== 'wrong_number' && disp !== 'not_interested' && { next: { type: 'call', due_at: localToIso(due) } }) }))) onDone();
  }
  return (
    <Modal title="How did the call go?" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="lo" disabled={busy || !disp}>Save</button></>}>
      <form id="lo" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>{DISPOSITIONS.map(d => (
          <button type="button" key={d} className={`btn sm ${disp === d ? 'primary' : ''}`} onClick={() => setDisp(d)}>{humanize(d)}</button>))}</div>
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Wants east facing, call after 6" /></Field>
        {disp !== 'wrong_number' && disp !== 'not_interested' && <>
          <label className="small" style={{ display: 'flex', gap: 8, marginBottom: 10 }}><input type="checkbox" checked={next} onChange={e => setNext(e.target.checked)} /> Schedule a call back</label>
          {next && <Field label="When"><input className="input" type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></Field>}</>}
      </form>
    </Modal>
  );
}

// =====================================================================
export function WhatsAppThread({ leadId, compact }: { leadId: string; compact?: boolean }) {
  const { me } = useMe();
  const toast = useToast();
  const t = useLoad<any>(() => tenantApi.get(`/whatsapp/messages?lead_id=${leadId}`), [leadId]);
  const templates = useLoad<any[]>(() => tenantApi.get('/whatsapp/templates'));
  const [text, setText] = useState('');
  const [tpl, setTpl] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [t.data]);
  useEffect(() => { const i = setInterval(() => t.reload(), 20000); return () => clearInterval(i); }, [t.reload]);
  if (t.error) return t.error.code === 'whatsapp_not_connected' || t.error.code === 'feature_not_in_plan' ? null : <ErrorState error={t.error} retry={t.reload} />;
  if (!t.data) return <Loading />;
  const approved = (templates.data ?? []).filter(x => x.status === 'APPROVED');
  const chosen = approved.find(x => `${x.name}|${x.language}` === tpl);

  async function send(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await tenantApi.post('/whatsapp/messages', t.data.window_open && !chosen
        ? { lead_id: leadId, text } : { lead_id: leadId, template: { name: chosen!.name, language: chosen!.language, params } });
      setText(''); setTpl(''); setParams([]); t.reload();
    } catch (err: any) { toast(err.message, true); } finally { setBusy(false); }
  }
  const preview = chosen ? chosen.body.replace(/\{\{(\d+)\}\}/g, (_: string, n: string) => params[Number(n) - 1] || `{{${n}}}`) : '';

  return (
    <div className={compact ? '' : 'section'}>
      {!compact && <div className="section-head"><h2>WhatsApp</h2></div>}
      <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ maxHeight: compact ? '60vh' : 320, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!t.data.messages.length && <p className="muted small">No messages yet. The first message to a buyer must be an approved template.</p>}
          {t.data.messages.map((m: any) => (
            <div key={m.id} style={{ alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start', maxWidth: '80%',
              background: m.direction === 'out' ? 'var(--ink)' : 'var(--sunk)', color: m.direction === 'out' ? 'var(--surface)' : undefined, borderRadius: 8, padding: '7px 10px' }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body ?? <i>Template: {humanize(m.template_name ?? '')}</i>}</div>
              <div className="small faint" style={{ textAlign: 'right' }}>{when(m.created_at)}{m.direction === 'out' && ` · ${m.status === 'failed' ? 'failed' : m.status}`}</div>
            </div>))}
          <div ref={end} />
        </div>
        {t.data.opted_out ? <div className="alert bad" style={{ margin: 12 }}>This buyer replied STOP. WhatsApp messages to them are blocked.</div>
          : !me.support_session && (
          <form onSubmit={send} style={{ borderTop: '1px solid var(--line)', padding: 10 }}>
            {!t.data.window_open && <p className="small muted" style={{ marginBottom: 8 }}>They haven't messaged in the last 24 hours, so WhatsApp only allows an approved template.</p>}
            <div className="row" style={{ marginBottom: chosen ? 8 : 0 }}>
              <select className="input" value={tpl} onChange={e => { setTpl(e.target.value); const c = approved.find(x => `${x.name}|${x.language}` === e.target.value); setParams(Array(c?.params ?? 0).fill('')); }}>
                <option value="">{t.data.window_open ? 'Type a message, or choose a template' : approved.length ? 'Choose a template' : 'No approved templates yet: sync them from the Inbox'}</option>
                {approved.map(x => <option key={x.id} value={`${x.name}|${x.language}`}>{humanize(x.name)} ({x.language})</option>)}
              </select>
            </div>
            {chosen ? <>
              {params.map((p, i) => <input key={i} className="input" style={{ marginBottom: 6 }} placeholder={`Value for {{${i + 1}}}`} value={p} onChange={e => setParams(ps => ps.map((x, j) => (j === i ? e.target.value : x)))} />)}
              <p className="small muted" style={{ margin: '4px 0 8px' }}>{preview}</p>
              <button className="btn primary" disabled={busy || params.some(p => !p.trim())}>Send template</button>
            </> : t.data.window_open && (
              <div className="row" style={{ marginTop: 8 }}><input className="input" placeholder="Message" value={text} onChange={e => setText(e.target.value)} />
                <button className="btn primary" style={{ flex: 'none' }} disabled={busy || !text.trim()}>Send</button></div>)}
          </form>)}
      </div>
    </div>
  );
}

function SyncTemplates() {
  const { me } = useMe();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!['owner', 'admin', 'sales_manager'].includes(me.user.role) || me.support_session) return null;
  async function sync() {
    setBusy(true);
    try { const r = await tenantApi.post('/whatsapp/templates/sync'); toast(`${r.synced} template${r.synced === 1 ? '' : 's'} synced from Meta`); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  }
  return <button className="btn" onClick={sync} disabled={busy}>{busy ? 'Syncing…' : 'Sync templates'}</button>;
}

export function Inbox() {
  const q = useLoad<any[]>(() => tenantApi.get('/whatsapp/conversations'));
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (!open && q.data?.length) setOpen(q.data[0].lead_id); }, [q.data, open]);
  useEffect(() => { const i = setInterval(() => q.reload(), 30000); return () => clearInterval(i); }, [q.reload]);
  if (q.error) return q.error.code === 'whatsapp_not_connected'
    ? <div className="panel"><Empty title="WhatsApp isn't connected">An admin can connect your WhatsApp Business number in Settings, Integrations.</Empty></div>
    : <ErrorState error={q.error} retry={q.reload} />;
  const cur = q.data?.find(c => c.lead_id === open);
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Inbox</h1><p>WhatsApp conversations with your buyers.</p></div>
        <SyncTemplates /></div>
      {!q.data ? <Loading /> : !q.data.length ? <div className="panel"><Empty title="No conversations yet">Send a template from any lead's page to start one.</Empty></div> : (
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(240px, 1fr) 2fr' }}>
          <div className="panel" style={{ alignSelf: 'start' }}>{q.data.map(c => (
            <button key={c.lead_id} className="list-item" onClick={() => setOpen(c.lead_id)}
              style={{ width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer', background: c.lead_id === open ? 'var(--act-soft)' : 'none' }}>
              <div className="grow"><b>{c.lead_name}</b><div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.direction === 'in' ? '' : 'You: '}{c.body ?? `Template: ${humanize(c.template_name ?? '')}`}</div></div>
              <span className="small faint">{when(c.created_at).replace('Today ', '')}</span>
            </button>))}</div>
          {cur && <div><div style={{ marginBottom: 8 }}><Link to={`/leads/${cur.lead_id}`}><b>{cur.lead_name}</b></Link> <span className="muted num">{cur.primary_phone}</span></div>
            <WhatsAppThread key={cur.lead_id} leadId={cur.lead_id} compact /></div>}
        </div>
      )}
    </>
  );
}
