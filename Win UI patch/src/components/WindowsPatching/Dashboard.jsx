import React, { useCallback, useEffect, useState } from 'react'
import { dashboard as fetchDashboard, describeError } from '../../api/sccmApi'
import { Banner, Card, Empty, Kpi, Spinner, StatusPill, fmtAgo, fmtDuration, shortHost, useNow } from './ui'

const PERIODS = [3, 6, 12]
/* Runs per month by outcome (status colours, always with a label) */
const OUTCOMES = [
  { key: 'succeeded', label: 'Succeeded', icon: 'fa-circle-check', cls: 'good' },
  { key: 'with_issues', label: 'With issues', icon: 'fa-triangle-exclamation', cls: 'warn' },
  { key: 'failed', label: 'Failed / interrupted', icon: 'fa-circle-xmark', cls: 'bad' },
]
const monthLabel = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)

/* Totals from the deployments and readiness checks recorded by the API */
export default function Dashboard({ onOpenReport, refreshKey }) {
  const [months, setMonths] = useState(6)
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const now = useNow(true, 60_000)
  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      setState({ loading: false, data: await fetchDashboard(months), error: null })
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: describeError(e) }))
    }
  }, [months])
  useEffect(() => { load() }, [load, refreshKey])

  const d = state.data
  const t = d?.totals
  return (
    <div className="wpx-dash">
      <div className="wpx-dash-bar">
        <div>
          <h2>Patching overview</h2>
          <p className="wpx-muted">Deployments and readiness checks run through this API{d ? ` · updated ${fmtAgo(d.generated_at, now)}` : ''}.</p>
        </div>
        <div className="wpx-row-gap">
          <div className="wpx-seg wpx-seg-sm" role="tablist" aria-label="Period">
            {PERIODS.map(p => <button key={p} type="button" className={months === p ? 'active' : ''} onClick={() => setMonths(p)}>{p} months</button>)}
          </div>
          <button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={load} disabled={state.loading}>{state.loading ? <Spinner /> : <i className="fa-solid fa-rotate" />} Refresh</button>
        </div>
      </div>

      {state.error && <Banner toneName="bad">{state.error}</Banner>}
      {state.loading && !d && <div className="wpx-center wpx-pad-lg"><Spinner label="Loading the overview…" /></div>}

      {t && (t.runs === 0 && t.servers_tracked === 0 ? (
        <Empty icon="fa-chart-column" title="No deployments yet">Totals appear here after the first deployment or readiness check.</Empty>
      ) : (
        <>
          <div className="wpx-kpi-grid wpx-dash-kpis">
            <Kpi icon="fa-rocket" label="Deployments" value={t.runs} sub={t.by_status?.SUCCEEDED ? `${t.by_status.SUCCEEDED} succeeded` : null} />
            <Kpi icon="fa-bullseye" label="Run success rate" value={pct(t.success_rate)} sub={t.server_success_rate != null ? `${pct(t.server_success_rate)} of servers patched` : null} toneName={t.success_rate == null ? 'neutral' : t.success_rate >= 0.9 ? 'good' : t.success_rate >= 0.6 ? 'warn' : 'bad'} />
            <Kpi icon="fa-server" label="Servers patched" value={t.servers_patched} sub={`${t.unique_servers_patched} distinct`} toneName="good" />
            <Kpi icon="fa-puzzle-piece" label="KBs installed" value={t.kbs_installed} sub="server × KB" toneName="indigo" />
            <Kpi icon="fa-stopwatch" label="Average run time" value={t.avg_duration_seconds != null ? fmtDuration(t.avg_duration_seconds * 1000) : '—'} sub={t.max_duration_seconds != null ? `longest ${fmtDuration(t.max_duration_seconds * 1000)}` : null} toneName="teal" />
            <Kpi icon="fa-stethoscope" label="Need attention" value={t.servers_needing_attention} sub={`of ${t.servers_tracked} servers tracked`} toneName={t.servers_needing_attention ? 'warn' : 'good'} />
          </div>

          <div className="wpx-dash-row">
            <MonthlyRuns months={d.months} />
            <TopKbs items={d.top_kbs} />
          </div>

          <Card title="Servers needing attention" icon="fa-stethoscope" kicker="Latest state per server" pad={false}>
            {d.attention.length === 0 ? (
              <div className="wpx-pad"><Banner toneName="good" title="All tracked servers are healthy">Every server's latest readiness check or deployment ended READY or PATCHED.</Banner></div>
            ) : (
              <div className="wpx-table-wrap wpx-table-flat">
                <table className="wpx-table">
                  <thead><tr><th>Server</th><th>State</th><th>From</th><th>Detail</th><th>When</th><th aria-label="Open" /></tr></thead>
                  <tbody>
                    {d.attention.map(a => (
                      <tr key={a.server}>
                        <td><strong>{shortHost(a.server)}</strong><div className="wpx-muted wpx-small">{a.server}</div></td>
                        <td><StatusPill status={a.status} size="sm" /></td>
                        <td>{a.source}{a.deployment_name ? <div className="wpx-muted wpx-small">{a.deployment_name}</div> : null}</td>
                        <td className="wpx-dash-detail">{a.detail || '—'}</td>
                        <td title={a.at}>{fmtAgo(a.at, now)}</td>
                        <td><button type="button" className="wpx-link" onClick={() => onOpenReport(a.job_id)}>Report</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Recent deployments" icon="fa-clock-rotate-left" pad={false}>
            {d.recent.length === 0 ? <div className="wpx-pad wpx-muted">No deployments yet.</div> : (
              <div className="wpx-table-wrap wpx-table-flat">
                <table className="wpx-table wpx-table-click">
                  <thead><tr><th>Deployment</th><th>Outcome</th><th>Servers patched</th><th>KBs</th><th>Change</th><th>By</th><th>Run time</th><th>Finished</th></tr></thead>
                  <tbody>
                    {d.recent.map(r => (
                      <tr key={r.job_id} onClick={() => onOpenReport(r.job_id)} title="Open the report">
                        <td><strong>{r.deployment_name || r.job_id}</strong>{r.sug && <div className="wpx-muted wpx-small">{r.sug}</div>}</td>
                        <td><StatusPill status={r.status} size="sm" /></td>
                        <td>{r.patched} / {r.servers}</td>
                        <td>{r.kbs_installed}</td>
                        <td className="wpx-mono">{r.change_ticket || '—'}</td>
                        <td>{r.requested_by || '—'}</td>
                        <td>{r.duration_seconds != null && r.kind !== 'report_import' ? fmtDuration(r.duration_seconds * 1000) : '—'}</td>
                        <td title={r.finished_at}>{fmtAgo(r.finished_at || r.created_at, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ))}
    </div>
  )
}

/* Stacked columns per month (outcome), with a hover tooltip and a table view */
function MonthlyRuns({ months }) {
  const [view, setView] = useState('chart')
  const [hover, setHover] = useState(null)
  const max = Math.max(1, ...months.map(m => m.runs))
  // Every whole number for small counts, else 0 / half / max
  const ticks = max <= 5 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max]
  return (
    <Card
      title="Deployments per month" icon="fa-chart-column" kicker="By outcome" className="wpx-dash-chart"
      actions={<div className="wpx-seg wpx-seg-sm" role="tablist" aria-label="View">
        <button type="button" className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}><i className="fa-solid fa-chart-column" /> Chart</button>
        <button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}><i className="fa-solid fa-table" /> Table</button>
      </div>}
    >
      <div className="wpx-dash-legend">
        {OUTCOMES.map(o => <span key={o.key}><i className={`wpx-dash-sw wpx-dash-${o.cls}`} /><i className={`fa-solid ${o.icon} wpx-dash-legend-icon`} />{o.label}</span>)}
      </div>
      {view === 'table' ? (
        <div className="wpx-table-wrap">
          <table className="wpx-table">
            <thead><tr><th>Month</th><th>Runs</th>{OUTCOMES.map(o => <th key={o.key}>{o.label}</th>)}<th>Servers patched</th><th>KBs installed</th></tr></thead>
            <tbody>{months.map(m => (
              <tr key={m.month}><td>{monthLabel(m.month)}</td><td>{m.runs}</td>{OUTCOMES.map(o => <td key={o.key}>{m[o.key]}</td>)}<td>{m.servers_patched}</td><td>{m.kbs_installed}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="wpx-cols" role="img" aria-label={months.map(m => `${monthLabel(m.month)}: ${m.runs} runs`).join('; ')}>
          <div className="wpx-cols-grid" aria-hidden="true">
            {ticks.map(v => <span key={v} style={{ bottom: `${(v / max) * 100}%` }}><b>{v}</b></span>)}
          </div>
          {months.map(m => (
            <div key={m.month} className="wpx-col" onMouseEnter={() => setHover(m.month)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(m.month)} onBlur={() => setHover(null)} tabIndex={0}>
              <div className="wpx-col-plot">
                {m.runs > 0 && <span className="wpx-col-total" style={{ bottom: `calc(${(m.runs / max) * 100}% + 4px)` }}>{m.runs}</span>}
                <div className="wpx-col-stack" style={{ height: `${(m.runs / max) * 100}%` }}>
                  {OUTCOMES.map(o => m[o.key] > 0 && <span key={o.key} className={`wpx-dash-${o.cls}`} style={{ flexGrow: m[o.key] }} />)}
                </div>
                {hover === m.month && (
                  <div className="wpx-col-tip" role="tooltip">
                    <strong>{monthLabel(m.month)}</strong>
                    {OUTCOMES.map(o => <div key={o.key}><i className={`wpx-dash-sw wpx-dash-${o.cls}`} />{o.label}<b>{m[o.key]}</b></div>)}
                    <div className="wpx-col-tip-sep">Servers patched<b>{m.servers_patched}</b></div>
                    <div>KBs installed<b>{m.kbs_installed}</b></div>
                  </div>
                )}
              </div>
              <span className="wpx-col-label">{monthLabel(m.month)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* Most installed KBs: one series, bars with the value written beside them */
function TopKbs({ items }) {
  const max = Math.max(1, ...items.map(i => i.installs))
  return (
    <Card title="Most installed KBs" icon="fa-puzzle-piece" kicker="Servers that received each KB" className="wpx-dash-kbs">
      {items.length === 0 ? <div className="wpx-muted">No KBs installed yet.</div> : (
        <ul className="wpx-hbars">
          {items.map(i => (
            <li key={i.kb} title={`${i.kb}: installed on ${i.installs} server${i.installs === 1 ? '' : 's'}`}>
              <span className="wpx-hbar-label">{i.kb}</span>
              <span className="wpx-hbar-track"><span className="wpx-hbar-fill" style={{ width: `${(i.installs / max) * 100}%` }} /></span>
              <span className="wpx-hbar-value">{i.installs}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
