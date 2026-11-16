import { Link } from 'react-router-dom';
import { tenantApi } from '../lib/api';
import { Empty, ErrorState, humanize, inr, Loading, useLoad, when } from '../lib/ui';
import { useMe } from './App';

export default function Dashboard() {
  const { me } = useMe();
  const s = useLoad<any>(() => tenantApi.get('/dashboard/summary'));
  const day = useLoad<any[]>(() => tenantApi.get('/follow-ups/my-day'));
  if (s.error) return <ErrorState error={s.error} retry={s.reload} />;
  if (!s.data) return <Loading />;

  const { leads, follow_ups: fu, funnel, sources } = s.data;
  const top = Math.max(1, ...funnel.map((f: any) => f.count));
  const srcTotal = sources.reduce((n: number, x: any) => n + x.count, 0) || 1;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="page-head">
        <div className="grow"><h1>{greet}, {me.user.name.split(' ')[0]}</h1>
          <p>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
        <Link className="btn primary" to="/leads?new=1">Add lead</Link>
      </div>

      <div className="figures">
        <div className="figure"><div className="v">{leads.new_today}</div><div className="l">New leads today</div></div>
        <div className="figure"><div className="v">{leads.open.toLocaleString('en-IN')}</div><div className="l">Open leads</div></div>
        <div className={`figure ${fu.overdue ? 'alert' : ''}`}><div className="v">{fu.overdue}</div><div className="l">Overdue follow-ups</div></div>
        <div className="figure"><div className="v">{fu.later_today}</div><div className="l">Still due today</div></div>
        <div className="figure money"><div className="v">{inr(leads.won_value_month)}</div><div className="l">{leads.won_month} booked this month</div></div>
      </div>

      <div className="grid-2">
        <div>
          {(fu.overdue > 0 || leads.without_next_action > 0) && (
            <div className="section">
              <div className="section-head"><h2>Needs attention</h2></div>
              <div className="panel">
                {fu.overdue > 0 && (
                  <div className="list-item urgent"><div className="grow"><b>{fu.overdue} follow-up{fu.overdue > 1 ? 's are' : ' is'} overdue</b>
                    <div className="small muted">Every hour late lowers the chance of a site visit.</div></div>
                    <Link className="btn sm" to="/my-day">Open my day</Link></div>
                )}
                {leads.without_next_action > 0 && (
                  <div className="list-item"><div className="grow"><b>{leads.without_next_action} open lead{leads.without_next_action > 1 ? 's have' : ' has'} no next step</b>
                    <div className="small muted">These are the ones that quietly go cold. Schedule something for each.</div></div>
                    <Link className="btn sm" to="/leads">Review leads</Link></div>
                )}
              </div>
            </div>
          )}
          <div className="section">
            <div className="section-head"><h2>Pipeline</h2><span className="grow" /><Link className="small" to="/pipeline">Open board</Link></div>
            <div className="panel panel-pad">
              {funnel.map((f: any) => (
                <div key={f.name} className="bar-row"><span>{f.name}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(f.count / top) * 100}%` }} /></div>
                  <span className="n">{f.count}</span></div>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="section">
            <div className="section-head"><h2>Today</h2><span className="grow" /><Link className="small" to="/my-day">All</Link></div>
            <div className="panel">
              {!day.data ? <Loading /> : !day.data.length ? <Empty title="Nothing due today" /> :
                day.data.slice(0, 6).map(f => (
                  <div key={f.id} className={`list-item ${f.overdue ? 'urgent' : ''}`}>
                    <div className={`when ${f.overdue ? 'overdue-text' : ''}`}>{when(f.due_at).replace('Today ', '')}</div>
                    <div className="grow"><b>{humanize(f.type)}</b> <Link to={`/leads/${f.lead_id}`}>{f.lead_name}</Link></div>
                  </div>
                ))}
            </div>
          </div>
          <div className="section">
            <div className="section-head"><h2>Where leads came from</h2><span className="muted small">last 30 days</span></div>
            <div className="panel panel-pad">
              {!sources.length ? <p className="muted">No leads in the last 30 days.</p> : sources.map((x: any) => (
                <div key={x.source} className="bar-row"><span>{humanize(x.source)}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(x.count / srcTotal) * 100}%`, background: 'var(--brass)' }} /></div>
                  <span className="n">{x.count}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
