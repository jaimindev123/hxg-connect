import * as SecureStore from 'expo-secure-store';

/** The server address is part of the session because there may be no
 *  domain yet: a team can point the app at http://their-server:4000. */
export type Session = { server: string; workspace: string; token: string; name: string; role: string; userId: string };

/** Identifies one person in one workspace on one server. Offline check-ins
 *  carry this so they only ever send under the person who took them. */
export const ownerKey = (s: Pick<Session, 'server' | 'workspace' | 'userId'>) => `${s.server}|${s.workspace}|${s.userId}`;
let current: Session | null = null;
let signedOut: (() => void) | null = null;

export const session = {
  get: () => current,
  async load() {
    try { const raw = await SecureStore.getItemAsync('hxg.session'); current = raw ? JSON.parse(raw) : null; }
    catch { current = null; }
    // A session saved before we recorded who signed in can't be matched to
    // queued check-ins safely: ask for a fresh sign-in instead.
    if (current && !current.userId) { current = null; await SecureStore.deleteItemAsync('hxg.session').catch(() => undefined); }
    return current;
  },
  async save(s: Session) { current = s; await SecureStore.setItemAsync('hxg.session', JSON.stringify(s)); },
  async clear() { current = null; await SecureStore.deleteItemAsync('hxg.session'); },
  onSignedOut(fn: () => void) { signedOut = fn; },
};

export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) { super(message); }
}
export const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;

export async function api<T = any>(method: string, path: string, body?: unknown,
                                   via?: { server: string; workspace: string; token?: string }): Promise<T> {
  const s = via ?? current;
  if (!s) throw new ApiError(401, 'signed_out', 'Please sign in');
  const headers: Record<string, string> = { 'x-tenant': s.workspace };
  if (s.token) headers.authorization = `Bearer ${s.token}`;
  let payload: any;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(`${s.server.replace(/\/+$/, '')}/api${path}`, { method, headers, body: payload }); }
  catch { throw new ApiError(0, 'network', 'No connection to the server'); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (res.ok) return data as T;
  if (res.status === 401 && !via) { await session.clear(); signedOut?.(); }
  throw new ApiError(res.status, data?.code, data?.message ?? `Request failed (${res.status})`);
}
