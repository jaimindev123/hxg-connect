import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState, useId, isValidElement, cloneElement } from 'react';
import { ApiError } from './api';

// ---------- data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fn().then(d => { if (n === seq.current) { setData(d); setError(null); } })
        .catch(e => { if (n === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, undefined, String(e))); })
        .finally(() => { if (n === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- formatting (Indian conventions) ----------
/** ₹ in lakh/crore: 8500000 → "₹85 L", 12000000 → "₹1.2 Cr" */
export function inr(v: number | string | null | undefined): string {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n) || n === 0) return '—';
  if (n >= 1e7) return `₹${trim(n / 1e7)} Cr`;
  if (n >= 1e5) return `₹${trim(n / 1e5)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}
const trim = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(2).replace(/\.?0+$/, ''));
export const budget = (min?: number | string | null, max?: number | string | null) =>
  min && max ? (Number(min) === Number(max) ? inr(max) : `${inr(min)}–${inr(max).replace('₹', '')}`) : inr(max ?? min);

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso), now = new Date();
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  const abs = Math.abs(mins);
  if (abs < 1) return 'now';
  if (abs < 60) return mins < 0 ? `${abs}m ago` : `in ${abs}m`;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const t = new Date(now); t.setDate(now.getDate() + 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  if (d.toDateString() === t.toDateString()) return `Tomorrow ${time}`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ` ${time}`;
}
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('');
export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
/** <input type="datetime-local"> value → ISO with offset */
export const localToIso = (v: string) => new Date(v).toISOString();
export const isoToLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** HXG Global LLP logo; the dark-theme copy has a lightened wordmark. */
export const Logo = ({ height = 44 }: { height?: number }) => (
  <span className="logo" style={{ height }}>
    <img className="logo-light" src="/hxg-logo.png" alt="HXG Connect" />
    <img className="logo-dark" src="/hxg-logo-dark.png" alt="HXG Connect" />
  </span>
);

// ---------- toasts ----------
type Toast = { id: number; text: string; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setItems(t => [...t, { id, text, bad }]);
    setTimeout(() => setItems(t => t.filter(x => x.id !== id)), bad ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- pieces ----------
export function Modal({ title, onClose, children, footer, wide }:
  { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  // Tie the label to its control, so tapping the label focuses the box and screen readers announce it.
  const auto = useId();
  const el = isValidElement<{ id?: string }>(children) && typeof children.type === 'string' ? children : null;
  const id = el ? el.props.id ?? auto : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {el ? cloneElement(el, { id }) : children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export const Loading = () => <div className="center"><span className="spinner" aria-label="Loading" /></div>;

export function ErrorState({ error, retry }: { error: ApiError; retry?: () => void }) {
  return (
    <div className="empty">
      <h3>{error.code === 'feature_not_in_plan' ? 'Not included in your plan' : error.status === 403 ? 'You don\'t have access to this' : 'This didn\'t load'}</h3>
      <p>{error.status === 403 && error.code !== 'feature_not_in_plan' ? 'Your role doesn\'t include this. Ask your admin if you need it.' : error.message}</p>
      {retry && error.code !== 'feature_not_in_plan' && error.status !== 403 && <button className="btn" onClick={retry}>Try again</button>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

/** Form submit wrapper: tracks busy state and turns ApiErrors into messages. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, undefined, String(e))); return undefined; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

export function useTheme() {
  const [theme, setTheme] = useState<string>(() =>
    localStorage.getItem('hxg.theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('hxg.theme', theme); }, [theme]);
  return { theme, toggle: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) };
}
