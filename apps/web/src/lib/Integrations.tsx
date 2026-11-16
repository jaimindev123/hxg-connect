import { FormEvent, useState } from 'react';
import { api, Realm } from './api';
import { Field, humanize, Loading, Modal, ErrorState, useLoad, useSubmit, useToast, when } from './ui';

const CATEGORY: Record<string, string> = { lead_sources: 'Lead sources', calling: 'Calling', whatsapp: 'WhatsApp', payments: 'Payments', email: 'Email' };
const STATUS: Record<string, [string, string]> = {
  not_configured: ['Not set up', ''], saved: ['Saved, not verified', 'warn'], connected: ['Connected', 'ok'], error: ['Needs attention', 'bad'],
};

/** Keys for third-party services, entered and changed here at any time.
 *  Used by both the client's settings and the platform console. */
export function Integrations({ realm, readOnly }: { realm: Realm; readOnly?: boolean }) {
  const base = realm === 'tenant' ? '/integrations' : '/platform/integrations';
  const list = useLoad<any[]>(() => api(realm, 'GET', base));
  const [editing, setEditing] = useState<any>(null);
  const toast = useToast();
  if (list.error) return <ErrorState error={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;

  const groups = Array.from(new Set(list.data.map(i => i.category)));
  async function activate(i: any) {
    try { await api(realm, 'PUT', `${base}/${i.provider}`, { enabled: true }); toast(`${i.label} is now the active calling provider`); list.reload(); }
    catch (e: any) { toast(e.message, true); }
  }

  return (
    <>
      {groups.map(g => (
        <div key={g} className="section">
          <div className="section-head"><h3>{CATEGORY[g] ?? humanize(g)}</h3>
            {g === 'calling' && <span className="muted small">One provider is active at a time.</span>}</div>
          <div className="panel">
            {list.data!.filter(i => i.category === g).map(i => {
              const [label, tone] = STATUS[i.status] ?? STATUS.saved;
              return (
                <div key={i.provider} className="list-item">
                  <div className="grow">
                    <b>{i.label}</b>{' '}
                    {i.exclusive && i.configured && i.enabled && <span className="chip act">Active</span>}
                    <div className="small muted">{i.description}</div>
                    {i.status === 'error' && i.last_error && <div className="small overdue-text">{i.last_error}</div>}
                  </div>
                  <span className={`chip ${tone}`}>{label}</span>
                  {!readOnly && i.exclusive && i.configured && !i.enabled && <button className="btn sm" onClick={() => activate(i)}>Make active</button>}
                  {!readOnly && <button className={`btn sm ${i.configured ? '' : 'primary'}`} onClick={() => setEditing(i)}>{i.configured ? 'Edit' : 'Set up'}</button>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {editing && <Editor realm={realm} base={base} item={editing}
        onClose={() => setEditing(null)} onChanged={() => list.reload()} />}
    </>
  );
}

function Editor({ realm, base, item, onClose, onChanged }: { realm: Realm; base: string; item: any; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState<any>(item);
  const [cfg, setCfg] = useState<Record<string, string>>(() => ({ ...item.config }));
  const [sec, setSec] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean | null; detail: string } | null>(null);
  const { busy, error, run } = useSubmit();
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function saveAndTest(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    const saved = await run(() => api(realm, 'PUT', `${base}/${item.provider}`, { config: cfg, secrets: sec }));
    if (!saved) return;
    setSec({}); setCur(saved); onChanged();
    const tested = await run(() => api(realm, 'POST', `${base}/${item.provider}/test`));
    if (tested) { setCur(tested); setResult(tested.result); onChanged(); }
  }
  async function remove() {
    if (await run(() => api(realm, 'DELETE', `${base}/${item.provider}`))) { toast(`${item.label} disconnected`); onChanged(); onClose(); }
  }
  const copy = (text: string, what: string) => { navigator.clipboard.writeText(text); toast(`${what} copied`); };

  return (
    <Modal title={`${item.label}`} onClose={onClose} wide
      footer={<>
        {cur.configured && (confirmRemove
          ? <><span className="small" style={{ marginRight: 'auto' }}>Remove these keys? Features using {item.label} stop working.</span>
              <button className="btn" onClick={() => setConfirmRemove(false)}>Keep</button><button className="btn danger" onClick={remove} disabled={busy}>Remove keys</button></>
          : <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => setConfirmRemove(true)}>Disconnect</button>)}
        {!confirmRemove && <><button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" form="integration" disabled={busy}>{busy ? 'Checking…' : cur.configured ? 'Save and test' : 'Save and connect'}</button></>}
      </>}>
      <p className="muted" style={{ marginBottom: 12 }}>{item.description}{item.docs && <> <a href={item.docs} target="_blank" rel="noreferrer">Where to find these keys</a></>}</p>
      {result && <div className={`alert ${result.ok === true ? 'ok' : result.ok === false ? 'bad' : 'info'}`}>{result.detail}</div>}
      {!result && cur.status === 'error' && cur.last_error && <div className="alert bad">{cur.last_error}</div>}
      {error && !error.issues.length && <div className="alert bad">{error.message}</div>}
      <form id="integration" onSubmit={saveAndTest} autoComplete="off">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', columnGap: 14 }}>
          {item.fields.map((f: any) => {
            const path = `${f.secret ? 'secrets' : 'config'}.${f.key}`;
            const stored = f.secret ? cur.secrets[f.key] : null;
            return (
              <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} error={error?.field(path)}
                hint={f.secret && stored ? `Saved as ${stored}. Leave blank to keep it.` : f.help ?? f.patternHint}>
                {f.options ? (
                  <select className="input" value={cfg[f.key] ?? ''} onChange={e => setCfg({ ...cfg, [f.key]: e.target.value })}>
                    <option value="">Choose…</option>{f.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.secret ? (
                  <input className="input" type="password" autoComplete="new-password" spellCheck={false}
                    placeholder={stored ? 'Unchanged' : ''} value={sec[f.key] ?? ''} onChange={e => setSec({ ...sec, [f.key]: e.target.value })} />
                ) : (
                  <input className="input" spellCheck={false} placeholder={f.placeholder} value={cfg[f.key] ?? ''}
                    onChange={e => setCfg({ ...cfg, [f.key]: e.target.value })} />
                )}
              </Field>
            );
          })}
        </div>
      </form>
      {cur.webhook && item.provider === 'property_portals' && <PortalSetup hook={cur.webhook} />}
      {cur.webhook && item.provider === 'lead_connectors' && <ConnectorSetup hook={cur.webhook} enabled={cur.enabled} />}
      {cur.webhook && !['property_portals', 'lead_connectors'].includes(item.provider) && (
        <div className="next-box" style={{ margin: '4px 0 12px' }}>
          <h3 style={{ marginBottom: 4 }}>Webhook</h3>
          <p className="small muted" style={{ marginBottom: 10 }}>
            {({
              whatsapp_cloud: 'In your Meta app, open WhatsApp > Configuration, paste this URL and verify token, and subscribe to messages.',
              facebook_leads: 'In your Meta app, open Webhooks > Page, paste this URL and verify token, and subscribe to the leadgen field. Then connect the app to your Page in Lead Ads settings.',
              google_ads_leads: 'In Google Ads, open your lead form asset, choose Webhook integration, paste the URL and the key, then press Send test data.',
              exotel: 'Click-to-call sends this address with every call, so outgoing calls need nothing more. For incoming and missed calls, add it as the status callback (Passthru) on your ExoPhone\'s call flow.',
              twilio: 'Click-to-call sends this address with every call. For incoming calls, set it as the status callback URL on your Twilio number. Requests are checked against your auth token.',
              knowlarity: 'Paste this as the call-status webhook in your Knowlarity dashboard so incoming and missed calls are logged on the right lead.',
              myoperator: 'Paste this as the call webhook in your MyOperator panel so incoming and missed calls are logged on the right lead.',
            } as Record<string, string>)[item.provider] ?? 'In Razorpay, open Settings > Webhooks, add this URL with the same webhook secret as above, and tick payment_link.paid.'}</p>
          <div className="row" style={{ marginBottom: 8 }}><input className="input" readOnly value={cur.webhook.url} onFocus={e => e.target.select()} />
            <button className="btn" style={{ flex: 'none' }} onClick={() => copy(cur.webhook.url, 'URL')}>Copy URL</button></div>
          {cur.webhook.verify_token && <div className="row"><input className="input" readOnly value={cur.webhook.verify_token} onFocus={e => e.target.select()} />
            <button className="btn" style={{ flex: 'none' }} onClick={() => copy(cur.webhook.verify_token, item.provider === 'google_ads_leads' ? 'Key' : 'Verify token')}>{item.provider === 'google_ads_leads' ? 'Copy key' : 'Copy token'}</button></div>}
          {!cur.webhook.https && <p className="small overdue-text" style={{ marginTop: 8 }}>
            This server isn't on HTTPS yet, and {({ google_ads_leads: 'Google', razorpay: 'Razorpay', exotel: 'Exotel', twilio: 'Twilio', knowlarity: 'Knowlarity', myoperator: 'MyOperator' } as Record<string, string>)[item.provider] ?? 'Meta'} only accepts HTTPS addresses. Your keys are saved; finish this step once your domain and certificate are live.</p>}
        </div>
      )}
      {cur.last_tested_at && <p className="small faint">Last checked {when(cur.last_tested_at).toLowerCase()}.</p>}
    </Modal>
  );
}

const PORTALS: [string, string][] = [['99acres', '99acres'], ['magicbricks', 'MagicBricks'], ['housing', 'Housing.com'], ['nobroker', 'NoBroker'],
  ['squareyards', 'Square Yards'], ['commonfloor', 'CommonFloor'], ['proptiger', 'PropTiger'], ['makaan', 'Makaan'], ['other_portal', 'Any other portal']];

/** Property portals: forward their emails (works with every portal), or have one push leads directly. */
function PortalSetup({ hook }: { hook: { url: string; email?: string; https: boolean } }) {
  const toast = useToast();
  const review = useLoad<any[]>(() => api('tenant', 'GET', '/portal-leads/review'));
  const log = useLoad<any[]>(() => api('tenant', 'GET', '/portal-leads/deliveries'));
  const [testing, setTesting] = useState('');
  async function sendTest(id: string, n: string) {
    setTesting(id);
    try { const r = await api('tenant', 'POST', `/portal-leads/test/${id}`); toast(r.status === 'success' ? `Test lead from ${n}: ${r.message.toLowerCase()}. It's tagged "test".` : r.message); log.reload(); review.reload(); }
    catch (e: any) { toast(e.message, true); } finally { setTesting(''); }
  }
  const mailto = (url: string, n: string) => `mailto:?subject=${encodeURIComponent(`Real-time lead push from ${n} to our CRM`)}&body=${encodeURIComponent(
    `Hi,\n\nPlease set up real-time lead push from ${n} for our account to our CRM (HXG Connect).\n\nWebhook URL: ${url}\nMethod: POST, JSON or form data, with your standard lead fields (name, mobile, email, project, query).\nReply when a lead is accepted: HTTP 200 {"status":"success"}. If a lead can't be read: HTTP 422 {"status":"failed","message":"..."}.\n\nPlease send a test lead once it's configured.\n\nThanks`)}`;
  const copy = (t: string, w: string) => { navigator.clipboard.writeText(t); toast(`${w} copied`); };
  const gmail = review.data?.find(r => r.event_type === 'gmail_forwarding_confirmation');
  const stuck = review.data?.filter(r => r.event_type !== 'gmail_forwarding_confirmation') ?? [];
  return (
    <>
      <div className="next-box" style={{ margin: '4px 0 12px' }}>
        <h3 style={{ marginBottom: 4 }}>Forward portal emails (works with every portal)</h3>
        {hook.email ? <>
          <p className="small muted" style={{ marginBottom: 10 }}>In the inbox that receives portal enquiries, add a filter for emails from 99acres, MagicBricks, Housing.com and the others, and forward them to this address. Each enquiry becomes a lead within seconds.</p>
          <div className="row"><input className="input" readOnly value={hook.email} onFocus={e => e.target.select()} /><button className="btn" style={{ flex: 'none' }} onClick={() => copy(hook.email!, 'Address')}>Copy address</button></div>
          {gmail && <div className="alert info" style={{ marginTop: 10 }}><b>Gmail is asking you to confirm this address.</b> {gmail.excerpt}</div>}
        </> : <p className="small muted">Email forwarding isn't switched on for HXG Connect yet. Ask your HXG Connect contact; direct push below works meanwhile.</p>}
      </div>
      <div className="next-box" style={{ marginBottom: 12 }}>
        <h3 style={{ marginBottom: 4 }}>Direct push (when a portal offers CRM integration)</h3>
        <p className="small muted" style={{ marginBottom: 10 }}>Portals like 99acres and MagicBricks set this up on their side: email your account manager the address for that portal, then ask them for a test lead and watch it arrive below. Leads arrive instantly; the same buyer from two portals stays one lead.</p>
        {PORTALS.map(([id, n]) => { const url = hook.url.replace('{portal}', id); return (
          <div key={id} className="row" style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small" style={{ flex: 'none', width: 120 }}><b>{n}</b></span>
            <input className="input" readOnly value={url} onFocus={e => e.target.select()} style={{ minWidth: 220 }} />
            <button className="btn sm" style={{ flex: 'none' }} onClick={() => copy(url, `${n} address`)}>Copy</button>
            <a className="btn sm" style={{ flex: 'none' }} href={mailto(url, n)}>Email account manager</a>
            <button className="btn sm" style={{ flex: 'none' }} disabled={testing === id} onClick={() => sendTest(id, n)}>{testing === id ? 'Sending…' : 'Send test'}</button>
          </div>); })}
        {!hook.https && <p className="small overdue-text" style={{ marginTop: 6 }}>Portals need an https:// address, available once your domain is live.</p>}
      </div>
      {!!log.data?.length && (
        <div className="next-box" style={{ marginBottom: 12 }}>
          <h3 style={{ marginBottom: 6 }}>Recent deliveries</h3>
          {log.data.slice(0, 12).map(d => (
            <div key={d.id} className="small" style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--line)', padding: '6px 0' }}>
              <span style={{ width: 110, flex: 'none' }}>{PORTALS.find(p => p[0] === d.portal)?.[1] ?? d.portal ?? 'Portal'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{d.summary ?? d.reason}{String(d.event_type).startsWith('test:') && <span className="faint"> (test)</span>}</span>
              <span className={`chip ${d.processed ? (d.result === 'duplicate' ? 'act' : 'ok') : 'bad'}`}>{d.processed ? (d.result === 'duplicate' ? 'Existing lead' : 'Added') : 'Needs review'}</span>
              <span className="faint" style={{ flex: 'none' }}>{when(d.received_at)}</span>
            </div>))}
        </div>)}
      {stuck.length > 0 && (
        <div className="next-box urgent" style={{ marginBottom: 12 }}>
          <h3 style={{ marginBottom: 6 }}>Couldn't be read automatically ({stuck.length})</h3>
          <p className="small muted" style={{ marginBottom: 8 }}>Add these by hand from Leads. Nothing is deleted.</p>
          {stuck.slice(0, 10).map(r => (
            <div key={r.id} className="small" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <b>{r.subject || 'Portal enquiry'}</b> <span className="muted">{r.from}, {when(r.received_at)}</span>
              <div className="muted">{r.reason}</div>{r.excerpt && <div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{r.excerpt.slice(0, 240)}</div>}
            </div>))}
        </div>)}
    </>
  );
}


const GUIDE = '/integration-guide.html';
const PLUGIN = '/downloads/hxg-connect-leads.zip';

/** Websites, marketplaces, form tools and automation tools: pick a platform,
 *  follow its steps, send a test, and watch real deliveries arrive. */
function ConnectorSetup({ hook, enabled }: { hook: { url: string; https: boolean }; enabled: boolean }) {
  const toast = useToast();
  const sources = useLoad<any[]>(() => api('tenant', 'GET', '/lead-connectors/sources'));
  const log = useLoad<any[]>(() => api('tenant', 'GET', '/lead-connectors/deliveries'));
  const [pick, setPick] = useState('wordpress');
  const [testing, setTesting] = useState(false);
  if (!sources.data) return <Loading />;
  const src = sources.data.find(s => s.id === pick) ?? sources.data[0];
  const url = hook.url.replace('{source}', src.id);
  const groups = Array.from(new Set(sources.data.map(s => s.group)));
  const nameOf = (id: string) => sources.data!.find(s => s.id === id)?.name ?? humanize(id ?? 'platform');
  const copy = () => { navigator.clipboard.writeText(url); toast(`${src.name} address copied`); };
  async function sendTest() {
    setTesting(true);
    try { const r = await api('tenant', 'POST', `/lead-connectors/test/${src.id}`); toast(r.status === 'success' ? `Test lead from ${src.name}: ${r.message.toLowerCase()}. It's tagged "test".` : r.message, r.status !== 'success'); log.reload(); }
    catch (e: any) { toast(e.message, true); } finally { setTesting(false); }
  }
  const mailto = `mailto:?subject=${encodeURIComponent(`Lead push from ${src.name} to our CRM`)}&body=${encodeURIComponent(
    `Hi,\n\nPlease set up real-time lead push from ${src.name} for our account to our CRM (HXG Connect).\n\nURL: ${url}\nMethod: GET or POST with your standard lead fields (name, mobile, email, city, category).\nA 200 reply means the lead was received.\n\nPlease send a test lead once it's configured.\n\nThanks`)}`;
  const stuck = log.data?.filter(d => !d.processed) ?? [];
  return (
    <>
      <div className="next-box" style={{ margin: '4px 0 12px' }}>
        <h3 style={{ marginBottom: 4 }}>Connect a platform</h3>
        <p className="small muted" style={{ marginBottom: 10 }}>Each platform gets its own address. Field names don't need mapping: "Phone", "Mobile No." and "your-tel" are all understood. The same buyer arriving twice stays one lead.</p>
        <div className="field" style={{ marginBottom: 10 }}><label htmlFor="conn-src">Platform</label>
          <select id="conn-src" className="input" value={src.id} onChange={e => setPick(e.target.value)}>
            {groups.map(g => <optgroup key={g} label={g}>{sources.data!.filter(s => s.group === g).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
          </select></div>
        <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          <input className="input" readOnly value={url} onFocus={e => e.target.select()} style={{ minWidth: 220 }} aria-label={`${src.name} address`} />
          <button className="btn" style={{ flex: 'none' }} onClick={copy}>Copy address</button>
          {src.setup === 'account_manager' && <a className="btn" style={{ flex: 'none' }} href={mailto}>Email account manager</a>}
          <button className="btn" style={{ flex: 'none' }} disabled={testing || !enabled} onClick={sendTest}>{testing ? 'Sending…' : 'Send test'}</button>
        </div>
        <ol className="small" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 4 }}>
          {src.steps.map((st: string, i: number) => <li key={i}>{st}</li>)}
        </ol>
        <p className="small" style={{ marginTop: 10 }}>
          {src.id === 'wordpress' && <><a href={PLUGIN} download>Download the WordPress plugin</a> · </>}
          <a href={`${GUIDE}#${src.id}`} target="_blank" rel="noreferrer">Open the integration guide</a>
          <span className="muted"> for examples, field names and a page you can send to a developer.</span></p>
        <p className="small muted" style={{ marginTop: 6 }}>Treat each address like a password: anyone who has it can add leads. If one leaks, press Disconnect and set this up again to get new addresses.</p>
        {!hook.https && <p className="small overdue-text" style={{ marginTop: 6 }}>Most platforms only send to an https:// address, available once your domain is live.</p>}
      </div>
      {!!log.data?.length && (
        <div className="next-box" style={{ marginBottom: 12 }}>
          <h3 style={{ marginBottom: 6 }}>Recent deliveries</h3>
          {log.data.slice(0, 12).map(d => (
            <div key={d.id} className="small" style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--line)', padding: '6px 0' }}>
              <span style={{ width: 110, flex: 'none' }}>{nameOf(d.source)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{d.summary ?? d.reason}{String(d.event_type).startsWith('test:') && <span className="faint"> (test)</span>}</span>
              <span className={`chip ${d.processed ? (d.result === 'duplicate' ? 'act' : 'ok') : 'bad'}`}>{d.processed ? (d.result === 'duplicate' ? 'Existing lead' : 'Added') : 'Needs review'}</span>
              <span className="faint" style={{ flex: 'none' }}>{when(d.received_at)}</span>
            </div>))}
        </div>)}
      {stuck.length > 0 && (
        <div className="next-box urgent" style={{ marginBottom: 12 }}>
          <h3 style={{ marginBottom: 6 }}>Couldn't be added ({stuck.length})</h3>
          <p className="small muted" style={{ marginBottom: 8 }}>Usually a form with no phone number field. Add these by hand from Leads, then make the phone field required on that form.</p>
          {stuck.slice(0, 8).map(r => (
            <div key={r.id} className="small" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <b>{nameOf(r.source)}</b> <span className="muted">{when(r.received_at)}</span>
              <div className="muted">{r.reason}</div>{r.excerpt && <div className="faint" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.excerpt.slice(0, 300)}</div>}
            </div>))}
        </div>)}
    </>
  );
}
