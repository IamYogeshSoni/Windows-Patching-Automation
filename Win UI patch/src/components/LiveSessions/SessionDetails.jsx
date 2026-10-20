import React, { useState, useEffect } from 'react'
import { fetchCompareSummary, fetchHostReport, fetchFailedHosts } from '../../api/patchingApi'
import './LiveSessions.css'

export default function SessionDetails({ sessionId, onBack }) {
  const [summary, setSummary] = useState(null)
  const [hosts, setHosts] = useState([])
  const [failedHosts, setFailedHosts] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [onlyDiff, setOnlyDiff] = useState(false)
  const [expandedHost, setExpandedHost] = useState(null)
  const [hostDetails, setHostDetails] = useState({})
  const [loadingHost, setLoadingHost] = useState(null)
  const pageSize = 20
  
  const handleExpand = async (hostname) => {
    if (expandedHost === hostname) {
      setExpandedHost(null);
      return;
    }
    setExpandedHost(hostname);
    if (!hostDetails[hostname]) {
      setLoadingHost(hostname);
      try {
        const { fetchHostDrill } = await import('../../api/patchingApi');
        const res = await fetchHostDrill(sessionId, hostname);
        const data = res.services || (Array.isArray(res) ? res : res.report) || [];
        setHostDetails(prev => ({ ...prev, [hostname]: data }));
      } catch (err) {
        setHostDetails(prev => ({ ...prev, [hostname]: [] }));
      } finally {
        setLoadingHost(null);
      }
    }
  }

  useEffect(() => { loadData(1) }, [sessionId])

  const loadData = async (targetPage) => {
    setLoading(true); setError(null)
    try {
      const [sumRes, failRes, hostRes] = await Promise.all([
        fetchCompareSummary(sessionId).catch(() => null),
        fetchFailedHosts(sessionId).catch(() => null),
        fetchHostReport(sessionId, onlyDiff, targetPage, pageSize).catch(() => null)
      ])
      if (sumRes) setSummary(sumRes)
      if (failRes) setFailedHosts(failRes)
      if (hostRes) {
        setHosts(hostRes.report || [])
        setTotalPages(hostRes.pagination?.total_pages || 1)
        setPage(targetPage)
      }
    } catch (err) {
      setError('Failed to load session details. Please try again.')
    } finally { setLoading(false) }
  }

  const handleExportCSV = () => {
    if (!hosts.length) return
    const rows = [['Hostname', 'Added', 'Removed', 'Modified', 'Total Diffs']]
    hosts.forEach(h => rows.push([h.hostname, h.summary?.added || 0, h.summary?.removed || 0, h.summary?.modified || 0, h.summary?.total || 0]))
    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `session_report_${sessionId}.csv`
    link.click()
  }

  const toBePatched = summary?.pre_check?.unique_hosts ?? 0
  const patchedServer = summary?.post_check?.unique_hosts ?? 0
  const unhealthyServers = summary?.hosts_summary?.hosts_with_differences ?? 0
  const totalHosts = toBePatched || patchedServer // fallback
  const failedPre = failedHosts?.pre_check?.hosts || []
  const failedPost = failedHosts?.post_check?.hosts || []
  const totalFailed = new Set([...failedPre, ...failedPost]).size

  return (
    <div className="live-sessions animate-fade-in" id="session-details-view">
      {/* Header */}
      <div className="ls-header glass">
        <div className="ls-header-left">
          <button className="btn-back-round" onClick={onBack} id="btn-back-to-sessions">
            <i className="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <h2><i className="fa-solid fa-chart-column" style={{ color: 'var(--secondary)' }}></i> Session Report</h2>
            <p><code className="ls-session-code-small">{sessionId}</code></p>
          </div>
        </div>
        <div className="ls-header-right">
          <button className="btn-ghost-sm" onClick={handleExportCSV} id="btn-export-session-csv">
            <i className="fa-solid fa-file-csv"></i> Export CSV
          </button>
        </div>
      </div>

      {loading && !summary ? (
        <div className="ls-full-loading glass">
          <i className="fa-solid fa-spinner fa-spin fa-2x" style={{ color: 'var(--accent-text)' }}></i>
          <p>Loading session data from backend...</p>
        </div>
      ) : error ? (
        <div className="ls-alert ls-alert-error"><i className="fa-solid fa-circle-exclamation"></i> {error}</div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="summary-kpi-grid">
            <div className="summary-kpi glass">
              <div className="summary-kpi-icon" style={{ background: 'var(--accent-dim)', color: 'var(--accent-text)' }}>
                <i className="fa-solid fa-server"></i>
              </div>
              <div className="summary-kpi-content">
                <span className="summary-kpi-value">{totalHosts}</span>
                <span className="summary-kpi-label">Total Hosts</span>
              </div>
            </div>
            <div className="summary-kpi glass">
              <div className="summary-kpi-icon" style={{ background: 'var(--success-dim)', color: 'var(--success)' }}>
                <i className="fa-solid fa-server"></i>
              </div>
              <div className="summary-kpi-content">
                <span className="summary-kpi-value">{toBePatched}</span>
                <span className="summary-kpi-label">To be Patched</span>
              </div>
            </div>
            <div className="summary-kpi glass">
              <div className="summary-kpi-icon" style={{ background: 'var(--secondary-dim)', color: 'var(--secondary)' }}>
                <i className="fa-solid fa-check-double"></i>
              </div>
              <div className="summary-kpi-content">
                <span className="summary-kpi-value">{patchedServer}</span>
                <span className="summary-kpi-label">Patched Server</span>
              </div>
            </div>
            <div className="summary-kpi glass">
              <div className="summary-kpi-icon" style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}>
                <i className="fa-solid fa-triangle-exclamation"></i>
              </div>
              <div className="summary-kpi-content">
                <span className="summary-kpi-value">{unhealthyServers}</span>
                <span className="summary-kpi-label">Unhealthy Servers</span>
              </div>
            </div>
            <div className="summary-kpi glass">
              <div className="summary-kpi-icon" style={{ background: totalFailed > 0 ? 'var(--danger-dim)' : 'var(--success-dim)', color: totalFailed > 0 ? 'var(--danger)' : 'var(--success)' }}>
                <i className={`fa-solid ${totalFailed > 0 ? 'fa-triangle-exclamation' : 'fa-shield-check'}`}></i>
              </div>
              <div className="summary-kpi-content">
                <span className="summary-kpi-value" style={{ color: totalFailed > 0 ? 'var(--danger)' : 'inherit' }}>{totalFailed}</span>
                <span className="summary-kpi-label">Failed Hosts</span>
              </div>
            </div>
          </div>

          {/* Host Report Table */}
          <div className="summary-table-wrapper glass">
            <div className="summary-table-header">
              <h3><i className="fa-solid fa-table-list"></i> Unhealthy Server Report</h3>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <label className="ls-toggle-label">
                  <input type="checkbox" checked={onlyDiff} onChange={e => { setOnlyDiff(e.target.checked); loadData(1) }} />
                  Only show diffs
                </label>
                <button className="btn-export" onClick={handleExportCSV} id="btn-export-hosts-csv">
                  <i className="fa-solid fa-file-csv"></i> Export CSV
                </button>
              </div>
            </div>

            <table className="summary-table" id="hosts-report-table">
              <thead>
                <tr>
                  <th>Host Name</th>
                  <th style={{ textAlign: 'center' }}>Added</th>
                  <th style={{ textAlign: 'center' }}>Removed</th>
                  <th style={{ textAlign: 'center' }}>Modified</th>
                  <th style={{ textAlign: 'center' }}>Total Diffs</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {hosts.length === 0 ? (
                  <tr><td colSpan="6"><div className="ls-empty"><i className="fa-solid fa-inbox"></i><p>No host differences found.</p></div></td></tr>
                ) : hosts.map((h, i) => (
                  <React.Fragment key={h.hostname}>
                    <tr
                      className="summary-row"
                      style={{ animationDelay: `${i * 30}ms`, cursor: 'pointer' }}
                      onClick={() => setExpandedHost(expandedHost === h.hostname ? null : h.hostname)}
                    >
                      <td>
                        <div className="summary-server-cell">
                          <i className="fa-solid fa-server" style={{ color: 'var(--text-dimmed)', marginRight: 8 }}></i>
                          <span className="summary-server-name">{h.hostname}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="safe-badge" style={{ background: 'var(--success-dim)', color: 'var(--success)' }}>{h.summary?.added || 0}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="critical-badge">{h.summary?.removed || 0}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="score-badge" style={{ background: 'var(--warning-dim)', color: 'var(--warning)', border: '1px solid var(--warning-border)' }}>{h.summary?.modified || 0}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <strong style={{ color: 'var(--accent-text)' }}>{h.summary?.total || 0}</strong>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn-view-session" onClick={(e) => { e.stopPropagation(); handleExpand(h.hostname) }}>
                          {expandedHost === h.hostname ? 'Hide Report' : 'View Report'} <i className={`fa-solid fa-chevron-${expandedHost === h.hostname ? 'up' : 'down'}`}></i>
                        </button>
                      </td>
                    </tr>
                    {expandedHost === h.hostname && (
                      <tr>
                        <td colSpan="6" style={{ padding: '0', background: 'var(--bg-subtle)' }}>
                          <div className="ls-services-expand">
                            {loadingHost === h.hostname ? (
                                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                                    <i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8, color: 'var(--accent-text)' }}></i> Fetching service details...
                                </div>
                            ) : hostDetails[h.hostname] && hostDetails[h.hostname].length > 0 ? (
                            <table className="ls-services-table">
                              <thead>
                                <tr><th>Service</th><th>Type</th><th>Pre Status</th><th>Post Status</th></tr>
                              </thead>
                              <tbody>
                                {hostDetails[h.hostname].map((svc, si) => (
                                  <tr key={si}>
                                    <td><code style={{ fontSize: 11 }}>{svc.service_name}</code></td>
                                    <td>
                                      <span className={`ls-badge ${svc.type === 'added' ? 'success' : svc.type === 'removed' ? 'danger' : 'warning'}`}>
                                        {svc.type}
                                      </span>
                                    </td>
                                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{svc.pre_check?.status || '—'}</td>
                                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{svc.post_check?.status || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            ) : (
                                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>No service details found.</div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="ls-pagination">
                <button className="btn-back" disabled={page <= 1} onClick={() => loadData(page - 1)}>
                  <i className="fa-solid fa-chevron-left"></i> Prev
                </button>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Page {page} of {totalPages}</span>
                <button className="btn-back" disabled={page >= totalPages} onClick={() => loadData(page + 1)}>
                  Next <i className="fa-solid fa-chevron-right"></i>
                </button>
              </div>
            )}
          </div>

          {/* Failed Hosts */}
          {totalFailed > 0 && (
            <div className="glass ls-failed-section">
              <h3><i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--danger)' }}></i> Unreachable Hosts ({totalFailed})</h3>
              <div className="ls-failed-grid">
                {[...new Set([...failedPre, ...failedPost])].map(host => (
                  <div key={host} className="ls-failed-chip">
                    <i className="fa-solid fa-server" style={{ color: 'var(--danger)' }}></i> {host}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Bar */}
          <div className="action-bar">
            <button className="btn-back" onClick={onBack} id="btn-back-sessions">
              <i className="fa-solid fa-arrow-left"></i> Back to Sessions
            </button>
            <div className="action-bar-info">
              <i className="fa-solid fa-circle-check" style={{ color: 'var(--success)' }}></i>
              <span>Report loaded for session <code>{sessionId}</code>. Click any row to expand service details.</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
