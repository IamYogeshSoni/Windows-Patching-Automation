import React, { useState, useEffect, useRef } from 'react'
import './PreCheck.css'

const checkItems = [
  { id: 'disk', label: 'Disk Space', icon: 'fa-hard-drive', desc: 'Verify ≥ 10GB free' },
  { id: 'reboot', label: 'Pending Reboot', icon: 'fa-rotate', desc: 'No reboot pending' },
  { id: 'services', label: 'Critical Services', icon: 'fa-gears', desc: 'All services running' },
  { id: 'backup', label: 'Backup Status', icon: 'fa-database', desc: 'Recent backup exists' },
  { id: 'wsus', label: 'WSUS Connection', icon: 'fa-plug', desc: 'WSUS reachable' },
  { id: 'snapshot', label: 'VM Snapshot', icon: 'fa-camera', desc: 'Snapshot created' },
]

function simulateCheck() {
  const rand = Math.random()
  if (rand > 0.12) return 'passed'
  if (rand > 0.04) return 'warning'
  return 'failed'
}

export default function PreCheck({ servers, selectedServerIds, allServers, onProceed, onBack }) {
  const [checkResults, setCheckResults] = useState({})
  const [isRunning, setIsRunning] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const [currentServer, setCurrentServer] = useState(null)
  const hasRun = useRef(false)

  const selectedServers = allServers.filter(s => selectedServerIds.includes(s.id))

  useEffect(() => {
    if (hasRun.current) return
    hasRun.current = true
    runChecks()
  }, [])

  const runChecks = async () => {
    setIsRunning(true)
    setIsComplete(false)
    const results = {}

    for (const server of selectedServers) {
      setCurrentServer(server.id)
      results[server.id] = {}

      for (const check of checkItems) {
        await new Promise(r => setTimeout(r, 120 + Math.random() * 200))
        results[server.id][check.id] = simulateCheck()
        setCheckResults({ ...results })
      }
    }

    setCurrentServer(null)
    setIsRunning(false)
    setIsComplete(true)
  }

  const getOverallStatus = (serverId) => {
    const res = checkResults[serverId]
    if (!res) return 'pending'
    const vals = Object.values(res)
    if (vals.length < checkItems.length) return 'running'
    if (vals.some(v => v === 'failed')) return 'failed'
    if (vals.some(v => v === 'warning')) return 'warning'
    return 'passed'
  }

  const totalChecks = selectedServers.length * checkItems.length
  const completedChecks = Object.values(checkResults).reduce(
    (sum, serverChecks) => sum + Object.keys(serverChecks).length, 0
  )
  const progressPct = totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0

  const passedServers = selectedServers.filter(s => getOverallStatus(s.id) === 'passed').length
  const warnServers = selectedServers.filter(s => getOverallStatus(s.id) === 'warning').length
  const failedServers = selectedServers.filter(s => getOverallStatus(s.id) === 'failed').length

  const canProceed = isComplete && failedServers === 0

  return (
    <div className="precheck animate-fade-in" id="precheck-view">
      {/* Progress Header */}
      <div className="precheck-header glass">
        <div className="precheck-header-left">
          <div className="precheck-title">
            <h2>
              <i className="fa-solid fa-clipboard-check" style={{ color: 'var(--accent-text)' }}></i>
              Pre-check Validation
            </h2>
            <p>Running automated health checks on {selectedServers.length} server{selectedServers.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div className="precheck-progress-info">
          <div className="progress-stats">
            <div className="stat-item passed"><i className="fa-solid fa-circle-check"></i> {passedServers} Passed</div>
            <div className="stat-item warned"><i className="fa-solid fa-triangle-exclamation"></i> {warnServers} Warnings</div>
            <div className="stat-item failed"><i className="fa-solid fa-circle-xmark"></i> {failedServers} Failed</div>
          </div>
          <div className="progress-bar-container">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${progressPct}%` }}></div>
            </div>
            <span className="progress-percent">{progressPct}%</span>
          </div>
        </div>
      </div>

      {/* Server Check Cards */}
      <div className="precheck-grid">
        {selectedServers.map((server, i) => {
          const status = getOverallStatus(server.id)
          const results = checkResults[server.id] || {}
          const isCurrent = currentServer === server.id

          return (
            <div
              key={server.id}
              className={`precheck-card glass ${status} ${isCurrent ? 'scanning' : ''}`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="precheck-card-header">
                <div className="card-server-info">
                  <span className="card-server-name">{server.name}</span>
                  <span className="card-server-meta">{server.ip} • {server.os.replace('Windows Server ', 'WS ')}</span>
                </div>
                <div className={`card-status-badge ${status}`}>
                  {status === 'running' && <i className="fa-solid fa-spinner fa-spin"></i>}
                  {status === 'passed' && <i className="fa-solid fa-circle-check"></i>}
                  {status === 'warning' && <i className="fa-solid fa-triangle-exclamation"></i>}
                  {status === 'failed' && <i className="fa-solid fa-circle-xmark"></i>}
                  {status === 'pending' && <i className="fa-solid fa-clock"></i>}
                  <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
                </div>
              </div>

              <div className="check-items-grid">
                {checkItems.map(check => {
                  const result = results[check.id]
                  return (
                    <div key={check.id} className={`check-item ${result || 'pending'}`}>
                      <i className={`fa-solid ${check.icon}`}></i>
                      <span className="check-label">{check.label}</span>
                      <span className="check-result">
                        {!result && <span className="pending-dot"></span>}
                        {result === 'passed' && <i className="fa-solid fa-check"></i>}
                        {result === 'warning' && <i className="fa-solid fa-exclamation"></i>}
                        {result === 'failed' && <i className="fa-solid fa-xmark"></i>}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Action Bar */}
      <div className="action-bar">
        <button className="btn-back" onClick={onBack} id="btn-back-to-select">
          <i className="fa-solid fa-arrow-left"></i>
          Back to Server Selection
        </button>
        <div className="action-bar-info">
          {isRunning && (
            <>
              <i className="fa-solid fa-spinner fa-spin" style={{ color: 'var(--accent-text)' }}></i>
              <span>Running pre-check validations...</span>
            </>
          )}
          {isComplete && canProceed && (
            <>
              <i className="fa-solid fa-circle-check" style={{ color: 'var(--success)' }}></i>
              <span>All checks passed. Ready to proceed.</span>
            </>
          )}
          {isComplete && !canProceed && (
            <>
              <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--danger)' }}></i>
              <span>{failedServers} server{failedServers !== 1 ? 's' : ''} failed validation. Review and retry.</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          {isComplete && !canProceed && (
            <button className="btn-retry" onClick={() => { hasRun.current = false; setCheckResults({}); runChecks() }} id="btn-retry-checks">
              <i className="fa-solid fa-rotate-right"></i>
              Re-run Checks
            </button>
          )}
          <button
            className="btn-proceed"
            disabled={!canProceed}
            onClick={onProceed}
            id="btn-proceed-postcheck"
          >
            Proceed to Patching
            <i className="fa-solid fa-arrow-right"></i>
          </button>
        </div>
      </div>
    </div>
  )
}
