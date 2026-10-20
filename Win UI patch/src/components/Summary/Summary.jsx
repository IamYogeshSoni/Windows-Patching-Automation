import React from 'react'
import './Summary.css'

export default function Summary({ selectedServerIds, allServers, onRestart }) {
  const [isExporting, setIsExporting] = React.useState(false)

  const selectedServers = allServers.filter(s => selectedServerIds.includes(s.id))

  // Simulate results
  const results = selectedServers.map(server => {
    const rand = Math.random()
    const status = rand > 0.1 ? 'success' : 'failed'
    const kbsInstalled = Math.floor(Math.random() * 6) + 1
    const rebootRequired = Math.random() > 0.4
    return {
      ...server,
      patchStatus: status,
      kbsInstalled,
      rebootRequired,
      preCheckScore: '6/6',
      postCheckScore: status === 'success' ? '6/6' : `${Math.floor(Math.random() * 3) + 3}/6`,
      duration: `${Math.floor(Math.random() * 12) + 3}m ${Math.floor(Math.random() * 59)}s`,
    }
  })

  const successCount = results.filter(r => r.patchStatus === 'success').length
  const failedCount = results.filter(r => r.patchStatus === 'failed').length
  const totalKBs = results.reduce((s, r) => s + r.kbsInstalled, 0)

  const handleExportCSV = () => {
    import('xlsx').then(({ utils }) => {
      const ws = utils.json_to_sheet(results.map(r => ({
        'Server Name': r.name,
        'IP Address': r.ip,
        'Environment': r.environment,
        'OS Version': r.os,
        'Critical Updates': r.criticalUpdates,
        'Pre-check Score': r.preCheckScore,
        'Post-check Score': r.postCheckScore,
        'KBs Installed': r.kbsInstalled,
        'Duration': r.duration,
        'Reboot Required': r.rebootRequired ? 'Yes' : 'No',
        'Status': r.patchStatus === 'success' ? 'Success' : 'Failed'
      })))
      const csv = utils.sheet_to_csv(ws)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const link = document.createElement("a")
      const url = URL.createObjectURL(blob)
      link.setAttribute("href", url)
      link.setAttribute("download", "Patching_Summary_Report.csv")
      link.style.visibility = 'hidden'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    })
  }

  const handleExportExcel = () => {
    setIsExporting(true)
    import('xlsx').then(({ utils, writeFile }) => {
      const ws = utils.json_to_sheet(results.map(r => ({
        'Server Name': r.name,
        'IP Address': r.ip,
        'Environment': r.environment,
        'OS Version': r.os,
        'Critical Updates': r.criticalUpdates,
        'Pre-check Score': r.preCheckScore,
        'Post-check Score': r.postCheckScore,
        'KBs Installed': r.kbsInstalled,
        'Duration': r.duration,
        'Reboot Required': r.rebootRequired ? 'Yes' : 'No',
        'Status': r.patchStatus === 'success' ? 'Success' : 'Failed'
      })))
      const wb = utils.book_new()
      utils.book_append_sheet(wb, ws, "Patching Results")
      writeFile(wb, "Patching_Summary_Report.xlsx")
      setIsExporting(false)
    })
  }

  return (
    <div className="summary animate-fade-in" id="summary-view">
      {/* Summary KPIs */}
      <div className="summary-kpi-grid">
        <div className="summary-kpi glass">
          <div className="summary-kpi-icon" style={{ background: 'var(--success-dim)', color: 'var(--success)' }}>
            <i className="fa-solid fa-circle-check"></i>
          </div>
          <div className="summary-kpi-content">
            <span className="summary-kpi-value">{successCount}</span>
            <span className="summary-kpi-label">Servers Patched</span>
          </div>
        </div>
        <div className="summary-kpi glass">
          <div className="summary-kpi-icon" style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>
            <i className="fa-solid fa-circle-xmark"></i>
          </div>
          <div className="summary-kpi-content">
            <span className="summary-kpi-value">{failedCount}</span>
            <span className="summary-kpi-label">Failed</span>
          </div>
        </div>
        <div className="summary-kpi glass">
          <div className="summary-kpi-icon" style={{ background: 'var(--info-dim)', color: 'var(--info)' }}>
            <i className="fa-solid fa-download"></i>
          </div>
          <div className="summary-kpi-content">
            <span className="summary-kpi-value">{totalKBs}</span>
            <span className="summary-kpi-label">KBs Installed</span>
          </div>
        </div>
      </div>

      {/* Results Table */}
      <div className="summary-table-wrapper glass">
        <div className="summary-table-header">
          <h3><i className="fa-solid fa-table-list"></i> Detailed Results</h3>
          <button className="btn-export" id="btn-export-csv" onClick={handleExportCSV}>
            <i className="fa-solid fa-file-csv"></i> Export CSV
          </button>
        </div>

        <table className="summary-table" id="summary-table">
          <thead>
            <tr>
              <th>Server</th>
              <th>Environment</th>
              <th>OS Version</th>
              <th>Critical Updates</th>
              <th>Pre-check</th>
              <th>Post-check</th>
              <th>KBs Installed</th>
              <th>Duration</th>
              <th>Reboot</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={r.id} className="summary-row" style={{ animationDelay: `${i * 40}ms` }}>
                <td>
                  <div className="summary-server-cell">
                    <span className="summary-server-name">{r.name}</span>
                    <span className="summary-server-ip">{r.ip}</span>
                  </div>
                </td>
                <td>
                  <span className={`env-badge env-${r.environment.toLowerCase()}`}>
                    {r.environment === 'Production' ? 'Prod' : r.environment === 'Development' ? 'Dev' : r.environment}
                  </span>
                </td>
                <td><span className="os-badge">{r.os.replace('Windows Server ', 'WS ')}</span></td>
                <td className="center">
                  {r.criticalUpdates > 0 ? (
                    <span className="critical-badge"><i className="fa-solid fa-triangle-exclamation"></i> {r.criticalUpdates}</span>
                  ) : (
                    <span className="safe-badge"><i className="fa-solid fa-check"></i> 0</span>
                  )}
                </td>
                <td><span className="score-badge passed">{r.preCheckScore}</span></td>
                <td>
                  <span className={`score-badge ${r.patchStatus === 'success' ? 'passed' : 'failed'}`}>
                    {r.postCheckScore}
                  </span>
                </td>
                <td className="center">{r.kbsInstalled}</td>
                <td><code>{r.duration}</code></td>
                <td>
                  {r.rebootRequired ? (
                    <span className="reboot-yes"><i className="fa-solid fa-rotate"></i> Yes</span>
                  ) : (
                    <span className="reboot-no">No</span>
                  )}
                </td>
                <td>
                  <span className={`final-status ${r.patchStatus}`}>
                    {r.patchStatus === 'success' ? (
                      <><i className="fa-solid fa-circle-check"></i> Success</>
                    ) : (
                      <><i className="fa-solid fa-circle-xmark"></i> Failed</>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Action Bar */}
      <div className="action-bar">
        <div className="action-bar-info">
          <i className="fa-solid fa-flag-checkered" style={{ color: 'var(--success)' }}></i>
          <span>Patching cycle complete. All evidence collected.</span>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="btn-export-excel" id="btn-export-excel" onClick={handleExportExcel} disabled={isExporting}>
            <i className="fa-solid fa-file-excel"></i> {isExporting ? 'Exporting...' : 'Export Excel'}
          </button>
          <button className="btn-proceed" onClick={onRestart} id="btn-new-cycle">
            <i className="fa-solid fa-plus"></i>
            New Patching Cycle
          </button>
        </div>
      </div>
    </div>
  )
}
