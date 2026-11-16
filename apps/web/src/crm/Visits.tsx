import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, isoToLocal, Loading, localToIso, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';
import { useMe } from './App';
import { FOLLOW_UP_TYPES } from './MyDay';

export default function Visits() {
  const [range, setRange] = useState<'today' | 'upcoming' | 'past'>('today');
  const q = useLoad<any[]>(() => tenantApi.get(`/site-visits?range=${range}`), [range]);
  const [closing, setClosing] = useState<any>(null);
  const toast = useToast();
  const { me } = useMe();
  async function cancel(v: any) {
    try { await tenantApi.post(`/site-visits/${v.id}/cancel`); toast('Visit cancelled'); q.reload(); } catch (e: any) { toast(e.message, true); }
  }
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Site visits</h1>
        <p>Visits marked verified matched the executive's selfie check-in at the site.</p></div></div>
      <div className="tabs">{(['today', 'upcoming', 'past'] as const).map(r => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{humanize(r)}</button>)}</div>
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : (
        <div className="panel">
          {!q.data ? <Loading /> : !q.data.length ? <Empty title={range === 'past' ? 'No past visits' : 'No visits scheduled'}>Schedule one from a lead's page.</Empty> :
            q.data.map(v => {
              const late = v.status === 'scheduled' && new Date(v.scheduled_at) < new Date(Date.now() - 2 * 3600e3);
              return (
                <div key={v.id} className={`list-item ${late ? 'urgent' : ''}`}>
                  <div className="when">{new Date(v.scheduled_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
                    {range !== 'today' && <div className="small faint" style={{ fontWeight: 400 }}>{new Date(v.scheduled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>}</div>
                  <div className="grow">
                    <Link to={`/leads/${v.lead_id}`}><b>{v.lead_name}</b></Link> <span className="muted">at {v.project}</span>
                    <div className="small muted">{v.executive ?? 'Unassigned'}{v.interest ? `, interest ${v.interest}/5` : ''}{v.notes ? `, ${v.notes}` : ''}</div>
                  </div>
                  {v.status === 'scheduled' ? <>
                    <a className="btn sm" href={`tel:${v.primary_phone}`}>Call</a>
                    {!me.support_session && <button className="btn sm" onClick={() => cancel(v)}>Cancel</button>}
                    {!me.support_session && <button className="btn sm primary" onClick={() => setClosing(v)}>Complete</button>}
                  </> : <span className={`chip ${v.status === 'completed' ? (v.verified ? 'ok' : 'act') : v.status === 'no_show' ? 'bad' : ''}`}>
                    {v.status === 'completed' ? (v.verified ? 'Visited, verified' : 'Visited') : humanize(v.status === 'no_show' ? 'no show' : v.status)}</span>}
                </div>);
            })}
        </div>
      )}
      {closing && <CompleteVisit visit={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); q.reload(); }} />}
    </>
  );
}

function CompleteVisit({ visit, onClose, onDone }: { visit: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const t = new Date(Date.now() + 864e5); t.setHours(11, 0, 0, 0);
  const [outcome, setOutcome] = useState<'completed' | 'no_show'>('completed');
  const [interest, setInterest] = useState(0);
  const [notes, setNotes] = useState('');
  const [nextType, setNextType] = useState('call');
  const [due, setDue] = useState(isoToLocal(t));
  const { busy, error, run } = useSubmit();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post(`/site-visits/${visit.id}/complete`, {
      outcome, interest: outcome === 'completed' && interest ? interest : undefined, notes: notes || undefined,
      next: { type: nextType, due_at: localToIso(due) },
    }));
    if (r) { toast(r.verified ? 'Visit recorded and verified by the on-site check-in' : 'Visit recorded'); onDone(); }
  }
  return (
    <Modal title={`How did ${visit.lead_name}'s visit go?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cv" disabled={busy}>Save</button></>}>
      <form id="cv" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button type="button" className={outcome === 'completed' ? 'on' : ''} onClick={() => setOutcome('completed')}>They came</button>
          <button type="button" className={outcome === 'no_show' ? 'on' : ''} onClick={() => setOutcome('no_show')}>Didn't turn up</button>
        </div>
        {outcome === 'completed' && <Field label="How interested are they?">
          <div className="stars">{[1, 2, 3, 4, 5].map(n => <button type="button" key={n} className={interest >= n ? 'on' : ''} onClick={() => setInterest(n)} aria-label={`${n} of 5`}>{n}</button>)}</div></Field>}
        <Field label="Notes"><textarea className="input" value={notes} onChange={e => setNotes(e.target.value)}
          placeholder={outcome === 'completed' ? 'Liked T2 east-facing; wife wants a higher floor; budget can stretch to 95 L' : 'Phone switched off, try again tomorrow'} /></Field>
        <div className="row">
          <Field label="Next step"><select className="input" value={nextType} onChange={e => setNextType(e.target.value)}>{FOLLOW_UP_TYPES.map(x => <option key={x} value={x}>{humanize(x)}</option>)}</select></Field>
          <Field label="When"><input className="input" type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}

export function ScheduleVisit({ lead, onClose, onDone }: { lead: any; onClose: () => void; onDone: () => void }) {
  const projects = useLoad<any[]>(() => tenantApi.get('/projects'));
  const t = new Date(Date.now() + 864e5); t.setHours(11, 0, 0, 0);
  const [project, setProject] = useState('');
  const [at, setAt] = useState(isoToLocal(t));
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit();
  const active = projects.data?.filter(p => p.status !== 'completed') ?? [];
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => tenantApi.post('/site-visits', { lead_id: lead.id, project_id: project || active[0]?.id, scheduled_at: localToIso(at), note: note || undefined }))) onDone();
  }
  return (
    <Modal title={`Site visit for ${lead.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="sv" disabled={busy || !active.length}>Schedule visit</button></>}>
      <form id="sv" onSubmit={submit}>
        {error && <div className="alert bad">{error.message}</div>}
        {projects.data && !active.length && <div className="alert info">Add a project under Inventory first.</div>}
        <div className="row">
          <Field label="Project"><select className="input" value={project || active[0]?.id || ''} onChange={e => setProject(e.target.value)}>
            {active.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="When"><input className="input" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} /></Field>
        </div>
        <Field label="Note for the executive (optional)"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Coming with family, show the sample flat" /></Field>
        <p className="small muted">The visit becomes the lead's next step and shows in My Day. The executive's selfie check-in at the site verifies it.</p>
      </form>
    </Modal>
  );
}

