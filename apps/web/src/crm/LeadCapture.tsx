import { FormEvent, useState } from 'react';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, Field, humanize, Loading, Modal, useLoad, useSubmit, useToast, when } from '../lib/ui';

const SOURCES = ['website', 'facebook', 'google_ads', 'instagram', '99acres', 'magicbricks', 'housing', 'walk_in', 'referral', 'channel_partner', 'event', 'import'];
const TYPES = ['apartment', 'villa', 'plot', 'commercial', 'office'];

function snippet(key: string) {
  const endpoint = `${location.origin}/api/capture/leads`;
  return `<form id="hxg-enquiry">
  <input name="name" placeholder="Your name" required>
  <input name="phone" placeholder="Mobile number" required>
  <input name="email" type="email" placeholder="Email (optional)">
  <textarea name="message" placeholder="What are you looking for?"></textarea>
  <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px">
  <button type="submit">Send enquiry</button>
</form>
<script>
document.getElementById('hxg-enquiry').addEventListener('submit', async function (e) {
  e.preventDefault();
  var data = Object.fromEntries(new FormData(this));
  var p = new URLSearchParams(location.search);
  ['utm_source','utm_medium','utm_campaign'].forEach(function (k) { if (p.get(k)) data[k] = p.get(k); });
  data.page_url = location.href;
  var r = await fetch('${endpoint}', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': '${key}' }, body: JSON.stringify(data) });
  this.innerHTML = r.ok ? '<p>Thank you. We will call you shortly.</p>' : '<p>Something went wrong. Please call us.</p>';
});
</script>`;
}

export function ApiKeys() {
  const toast = useToast();
  const keys = useLoad<any[]>(() => tenantApi.get('/api-keys'));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<any>(null);
  const { busy, error, run } = useSubmit();
  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => tenantApi.post('/api-keys', { name }));
    if (r) { setFresh(r); setCreating(false); setName(''); keys.reload(); }
  }
  async function revoke(k: any) {
    try { await tenantApi.post(`/api-keys/${k.id}/revoke`); toast(`${k.name} revoked. Forms using it stop working now.`); keys.reload(); }
    catch (e: any) { toast(e.message, true); }
  }
  const copy = (t: string, w: string) => { navigator.clipboard.writeText(t); toast(`${w} copied`); };
  if (keys.error) return <ErrorState error={keys.error} retry={keys.reload} />;
  return (
    <>
      <div className="section-head"><h3>Website forms</h3><span className="grow" /><button className="btn sm" onClick={() => setCreating(true)}>New form key</button></div>
      <p className="muted small" style={{ marginBottom: 10 }}>Each key lets one website send enquiries straight into your leads. It can only create leads, nothing else, and you can revoke it any time.</p>
      <div className="panel">
        {!keys.data ? <Loading /> : !keys.data.length ? <Empty title="No website forms yet">Create a key, then paste the form on your site.</Empty> :
          keys.data.map(k => (
            <div key={k.id} className="list-item">
              <div className="grow"><b>{k.name}</b> <span className="faint num">hxgk_{k.prefix}_…</span>
                <div className="small muted">{k.revoked_at ? `Revoked ${when(k.revoked_at).toLowerCase()}` : k.last_used_at ? `Last lead ${when(k.last_used_at).toLowerCase()}` : 'No leads yet'}, tagged "{humanize(k.default_source)}"</div></div>
              {k.revoked_at ? <span className="chip">Revoked</span> : <button className="btn sm danger" onClick={() => revoke(k)}>Revoke</button>}
            </div>))}
      </div>
      {creating && (
        <Modal title="New website form key" onClose={() => setCreating(false)}
          footer={<><button className="btn" onClick={() => setCreating(false)}>Cancel</button><button className="btn primary" form="key" disabled={busy || name.trim().length < 2}>Create key</button></>}>
          <form id="key" onSubmit={create}>
            {error && <div className="alert bad">{error.message}</div>}
            <Field label="Which website or form is this for?"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="sunriseheights.in contact form" autoFocus /></Field>
          </form>
        </Modal>
      )}
      {fresh && (
        <Modal title="Your form is ready" wide onClose={() => setFresh(null)} footer={<button className="btn primary" onClick={() => setFresh(null)}>Done</button>}>
          <div className="alert info">Copy this now. For your security the key is never shown again; if it's lost, revoke it and make a new one.</div>
          <Field label="API key"><div className="row"><input className="input num" readOnly value={fresh.key} onFocus={e => e.target.select()} />
            <button className="btn" style={{ flex: 'none' }} onClick={() => copy(fresh.key, 'Key')}>Copy</button></div></Field>
          <Field label="Paste this on your website" hint="Style it to match your site. The hidden field catches spam bots; leave it in.">
            <textarea className="input num" readOnly rows={12} style={{ fontSize: 12 }} value={snippet(fresh.key)} onFocus={e => e.target.select()} /></Field>
          <button className="btn" onClick={() => copy(snippet(fresh.key), 'Form code')}>Copy form code</button>
        </Modal>
      )}
    </>
  );
}

