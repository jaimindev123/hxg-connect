import { useState } from 'react';
import { api } from '../lib/api';
import { Field, Modal, useSubmit } from '../lib/ui';

const FIELDS: [key: string, label: string, required?: boolean][] = [
  ['name', 'Name', true], ['phone', 'Phone', true], ['email', 'Email'], ['source', 'Source'], ['budget', 'Budget'],
  ['location', 'Location'], ['property_type', 'Property type'], ['tags', 'Tags'], ['note', 'Notes'],
];

/** CSV → preview with recognised columns → import → plain-language report. */
export default function ImportLeads({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [source, setSource] = useState('import');
  const [result, setResult] = useState<any>(null);
  const { busy, error, run, setError } = useSubmit();

  async function choose(f: File | null) {
    setFile(f); setPv(null); setError(null);
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    const r = await run(() => api('tenant', 'POST', '/imports/leads/preview', fd));
    if (r) { setPv(r); setMapping(r.mapping); }
  }
  async function go() {
    const fd = new FormData(); fd.append('file', file!); fd.append('mapping', JSON.stringify(mapping)); fd.append('default_source', source);
    const r = await run(() => api('tenant', 'POST', '/imports/leads', fd));
    if (r) { setResult(r); onDone(); }
  }

  if (result) return (
    <Modal title="Import finished" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <dl className="kv" style={{ marginTop: 0 }}>
        <dt>New leads</dt><dd className="num"><b>{result.created}</b></dd>
        <dt>Already in your leads</dt><dd className="num">{result.duplicates} <span className="muted small">(added to their timelines as re-enquiries)</span></dd>
        <dt>Skipped</dt><dd className="num">{result.invalid.length}</dd>
      </dl>
      {result.limit_reached && <div className="alert bad">Your plan's lead limit was reached partway through. Upgrade, then import the rest.</div>}
      {result.invalid.length > 0 && <>
        <p className="small muted" style={{ marginBottom: 6 }}>Fix these rows in your spreadsheet and import just them again:</p>
        <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}><table><tbody>
          {result.invalid.map((x: any) => <tr key={x.row}><td className="num" style={{ width: 70 }}>Row {x.row}</td><td className="small">{x.error}</td></tr>)}
        </tbody></table></div></>}
    </Modal>
  );

  const ready = pv && mapping.name !== undefined && mapping.phone !== undefined;
  return (
    <Modal title="Import leads from a spreadsheet" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ready || busy} onClick={go}>{busy && pv ? 'Importing…' : pv ? `Import ${pv.total.toLocaleString('en-IN')} rows` : 'Import'}</button></>}>
      {error && <div className="alert bad">{error.message}</div>}
      <Field label="CSV file" hint="Save from Excel or Google Sheets as CSV. Up to 20,000 rows. Duplicates are matched by phone number.">
        <input className="input" type="file" accept=".csv,text/csv" onChange={e => choose(e.target.files?.[0] ?? null)} style={{ paddingTop: 6 }} />
      </Field>
      {pv && <>
        <p className="small muted" style={{ marginBottom: 10 }}>{pv.total.toLocaleString('en-IN')} rows found. Check which column holds what:</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 12 }}>
          {FIELDS.map(([k, label, req]) => (
            <Field key={k} label={`${label}${req ? '' : ' (optional)'}`}>
              <select className="input" value={mapping[k] ?? ''} aria-invalid={req && mapping[k] === undefined}
                onChange={e => setMapping(m => { const n = { ...m }; if (e.target.value === '') delete n[k]; else n[k] = Number(e.target.value); return n; })}>
                <option value="">{req ? 'Choose a column' : "Don't import"}</option>
                {pv.headers.map((h: string, i: number) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select>
            </Field>))}
        </div>
        <Field label="Source for rows without one" hint="For example the event or list these came from"><input className="input" style={{ maxWidth: 260 }} value={source} onChange={e => setSource(e.target.value)} /></Field>
        <div className="table-wrap"><table>
          <thead><tr>{pv.headers.map((h: string, i: number) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{pv.sample.map((r: string[], i: number) => <tr key={i}>{pv.headers.map((_: string, j: number) => <td key={j} className="small">{r[j]}</td>)}</tr>)}</tbody>
        </table></div>
      </>}
    </Modal>
  );
}
