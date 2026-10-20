import React, { useMemo, useState } from 'react'
import { StatusPill, Banner, Spinner, Empty, fmtAgo, fmtUtc, shortHost, parseTime } from './ui'
import { shortName } from './hooks'

const PAGE = 200
const AD_MAX_AGE = 24 * 3600_000

/* Step 1: choose servers from Active Directory, then check their readiness.
   ad: { loading, job, result, error }   readinessRows: Phase1 server rows (Server, Overall, Eligibility, Failed) */
export default function AdServerPicker({
  plan, setPlan, health, now, ad, onSearch, readiness, readinessRows, onCheck, onOpenReport,
}) {
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)
  const [advanced, setAdvanced] = useState(Boolean(plan.adSearchBase))
  const domains = health?.ad_domains?.length ? health.ad_domains : []
  const max = health?.max_servers_per_run || 50

  const rows = useMemo(() => (Array.isArray(ad.result?.servers) ? ad.result.servers : ad.result?.servers ? [ad.result.servers] : []), [ad.result])
  const selected = useMemo(() => new Set(plan.servers.map(s => String(s).toLowerCase())), [plan.servers])
  const readinessBy = useMemo(() => new Map(readinessRows.map(r => [shortName(r.Server), r])), [readinessRows])
  const selectable = (r) => Boolean(r.Fqdn && r.Supported)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => (!onlySelected || selected.has(String(r.Fqdn).toLowerCase())) &&
      (!q || [r.Name, r.Fqdn, r.OperatingSystem, r.OU, r.Description].some(v => String(v || '').toLowerCase().includes(q))))
  }, [rows, query, onlySelected, selected])
  const shown = filtered.slice(0, PAGE)

  const toggle = (fqdn) => setPlan(p => {
    const key = fqdn.toLowerCase()
    const has = p.servers.some(s => s.toLowerCase() === key)
    return { servers: has ? p.servers.filter(s => s.toLowerCase() !== key) : [...p.servers, fqdn] }
  })
  const selectVisible = () => setPlan(p => {
    const add = filtered.filter(selectable).map(r => r.Fqdn).filter(f => !p.servers.some(s => s.toLowerCase() === f.toLowerCase()))
    return { servers: [...p.servers, ...add].slice(0, Math.max(max, p.servers.length)) }
  })

  const listAge = ad.job ? now - parseTime(ad.job.finished_at) : 0
  const listOld = ad.job && listAge > AD_MAX_AGE - 30 * 60_000
  const summary = ad.result?.server_summary
  const checkedSelected = plan.servers.map(s => readinessBy.get(shortName(s))).filter(Boolean)
  const readyCount = checkedSelected.filter(r => r.Overall === 'READY').length
  const uncheckedCount = plan.servers.length - checkedSelected.length

  const submit = (e) => { e.preventDefault(); onSearch() }

  return (
    <div className="wpx-ad">
      <form className="wpx-ad-search" onSubmit={submit}>
        <label className="wpx-field">
          <span className="wpx-label">Domain</span>
          <select className="wpx-input" value={plan.adDomain || domains[0] || ''} onChange={e => setPlan({ adDomain: e.target.value })} disabled={!domains.length}>
            {domains.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="wpx-field wpx-ad-name">
          <span className="wpx-label">Computer name (wildcard *)</span>
          <input className="wpx-input wpx-input-mono" value={plan.adFilter} maxLength={64} placeholder="e.g. C03DGH*  (empty = all servers)"
            onChange={e => setPlan({ adFilter: e.target.value.replace(/[^A-Za-z0-9*_.-]/g, '') })} />
        </label>
        <button type="submit" className="wpx-btn wpx-btn-primary wpx-ad-go" disabled={ad.loading || !domains.length} id="btn-ad-search">
          {ad.loading ? <Spinner label="Searching AD…" /> : <><i className="fa-solid fa-magnifying-glass" /> Search AD</>}
        </button>
        <button type="button" className="wpx-link wpx-ad-adv" onClick={() => setAdvanced(a => !a)}>
          <i className={`fa-solid fa-chevron-${advanced ? 'up' : 'down'}`} /> OU filter
        </button>
        {advanced && (
          <label className="wpx-field wpx-ad-ou">
            <span className="wpx-label">Organizational unit (distinguished name, optional)</span>
            <input className="wpx-input wpx-input-mono" value={plan.adSearchBase} maxLength={400} placeholder="OU=Servers,DC=dslab,DC=ad,DC=adp,DC=com"
              onChange={e => setPlan({ adSearchBase: e.target.value })} />
          </label>
        )}
      </form>

      {ad.error && <Banner toneName="bad" title="AD search failed">{ad.error}</Banner>}

      {ad.job && (
        <div className="wpx-readiness-meta">
          <span><i className="fa-brands fa-windows" /> {ad.result?.domain}{ad.result?.name_filter ? ` · ${ad.result.name_filter}` : ''}{ad.result?.search_base ? ` · ${ad.result.search_base}` : ''}</span>
          <span><i className="fa-regular fa-clock" /> Listed {fmtAgo(ad.job.finished_at, now)}</span>
          {ad.job.requested_by && <span><i className="fa-regular fa-user" /> {ad.job.requested_by}</span>}
          {summary && <span>{summary.total} servers · {summary.selectable} selectable{summary.unsupported_os ? ` · ${summary.unsupported_os} unsupported OS` : ''}{summary.stale ? ` · ${summary.stale} stale` : ''}</span>}
        </div>
      )}
      {listOld && <Banner toneName="warn" title="Server list is almost 24 hours old">Search AD again before deploying; the API accepts selections from lists less than a day old.</Banner>}
      {ad.result?.truncated && <Banner toneName="warn">Only the first {rows.length} servers are listed. Narrow the search with a name filter or an OU.</Banner>}

      {ad.loading && !rows.length ? <div className="wpx-skeleton-list"><span /><span /><span /></div>
        : !ad.job ? (
          <Empty icon="fa-sitemap" title="Find the servers to patch" action={
            <button type="button" className="wpx-btn wpx-btn-primary" onClick={onSearch} disabled={ad.loading || !domains.length}><i className="fa-solid fa-magnifying-glass" /> Search AD</button>
          }>
            Lists the enabled Windows servers in {domains.join(', ') || 'Active Directory'} (SOP step 3). Choose the servers, check their readiness, then deploy.
          </Empty>
        ) : !rows.length ? (
          <Empty icon="fa-magnifying-glass" title="No Windows servers matched">Try a broader name filter, e.g. C03*.</Empty>
        ) : (
          <>
            <div className="wpx-ad-toolbar">
              <div className="wpx-search">
                <i className="fa-solid fa-filter" />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter by name, OS, OU…" aria-label="Filter servers" />
              </div>
              <label className="wpx-toggle-line wpx-ad-only"><input type="checkbox" checked={onlySelected} onChange={e => setOnlySelected(e.target.checked)} /> Selected only</label>
              <div className="wpx-ad-sel">
                <strong>{plan.servers.length}</strong> selected{plan.servers.length > max && <span className="wpx-tone-bad"> (max {max})</span>}
                <button type="button" className="wpx-link" onClick={selectVisible}>Select all shown</button>
                <button type="button" className="wpx-link" onClick={() => setPlan({ servers: [] })} disabled={!plan.servers.length}>Clear</button>
              </div>
            </div>

            <div className="wpx-table-wrap wpx-ad-table">
              <table className="wpx-table">
                <thead>
                  <tr><th aria-label="Select" /><th>Server</th><th>Operating system</th><th>Last logon</th><th>OU</th><th>Readiness</th></tr>
                </thead>
                <tbody>
                  {shown.map(r => {
                    const fqdn = r.Fqdn || ''
                    const on = selected.has(fqdn.toLowerCase())
                    const can = selectable(r)
                    const rd = readinessBy.get(shortName(r.Name))
                    return (
                      <tr key={r.DistinguishedName || r.Name} className={`${on ? 'on' : ''} ${can ? '' : 'disabled'}`} onClick={() => can && toggle(fqdn)}>
                        <td className="wpx-ad-cb"><input type="checkbox" checked={on} disabled={!can} onChange={() => toggle(fqdn)} onClick={e => e.stopPropagation()} aria-label={`Select ${r.Name}`} /></td>
                        <td>
                          <div className="wpx-ad-name-cell"><strong>{r.Name}</strong><small>{fqdn || 'no DNS name in AD'}</small></div>
                          {r.Description && <small className="wpx-muted">{r.Description}</small>}
                        </td>
                        <td>
                          <span className={r.Supported ? '' : 'wpx-tone-bad'}>{String(r.OperatingSystem || '').replace(/^Windows Server /, 'Server ')}</span>
                          {!r.Supported && <small className="wpx-tone-bad"> · not supported</small>}
                        </td>
                        <td title={fmtUtc(r.LastLogonUtc)}>
                          {r.LastLogonUtc ? fmtAgo(r.LastLogonUtc, now) : '—'}
                          {r.Stale && <small className="wpx-tone-warn"> · stale</small>}
                        </td>
                        <td className="wpx-ad-ou-cell" title={r.OU}>{String(r.OU || '').split('/').slice(1).join(' / ') || r.OU}</td>
                        <td>{rd ? <StatusPill status={rd.Overall} size="sm" /> : on ? <span className="wpx-muted">Not checked</span> : null}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length > PAGE && <div className="wpx-muted wpx-ad-more">Showing {PAGE} of {filtered.length}. Refine the filter to see the rest.</div>}
          </>
        )}

      {plan.servers.length > 0 && (
        <div className="wpx-ad-check">
          <div className="wpx-ad-check-text">
            <strong>Readiness</strong>
            {readiness.running ? <span>Checking {plan.servers.length} server{plan.servers.length === 1 ? '' : 's'} (DNS, ping, uptime, disk, reboot, SCCM client)…</span>
              : checkedSelected.length ? <span>{readyCount} of {checkedSelected.length} checked READY{uncheckedCount ? ` · ${uncheckedCount} not checked yet` : ''} · checked {fmtAgo(readiness.job?.finished_at, now)}</span>
              : <span>Not checked yet. One-click deploy checks them anyway before deploying.</span>}
          </div>
          {readiness.job && <button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={() => onOpenReport(readiness.job.job_id)}><i className="fa-solid fa-file-lines" /> Report</button>}
          <button type="button" className="wpx-btn wpx-btn-soft wpx-btn-sm" onClick={onCheck} disabled={readiness.running || !plan.adJobId || plan.servers.length > max} id="btn-check-selected">
            {readiness.running ? <Spinner label="Checking…" /> : <><i className="fa-solid fa-list-check" /> Check selected ({plan.servers.length})</>}
          </button>
        </div>
      )}
      {readiness.error && <Banner toneName="bad">{readiness.error}</Banner>}
      {plan.servers.length > 0 && checkedSelected.some(r => r.Overall !== 'READY') && (
        <div className="wpx-ad-notready">
          {checkedSelected.filter(r => r.Overall !== 'READY').map(r => (
            <span key={r.Server}><StatusPill status={r.Overall} size="sm" /> <strong>{shortHost(r.Server)}</strong> {r.Failed && <small className="wpx-tone-bad">failed: {r.Failed}</small>}</span>
          ))}
        </div>
      )}
    </div>
  )
}
