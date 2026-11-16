import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { api, ApiError, isOffline, ownerKey, session } from './api';

/** Check-ins taken without signal wait on the phone (photo copied out of the
 *  cache so the OS can't purge it) with their ORIGINAL capture time. The
 *  server marks anything over 15 minutes old as "sent late" for the manager.
 *
 *  Field phones get shared, so each one records whose it is (`owner`), and
 *  only that person's session ever sends it. The server double-checks with
 *  `taken_by`. */
type Pending = { id: string; file: string; fields: Record<string, string>; owner: string };
const KEY = 'hxg.checkins.pending';
let flushing = false;

function folder() { const d = new Directory(Paths.document, 'checkins'); if (!d.exists) d.create(); return d; }
async function read(): Promise<Pending[]> { try { return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]'); } catch { return []; } }
const write = (q: Pending[]) => AsyncStorage.setItem(KEY, JSON.stringify(q));
const drop = (p: Pending) => { try { const f = new File(p.file); if (f.exists) f.delete(); } catch { /* already gone */ } };

function upload(p: Pending) {
  const fd = new FormData();
  fd.append('selfie', { uri: p.file, name: 'selfie.jpg', type: 'image/jpeg' } as any);
  for (const [k, v] of Object.entries(p.fields)) fd.append(k, v);
  return api<{ status: string; flags: Record<string, unknown> }>('POST', '/field/check-ins', fd);
}

const currentOwner = () => { const s = session.get(); return s ? ownerKey(s) : null; };
const wrongUser = (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === 'checkin_wrong_user';

export async function submitCheckIn(photoUri: string, fields: Record<string, string>) {
  const s = session.get();
  if (!s) throw new ApiError(401, 'signed_out', 'Please sign in');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const dest = new File(folder(), `${id}.jpg`);
  await new File(photoUri).copy(dest);
  const p: Pending = { id, file: dest.uri, fields: { ...fields, taken_by: s.userId }, owner: ownerKey(s) };
  try {
    const r = await upload(p);
    drop(p);
    return { queued: false as const, flagged: r.status === 'flagged', flags: r.flags };
  } catch (e) {
    if (isOffline(e)) { await write([...(await read()), p]); return { queued: true as const }; }
    drop(p);
    throw e;
  }
}

/** Called on launch, when the app returns to the foreground, and every minute. */
export async function flushQueue(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    const me = currentOwner();
    const q = await read();
    const left: Pending[] = [];
    for (let i = 0; i < q.length; i++) {
      if (!me || q[i].owner !== me) { left.push(q[i]); continue; }   // someone else's: waits for them
      try { await upload(q[i]); drop(q[i]); sent++; }
      catch (e) {
        if (isOffline(e)) { left.push(...q.slice(i)); break; }       // still no signal: keep the rest
        if (e instanceof ApiError && e.status === 401) { left.push(...q.slice(i)); break; }   // signed out: keep for later
        if (wrongUser(e)) { left.push(q[i]); continue; }              // never send under another login
        drop(q[i]);                                                     // the server rejected it: it will never succeed
      }
    }
    await write(left);
  } finally { flushing = false; }
  return sent;
}

/** Only the signed-in person's own: nobody sees how many a colleague left behind. */
export const pendingCount = async () => { const me = currentOwner(); return (await read()).filter(p => p.owner === me).length; };
