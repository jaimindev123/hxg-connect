// One request function for both realms. Tokens live in sessionStorage (gone
// when the tab closes) behind a strict CSP served by the API.

export type Realm = 'tenant' | 'platform' | 'partner';
// Set at startup from /api/public/config. null = no domain yet.
let BASE_DOMAIN: string | null = null;
export const setBaseDomain = (d: string | null) => { BASE_DOMAIN = d; };
export const baseDomain = () => BASE_DOMAIN;

const K = { tenant: 'hxg.t', platform: 'hxg.p', partner: 'hxg.cp', workspace: 'hxg.ws' } as const;

export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string,
              public issues: { path: string; message: string }[] = []) {
    super(message);
  }
  /** Field-level message for forms: err.field('email') */
  field(path: string) { return this.issues.find(i => i.path === path)?.message; }
}

export const session = {
  token: (realm: Realm) => sessionStorage.getItem(K[realm]),
  set(realm: Realm, token: string) { sessionStorage.setItem(K[realm], token); },
  clear(realm: Realm) { sessionStorage.removeItem(K[realm]); },
  /** Production: the subdomain (sunrise.hxgconnect.com). Dev: chosen at login. */
  workspace(): string | null {
    const host = location.hostname;
    if (BASE_DOMAIN && host.endsWith(`.${BASE_DOMAIN}`)) return host.slice(0, -(BASE_DOMAIN.length + 1));
    return sessionStorage.getItem(K.workspace);
  },
  setWorkspace(ws: string) { sessionStorage.setItem(K.workspace, ws.trim().toLowerCase()); },
  onSubdomain: () => !!BASE_DOMAIN && location.hostname.endsWith(`.${BASE_DOMAIN}`),
  workspaceUrl: (ws: string) => (BASE_DOMAIN ? `https://${ws}.${BASE_DOMAIN}` : location.origin),
};

/** Support handoff: the console opens the client app with #imp=<token>&ws=<sub>.
 *  We store it and strip it from the URL so it never sits in history. */
export function absorbHandoff() {
  if (!location.hash.startsWith('#imp=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('imp'), ws = p.get('ws');
  if (t) session.set('tenant', t);
  if (ws) session.setWorkspace(ws);
  history.replaceState(null, '', location.pathname);
}

const listeners = new Set<(realm: Realm) => void>();
export const onSignedOut = (fn: (realm: Realm) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export async function api<T = any>(realm: Realm, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = session.token(realm);
  if (token) headers.authorization = `Bearer ${token}`;
  if (realm !== 'platform') {
    const ws = session.workspace();
    if (ws) headers['x-tenant'] = ws;   // always: proxies like Vercel change the Host the API sees
  }
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'network', 'Can\'t reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (res.ok) return data as T;

  if (res.status === 401 && token) {
    session.clear(realm);
    listeners.forEach(fn => fn(realm));
  }
  throw new ApiError(res.status, data?.code, data?.message ?? `Request failed (${res.status})`, data?.issues ?? []);
}

function safeJson(t: string) { try { return JSON.parse(t); } catch { return { message: t }; } }

export const tenantApi = {
  get: <T = any>(p: string) => api<T>('tenant', 'GET', p),
  post: <T = any>(p: string, b?: unknown) => api<T>('tenant', 'POST', p, b ?? {}),
  patch: <T = any>(p: string, b: unknown) => api<T>('tenant', 'PATCH', p, b),
  del: <T = any>(p: string) => api<T>('tenant', 'DELETE', p),
};
export const partnerApi = {
  get: <T = any>(p: string) => api<T>('partner', 'GET', p),
  post: <T = any>(p: string, b?: unknown) => api<T>('partner', 'POST', p, b ?? {}),
};
export const platformApi = {
  get: <T = any>(p: string) => api<T>('platform', 'GET', p),
  post: <T = any>(p: string, b?: unknown) => api<T>('platform', 'POST', p, b ?? {}),
  patch: <T = any>(p: string, b: unknown) => api<T>('platform', 'PATCH', p, b),
};