// =====================================================================
export function AssignmentRules() {
  const toast = useToast();
  const rules = useLoad<any[]>(() => tenantApi.get('/assignment-rules'));
  const users = useLoad<any[]>(() => tenantApi.get('/users'));
  const [editing, setEditing] = useState<any>(null);
  if (rules.error) return <ErrorState error={rules.error} retry={rules.reload} />;
  const people = (users.data ?? []).filter(u => u.status === 'active' && !['finance', 'marketing', 'support'].includes(u.role));

  async function move(i: number, d: -1 | 1) {
    const ids = rules.data!.map(r => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { await tenantApi.post('/assignment-rules/reorder', { ids }); rules.reload(); } catch (e: any) { toast(e.message, true); }
  }
  async function toggle(r: any) {
    try { await tenantApi.patch(`/assignment-rules/${r.id}`, { enabled: !r.enabled }); rules.reload(); } catch (e: any) { toast(e.message, true); }
  }
  const summary = (c: any) => [
    c.sources?.length && `from ${c.sources.map(humanize).join(' or ')}`,
    c.property_types?.length && `wanting ${c.property_types.join(' or ')}`,
    c.locations?.length && `in ${c.locations.join(' or ')}`,
    (c.budget_min || c.budget_max) && `budget ${c.budget_min ? `₹${c.budget_min / 1e5} L` : 'any'} to ${c.budget_max ? `₹${c.budget_max / 1e5} L` : 'any'}`,
  ].filter(Boolean).join(', ') || 'every new lead';

  return (
    <>
      <div className="section-head"><h3>Who gets new leads</h3><span className="grow" /><button className="btn sm" onClick={() => setEditing({})}>Add rule</button></div>
      <p className="muted small" style={{ marginBottom: 10 }}>Rules are checked top to bottom and the first match wins. Leads rotate through the people in a rule. Anything no rule matches goes to the executive with the fewest open leads.</p>
      <div className="panel">
        {!rules.data ? <Loading /> : !rules.data.length ? <Empty title="No rules yet">New leads go to whichever executive has the fewest open leads.</Empty> :
          rules.data.map((r, i) => (
            <div key={r.id} className="list-item" style={{ opacity: r.enabled ? 1 : 0.55 }}>
              <span className="num faint" style={{ width: 18 }}>{i + 1}</span>
              <div className="grow"><b>{r.name}</b>{!r.enabled && <span className="faint"> (paused)</span>}
                <div className="small muted">For {summary(r.conditions)}: {(r.assignee_names ?? []).join(', ')}</div></div>
              <button className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button className="btn sm ghost" disabled={i === rules.data!.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
              <button className="btn sm" onClick={() => toggle(r)}>{r.enabled ? 'Pause' : 'Resume'}</button>
              <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>
            </div>))}
      </div>
      {editing && <RuleEditor rule={editing} people={people} onClose={() => setEditing(null)} onDone={() => { setEditing(null); rules.reload(); }} />}
    </>
  );
}

function RuleEditor({ rule, people, onClose, onDone }: { rule: any; people: any[]; onClose: () => void; onDone: () => void }) {
  const c = rule.conditions ?? {};
  const [name, setName] = useState(rule.name ?? '');
  const [sources, setSources] = useState<string[]>(c.sources ?? []);
  const [types, setTypes] = useState<string[]>(c.property_types ?? []);
  const [locations, setLocations] = useState((c.locations ?? []).join(', '));
  const [bmin, setBmin] = useState(c.budget_min ? String(c.budget_min / 1e5) : '');
  const [bmax, setBmax] = useState(c.budget_max ? String(c.budget_max / 1e5) : '');
  const [who, setWho] = useState<string[]>(rule.assignee_ids ?? []);
  const { busy, error, run } = useSubmit();
  const flip = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { name, assignee_ids: who, conditions: {
      sources, property_types: types, locations: locations.split(',').map((s: string) => s.trim()).filter(Boolean),
      ...(bmin && { budget_min: Math.round(Number(bmin) * 1e5) }), ...(bmax && { budget_max: Math.round(Number(bmax) * 1e5) }) } };
    if (await run(() => rule.id ? tenantApi.patch(`/assignment-rules/${rule.id}`, body) : tenantApi.post('/assignment-rules', body))) onDone();
  }
  async function remove() { if (await run(() => tenantApi.del(`/assignment-rules/${rule.id}`))) onDone(); }

  const chips = (all: string[], sel: string[], set: (v: string[]) => void, label: (v: string) => string = humanize) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{all.map(v => (
      <button type="button" key={v} className={`btn sm ${sel.includes(v) ? 'primary' : ''}`} onClick={() => flip(sel, set, v)}>{label(v)}</button>))}</div>);

  return (
    <Modal title={rule.id ? 'Edit rule' : 'New assignment rule'} onClose={onClose} wide
      footer={<>{rule.id && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete rule</button>}
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="rule" disabled={busy || name.trim().length < 2 || !who.length}>Save rule</button></>}>
      <form id="rule" onSubmit={save}>
        {error && <div className="alert bad">{error.message}</div>}
        <Field label="Rule name"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Facebook leads for Sunrise Heights" autoFocus /></Field>
        <Field label="When the lead came from" hint="None selected = any source">{chips(SOURCES, sources, setSources)}</Field>
        <Field label="And wants" hint="None selected = any type">{chips(TYPES, types, setTypes)}</Field>
        <div className="row">
          <Field label="In locations" hint="Comma separated; partial match"><input className="input" value={locations} onChange={e => setLocations(e.target.value)} placeholder="Indirapuram, Noida" /></Field>
          <Field label="Budget from (₹ lakh)"><input className="input" inputMode="decimal" value={bmin} onChange={e => setBmin(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          <Field label="Budget to (₹ lakh)"><input className="input" inputMode="decimal" value={bmax} onChange={e => setBmax(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        </div>
        <Field label="Give them to, in turn" hint="Leads rotate through these people. Anyone deactivated is skipped.">
          {chips(people.map(p => p.id), who, setWho, id => people.find(p => p.id === id)?.name ?? 'Former member')}
        </Field>
      </form>
    </Modal>
  );
}
