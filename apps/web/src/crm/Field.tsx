import { useEffect, useRef, useState } from 'react';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, humanize, initials, Loading, useLoad, useToast, when } from '../lib/ui';
import { isManager, useMe } from './App';

const TYPES = [
  ['day_start', 'Start my day'], ['site_visit_in', 'Arrived at site'], ['site_visit_out', 'Leaving site'],
  ['meeting', 'Client meeting'], ['adhoc', 'Share my location'], ['day_end', 'End my day'],
] as const;
const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/** Browsers hand the camera and location only to https:// pages (and to
 *  localhost). On a plain http:// address both are refused before anyone is
 *  asked, which used to surface as "No camera found". Say the real reason. */
const isSecure = () => typeof window === 'undefined' || window.isSecureContext !== false;
const NEEDS_HTTPS = 'Check-ins need the https:// address. Phones only share the camera and location with secure pages.';

function cameraProblem(e: any): string {
  switch (e?.name) {
    case 'NotAllowedError': return 'Camera permission was blocked. Allow it in your browser settings to check in.';
    case 'NotFoundError': case 'OverconstrainedError': return 'No front camera found on this device.';
    case 'NotReadableError': return 'The camera is busy in another app. Close that app and try again.';
    case 'SecurityError': return NEEDS_HTTPS;
    default: return 'The camera couldn\'t be opened in this browser. Try Chrome or Safari.';
  }
}
const FLAG_TEXT: Record<string, string> = {
  low_accuracy: 'Weak GPS', no_accuracy: 'No GPS accuracy', late_sync: 'Sent late', mock_location: 'Possible fake GPS',
};

