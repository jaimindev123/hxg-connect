import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { tenantApi } from '../lib/api';
import { useClickToCall } from './Comms';
import { Empty, ErrorState, Field, humanize, isoToLocal, Loading, localToIso, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';

export const FOLLOW_UP_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'site_visit'] as const;

export default function MyDay() {
  const q = useLoad<any[]>(() => tenantApi.get('/follow-ups/my-day'));
  const [closing, setClosing] = useState<any>(null);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;

  const overdue = q.data?.filter(f => f.overdue) ?? [];
  const today = q.data?.filter(f => !f.overdue) ?? [];

  return (
    <>
      <div className="page-head"><div className="grow"><h1>My day</h1>
        <p>{q.data ? `${overdue.length} overdue, ${today.length} still to do today` : 'Loading your queue'}</p></div></div>
      {!q.data ? <Loading /> : !q.data.length ? (
        <div className="panel"><Empty title="You're clear for today">Follow-ups you schedule on a lead show up here on the day they're due.</Empty></div>
      ) : (
        <>
          {overdue.length > 0 && <Queue title="Overdue" items={overdue} onDone={setClosing} />}
          {today.length > 0 && <Queue title="Later today" items={today} onDone={setClosing} />}
        </>
      )}
      {closing && <CompleteFollowUp followUp={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); q.reload(); }} />}
    </>
  );
}

function Queue({ title, items, onDone }: { title: string; items: any[]; onDone: (f: any) => void }) {
  const dialer = useClickToCall();
  return (
    <div className="section">
      <div className="section-head"><h2>{title}</h2><span className="muted small">{items.length}</span></div>
      <div className="panel">
        {items.map(f => (
          <div key={f.id} className={`list-item ${f.overdue ? 'urgent' : ''}`}>
            <div className={`when ${f.overdue ? 'overdue-text' : ''}`}>{f.overdue ? when(f.due_at) : new Date(f.due_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</div>
            <div className="grow">
              <div><b>{humanize(f.type)}</b> <Link to={`/leads/${f.lead_id}`}>{f.lead_name}</Link> <span className="chip">{f.stage}</span></div>
              {f.note && <div className="small muted">{f.note}</div>}
            </div>
            <button className="btn sm" onClick={() => dialer.call(f.lead_id, f.primary_phone)}>Call</button>
            <a className="btn sm" href={`https://wa.me/${f.primary_phone.replace('+', '')}`} target="_blank" rel="noreferrer">WhatsApp</a>
            <button className="btn sm primary" onClick={() => onDone(f)}>Done</button>
          </div>
        ))}
      </div>
      {dialer.prompt}
    </div>
  );
}

/** Closing a follow-up asks what happened and what's next. The next step is
 *  optional in the form but the API insists unless something else is pending. */
export function CompleteFollowUp({ followUp, onClose, onDone }: { followUp: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const tomorrow = new Date(Date.now() + 864e5); tomorrow.setHours(11, 0, 0, 0);
  const [outcome, setOutcome] = useState('');
  const [scheduleNext, setScheduleNext] = useState(true);
  const [type, setType] = useState<string>('call');
  const [due, setDue] = useState(isoToLocal(tomorrow));
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: any = { outcome };
    if (scheduleNext) body.next = { type, due_at: localToIso(due), note: note || undefined };
    const r = await run(() => tenantApi.post(`/follow-ups/${followUp.id}/complete`, body));
    if (r) { toast(scheduleNext ? `Done. Next ${humanize(type).toLowerCase()} ${when(localToIso(due)).toLowerCase()}` : 'Done'); onDone(); }
  }
  const needsNext = error?.code === 'next_action_required';
  useEffect(() => { if (needsNext) setScheduleNext(true); }, [needsNext]);

  return (
    <Modal title={`Complete ${humanize(followUp.type).toLowerCase()}${followUp.lead_name ? ` with ${followUp.lead_name}` : ''}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="complete-fu" disabled={busy || outcome.trim().length < 2}>{busy ? 'Saving…' : 'Complete'}</button></>}>
      <form id="complete-fu" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <Field label="What happened?"><textarea className="input" value={outcome} onChange={e => setOutcome(e.target.value)} placeholder="Spoke to him, wants a corner unit, visiting Saturday with his wife" autoFocus /></Field>
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input type="checkbox" checked={scheduleNext} onChange={e => setScheduleNext(e.target.checked)} /> Schedule the next step
        </label>
        {scheduleNext && (
          <div className="row">
            <Field label="Next step"><select className="input" value={type} onChange={e => setType(e.target.value)}>{FOLLOW_UP_TYPES.map(t => <option key={t} value={t}>{humanize(t)}</option>)}</select></Field>
            <Field label="When"><input className="input" type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></Field>
          </div>
        )}
        {scheduleNext && <Field label="Note for next time (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>}
      </form>
    </Modal>
  );
}
