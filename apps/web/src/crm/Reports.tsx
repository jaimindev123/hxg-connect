import { useEffect, useState } from 'react';
import { session, tenantApi } from '../lib/api';
import { Empty, ErrorState, inr, Loading, useLoad, useToast } from '../lib/ui';

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
function preset(p: string): [string, string] {
  const now = new Date(Date.now() + 5.5 * 3600e3);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const d = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  if (p === 'this_month') return [d(y, m, 1), ist(new Date())];
  if (p === 'last_month') return [d(y, m - 1, 1), d(y, m, 0)];
  if (p === 'this_quarter') return [d(y, Math.floor(m / 3) * 3, 1), ist(new Date())];
  if (p === 'this_year') return [m >= 3 ? d(y, 3, 1) : d(y - 1, 3, 1), ist(new Date())];   // Indian financial year
  return [ist(new Date(Date.now() - 29 * 864e5)), ist(new Date())];
}
const PRESETS = [['last_30', 'Last 30 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'], ['this_year', 'This financial year']];

function cell(v: any, type: string) {
  if (v === null || v === undefined || v === '') return <span className="faint">—</span>;
  if (type === 'money') return <span className="money">{Number(v) ? inr(v) : '₹0'}</span>;
  if (type === 'percent') return <span className="num">{(Number(v) * 100).toFixed(1)}%</span>;
  if (type === 'int' || type === 'minutes' || type === 'decimal') return <span className="num">{Number(v).toLocaleString('en-IN')}</span>;
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return String(v).replace(/_/g, ' ');
}

export default function Reports() {
  const toast = useToast();
  const list = useLoad<any[]>(() => tenantApi.get('/reports'));
  const [key, setKey] = useState<string | null>(null);
  const [range, setRange] = useState<[string, string]>(preset('last_30'));
  const [p, setP] = useState('last_30');
  useEffect(() => { if (!key && list.data?.length) setKey(list.data[0].key); }, [list.data, key]);
  const rep = useLoad<any>(() => (key ? tenantApi.get(`/reports/${key}?from=${range[0]}&to=${range[1]}`) : Promise.resolve(null)), [key, range[0], range[1]]);

  async function download(format: 'csv' | 'xlsx') {
    try {
      const ws = session.workspace();
      const r = await fetch(`/api/reports/${key}?from=${range[0]}&to=${range[1]}&format=${format}`,
        { headers: { authorization: `Bearer ${session.token('tenant')}`, ...(ws && { 'x-tenant': ws }) } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? 'Export failed');
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `report.${format}`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: name });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e: any) { toast(e.message, true); }
  }

  if (list.error) return <ErrorState error={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;
  if (!list.data.length) return <div className="panel"><Empty title="No reports for your role">Ask a manager if you need numbers for your work.</Empty></div>;
  const d = rep.data;
  const firstNum = d?.columns.find((c: any) => ['int', 'money'].includes(c.type))?.key;
  const max = d && firstNum ? Math.max(1, ...d.rows.map((r: any) => Number(r[firstNum]) || 0)) : 1;

  return (
    <>
      <div className="page-head"><div className="grow"><h1>Reports</h1><p>{d?.description ?? ' '}</p></div>
        <button className="btn" onClick={() => download('csv')} disabled={!d?.rows.length}>CSV</button>
        <button className="btn primary" onClick={() => download('xlsx')} disabled={!d?.rows.length}>Download Excel</button></div>
      <div className="tabs">{list.data.map(r => <button key={r.key} className={key === r.key ? 'on' : ''} onClick={() => setKey(r.key)}>{r.title}</button>)}</div>
      <div className="toolbar">
        <select className="input" value={p} onChange={e => { setP(e.target.value); if (e.target.value !== 'custom') setRange(preset(e.target.value)); }} aria-label="Period">
          {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}<option value="custom">Custom dates</option></select>
        {p === 'custom' && <>
          <input className="input" type="date" value={range[0]} max={range[1]} onChange={e => setRange([e.target.value, range[1]])} aria-label="From" style={{ minWidth: 0 }} />
          <span className="muted">to</span>
          <input className="input" type="date" value={range[1]} min={range[0]} onChange={e => setRange([range[0], e.target.value])} aria-label="To" style={{ minWidth: 0 }} /></>}
      </div>
      {rep.error ? <ErrorState error={rep.error} retry={rep.reload} /> : (
        <div className="table-wrap">
          {!d ? <Loading /> : !d.rows.length ? <Empty title="Nothing in this period">Try a longer date range.</Empty> : (
            <table>
              <thead><tr>{d.columns.map((c: any) => <th key={c.key} style={{ textAlign: c.type === 'text' || c.type === 'date' ? 'left' : 'right' }}>{c.label}</th>)}</tr></thead>
              <tbody>
                {d.rows.map((r: any, i: number) => (
                  <tr key={i}>{d.columns.map((c: any) => (
                    <td key={c.key} style={{ textAlign: c.type === 'text' || c.type === 'date' ? 'left' : 'right', position: 'relative' }}>
                      {c.key === firstNum && <span aria-hidden style={{ position: 'absolute', right: 0, bottom: 4, height: 3, borderRadius: 2,
                        width: `${(Number(r[c.key]) / max) * 60}%`, background: 'var(--act)', opacity: 0.35 }} />}
                      {cell(r[c.key], c.type)}</td>))}</tr>))}
                {d.totals && <tr style={{ fontWeight: 600, background: 'var(--sunk)' }}>{d.columns.map((c: any) => (
                  <td key={c.key} style={{ textAlign: c.type === 'text' || c.type === 'date' ? 'left' : 'right' }}>{d.totals[c.key] === undefined ? '' : cell(d.totals[c.key], c.type)}</td>))}</tr>}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