export default function FieldPage() {
  const { me } = useMe();
  if (!me.features.field_tracking) return (
    <div className="panel"><Empty title="Field tracking isn't in your plan">
      Selfie check-ins and live team locations come with the Growth plan and above. Your account owner can upgrade.</Empty></div>
  );
  const manager = isManager(me.user.role);
  return (
    <>
      <div className="page-head"><div className="grow"><h1>Field team</h1>
        <p>{manager ? 'Where your team is today, from their selfie check-ins.' : 'Check in with a selfie. Your manager sees it straight away.'}</p></div></div>
      <div className="grid-2">
        <div>{manager ? <TeamBoard /> : <MyCheckins />}</div>
        <div><CheckIn /></div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
function CheckIn() {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [pos, setPos] = useState<GeolocationPosition | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string; at: string } | null>(null);
  const [type, setType] = useState<string>('day_start');
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => () => { stream.current?.getTracks().forEach(t => t.stop()); }, []);
  useEffect(() => {
    if (!shot && video.current && stream.current && video.current.srcObject !== stream.current) {
      video.current.srcObject = stream.current;
      video.current.play().catch(() => undefined);
    }
  }, [shot, on]);

  async function start() {
    setCamErr(null); setGeoErr(null); setOn(true);
    if (!isSecure()) { setCamErr(NEEDS_HTTPS); setGeoErr(NEEDS_HTTPS); return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 } }, audio: false });
      if (video.current) { video.current.srcObject = stream.current; await video.current.play(); }
    } catch (e: any) {
      setCamErr(cameraProblem(e));
    }
    if (!navigator.geolocation) { setGeoErr('This browser can\'t share location.'); return; }
    navigator.geolocation.getCurrentPosition(setPos,
      e => setGeoErr(e.code === 1 ? 'Location permission was blocked. Allow it to check in.' : 'Couldn\'t get a GPS fix. Step outside or near a window and try again.'),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d')!;
    ctx.translate(c.width, 0); ctx.scale(-1, 1);       // un-mirror the preview
    ctx.drawImage(v, 0, 0);
    c.toBlob(b => b && setShot({ blob: b, url: URL.createObjectURL(b), at: new Date().toISOString() }), 'image/jpeg', 0.82);
  }

  async function submit() {
    if (!shot || !pos) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('selfie', shot.blob, 'selfie.jpg');
    fd.append('type', type);
    fd.append('lat', String(pos.coords.latitude));
    fd.append('lng', String(pos.coords.longitude));
    fd.append('accuracy_m', String(Math.round(pos.coords.accuracy)));
    fd.append('captured_at', shot.at);
    try {
      const r = await tenantApi.post('/field/check-ins', fd);
      toast(r.status === 'flagged' ? 'Checked in. GPS was weak, so your manager will review it.' : 'Checked in. Your manager has it.');
      URL.revokeObjectURL(shot.url); setShot(null);
      stream.current?.getTracks().forEach(t => t.stop()); setOn(false);
    } catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  }

  const acc = pos ? Math.round(pos.coords.accuracy) : null;
  return (
    <div className="section">
      <div className="section-head"><h2>Check in</h2></div>
      <div className="panel panel-pad">
        {!isSecure() ? (
          <div className="alert bad" role="alert" style={{ marginBottom: 0 }}>
            <b>Check-ins need the https:// address.</b> This page is open at <span className="num">{location.origin}</span>, and
            phones only share the camera and location with secure https:// pages. Open HXG Connect at its https:// address, or ask your admin for it.
          </div>
        ) : <>
        <div className="field"><label htmlFor="ci-type">What are you doing?</label>
          <select id="ci-type" className="input" value={type} onChange={e => setType(e.target.value)}>
            {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        {!on ? <button className="btn primary block" onClick={start}>Open camera</button> : (
          <>
            <div className="camera">
              {camErr ? <p className="small" style={{ padding: 20, textAlign: 'center' }}>{camErr}</p>
                : shot ? <img src={shot.url} alt="Your selfie" />
                : <><video ref={video} playsInline muted /><div className="guide" /></>}
            </div>
            <div className="geo">
              {geoErr ? <span className="overdue-text">{geoErr}</span>
                : !pos ? <><span className="spinner" /> Getting your location…</>
                : <span>Location found, accurate to <b className="num">{acc} m</b>{acc! > 100 && <span className="overdue-text"> (weak, will be flagged)</span>}</span>}
            </div>
            {shot ? (
              <div className="row">
                <button className="btn" onClick={() => { URL.revokeObjectURL(shot.url); setShot(null); }}>Retake</button>
                <button className="btn primary" onClick={submit} disabled={busy || !pos}>{busy ? 'Sending…' : 'Send check-in'}</button>
              </div>
            ) : <button className="btn primary block" onClick={capture} disabled={!!camErr}>Take selfie</button>}
          </>
        )}
        </>}
        <p className="small faint" style={{ marginTop: 10 }}>Your location is shared only when you check in, never in the background.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
function TeamBoard() {
  const toast = useToast();
  const live = useLoad<any[]>(() => tenantApi.get('/field/team/live'));
  const feed = useLoad<any[]>(() => tenantApi.get('/field/check-ins'));
  useEffect(() => { const t = setInterval(() => { live.reload(); feed.reload(); }, 60000); return () => clearInterval(t); }, [live.reload, feed.reload]);

  async function review(id: string, decision: 'approved' | 'rejected') {
    try { await tenantApi.post(`/field/check-ins/${id}/review`, { decision }); toast(decision === 'approved' ? 'Approved' : 'Rejected'); feed.reload(); }
    catch (e: any) { toast(e.message, true); }
  }
  if (live.error) return <ErrorState error={live.error} retry={live.reload} />;
  const flagged = feed.data?.filter(c => c.status === 'flagged') ?? [];
  const out = live.data?.filter(u => u.state === 'not_checked_in') ?? [];

  return (
    <>
      <div className="section">
        <div className="section-head"><h2>Team today</h2><span className="muted small">{live.data ? `${live.data.length - out.length} of ${live.data.length} checked in` : ''}</span></div>
        <div className="panel">
          {!live.data ? <Loading /> : !live.data.length ? <Empty title="No field staff yet">Invite sales executives or team leaders on the Team page.</Empty> :
            live.data.map(u => (
              <div key={u.id} className={`list-item ${u.state === 'not_checked_in' ? 'urgent' : ''}`}>
                {u.selfie_url ? <img className="thumb" src={u.selfie_url} alt={`${u.name}'s last selfie`} /> : <div className="avatar lg">{initials(u.name)}</div>}
                <div className="grow"><b>{u.name}</b>
                  <div className="small muted">{u.state === 'not_checked_in' ? 'Not checked in today'
                    : <>{TYPES.find(t => t[0] === u.type)?.[1] ?? humanize(u.type)}, {when(u.captured_at)}{u.accuracy_m ? `, ±${Math.round(u.accuracy_m)} m` : ''}</>}</div></div>
                {u.lat && <a className="btn sm" href={mapsUrl(u.lat, u.lng)} target="_blank" rel="noreferrer">Map</a>}
              </div>
            ))}
        </div>
      </div>
      <div className="section">
        <div className="section-head"><h2>Check-ins</h2>{flagged.length > 0 && <span className="chip warn">{flagged.length} to review</span>}</div>
        <div className="panel">
          {!feed.data ? <Loading /> : !feed.data.length ? <Empty title="No check-ins yet today" /> :
            feed.data.map(c => <CheckinRow key={c.id} c={c} onReview={review} />)}
        </div>
      </div>
    </>
  );
}

function MyCheckins() {
  const feed = useLoad<any[]>(() => tenantApi.get('/field/check-ins'));
  return (
    <div className="section">
      <div className="section-head"><h2>Your check-ins</h2></div>
      <div className="panel">
        {!feed.data ? <Loading /> : !feed.data.length ? <Empty title="No check-ins yet">Start your day with a selfie check-in.</Empty> :
          feed.data.map(c => <CheckinRow key={c.id} c={c} />)}
      </div>
    </div>
  );
}

function CheckinRow({ c, onReview }: { c: any; onReview?: (id: string, d: 'approved' | 'rejected') => void }) {
  const flags = Object.keys(c.flags ?? {}).map(k => FLAG_TEXT[k] ?? humanize(k));
  return (
    <div className={`list-item ${c.status === 'flagged' ? 'urgent' : ''}`}>
      <a href={c.selfie_url} target="_blank" rel="noreferrer"><img className="thumb" src={c.selfie_url} alt={`Selfie from ${c.user_name}`} /></a>
      <div className="grow">
        <b>{c.user_name}</b> <span className="muted">{TYPES.find(t => t[0] === c.type)?.[1] ?? humanize(c.type)}</span>
        <div className="small muted">{when(c.captured_at)}{c.accuracy_m ? `, ±${Math.round(c.accuracy_m)} m` : ''}{c.address ? `, ${c.address}` : ''}</div>
        {flags.length > 0 && <div className="small overdue-text">{flags.join(', ')}</div>}
      </div>
      <a className="btn sm" href={mapsUrl(c.lat, c.lng)} target="_blank" rel="noreferrer">Map</a>
      {c.status === 'flagged' && onReview ? <>
        <button className="btn sm" onClick={() => onReview(c.id, 'rejected')}>Reject</button>
        <button className="btn sm primary" onClick={() => onReview(c.id, 'approved')}>Approve</button></>
        : <span className={`chip ${c.status === 'ok' || c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'bad' : 'warn'}`}>{c.status === 'ok' ? 'Verified' : humanize(c.status)}</span>}
    </div>
  );
}
