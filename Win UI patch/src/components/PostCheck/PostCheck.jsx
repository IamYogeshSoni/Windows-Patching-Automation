import React, { useState, useEffect, useRef } from 'react'
import './PostCheck.css'

const patchStages = [
  { id: 'downloading', label: 'Downloading', icon: 'fa-download' },
  { id: 'installing', label: 'Installing', icon: 'fa-wrench' },
  { id: 'rebooting', label: 'Rebooting', icon: 'fa-power-off' },
  { id: 'verifying', label: 'Verifying', icon: 'fa-check-double' },
]

export default function PostCheck({ selectedServerIds, allServers, onProceed, onBack }) {
  const [patchStatus, setPatchStatus] = useState({})
  const [isRunning, setIsRunning] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const hasRun = useRef(false)
  const selectedServers = allServers.filter(s => selectedServerIds.includes(s.id))

  useEffect(() => {
    if (hasRun.current) return
    hasRun.current = true
    runPatching()
  }, [])

  const runPatching = async () => {
    setIsRunning(true)
    const status = {}
    for (const server of selectedServers) {
      status[server.id] = { stage: 0, progress: 0, status: 'running', stages: {} }
      setPatchStatus({ ...status })
      for (let si = 0; si < patchStages.length; si++) {
        const stage = patchStages[si]
        status[server.id].stage = si
        status[server.id].stages[stage.id] = 'running'
        setPatchStatus({ ...status })
        const steps = 5 + Math.floor(Math.random() * 6)
        for (let p = 0; p <= steps; p++) {
          await new Promise(r => setTimeout(r, 60 + Math.random() * 100))
          status[server.id].progress = Math.min(((si * 25) + ((p / steps) * 25)), 100)
          setPatchStatus({ ...status })
        }
        const rand = Math.random()
        status[server.id].stages[stage.id] = rand > 0.06 ? 'completed' : 'failed'
        if (status[server.id].stages[stage.id] === 'failed') {
          status[server.id].status = 'failed'
          status[server.id].progress = ((si + 1) * 25)
          setPatchStatus({ ...status })
          break
        }
      }
      if (status[server.id].status !== 'failed') {
        status[server.id].status = 'completed'
        status[server.id].progress = 100
      }
      setPatchStatus({ ...status })
    }
    setIsRunning(false)
    setIsComplete(true)
  }

  const completedCount = Object.values(patchStatus).filter(s => s.status === 'completed').length
  const failedCount = Object.values(patchStatus).filter(s => s.status === 'failed').length
  const runningCount = Object.values(patchStatus).filter(s => s.status === 'running').length
  const pendingCount = selectedServers.length - completedCount - failedCount - runningCount
  const overallProgress = selectedServers.length > 0
    ? Math.round(Object.values(patchStatus).reduce((sum, s) => sum + (s.progress || 0), 0) / selectedServers.length) : 0

  return (
    <div className="postcheck animate-fade-in" id="postcheck-view">
      <div className="postcheck-header glass">
        <div className="postcheck-header-left">
          <h2><i className="fa-solid fa-rotate" style={{ color: 'var(--secondary)' }}></i> Patch Deployment</h2>
          <p>Applying Windows updates to {selectedServers.length} server{selectedServers.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="postcheck-stats">
          <div className="post-stat"><span className="post-stat-value" style={{ color: 'var(--success)' }}>{completedCount}</span><span className="post-stat-label">Done</span></div>
          <div className="post-stat"><span className="post-stat-value" style={{ color: 'var(--accent-text)' }}>{runningCount}</span><span className="post-stat-label">Running</span></div>
          <div className="post-stat"><span className="post-stat-value" style={{ color: 'var(--text-muted)' }}>{pendingCount}</span><span className="post-stat-label">Pending</span></div>
          <div className="post-stat"><span className="post-stat-value" style={{ color: 'var(--danger)' }}>{failedCount}</span><span className="post-stat-label">Failed</span></div>
        </div>
        <div className="overall-progress">
          <div className="overall-ring">
            <svg viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" fill="none" strokeWidth="6" style={{ stroke: 'var(--border-glass)' }} />
              <circle cx="40" cy="40" r="34" fill="none" stroke="url(#grad)" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={`${(overallProgress / 100) * 213.6} 213.6`} transform="rotate(-90 40 40)"
                style={{ transition: 'stroke-dasharray 0.5s ease' }} />
              <defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" style={{ stopColor: 'var(--accent)' }} /><stop offset="100%" style={{ stopColor: 'var(--accent-hover)' }} />
              </linearGradient></defs>
            </svg>
            <span className="ring-text">{overallProgress}%</span>
          </div>
        </div>
      </div>

      <div className="patch-server-list">
        {selectedServers.map((server, i) => {
          const ps = patchStatus[server.id] || { stage: -1, progress: 0, status: 'pending', stages: {} }
          return (
            <div key={server.id} className={`patch-server-row glass ${ps.status}`} style={{ animationDelay: `${i * 50}ms` }}>
              <div className="patch-server-info">
                <div className="patch-server-icon">
                  {ps.status === 'completed' && <i className="fa-solid fa-circle-check" style={{ color: 'var(--success)' }}></i>}
                  {ps.status === 'failed' && <i className="fa-solid fa-circle-xmark" style={{ color: 'var(--danger)' }}></i>}
                  {ps.status === 'running' && <i className="fa-solid fa-spinner fa-spin" style={{ color: 'var(--accent-text)' }}></i>}
                  {ps.status === 'pending' && <i className="fa-solid fa-clock" style={{ color: 'var(--text-dimmed)' }}></i>}
                </div>
                <div>
                  <span className="patch-server-name">{server.name}</span>
                  <span className="patch-server-meta">{server.ip} • {server.environment}</span>
                </div>
              </div>
              <div className="patch-stages">
                {patchStages.map((stage, si) => {
                  const ss = ps.stages[stage.id] || (ps.status === 'running' && ps.stage === si ? 'running' : 'pending')
                  return (
                    <div key={stage.id} className={`patch-stage ${ss}`}>
                      <div className="stage-icon-wrap">
                        {ss === 'completed' && <i className="fa-solid fa-check"></i>}
                        {ss === 'running' && <i className={`fa-solid ${stage.icon} fa-pulse`}></i>}
                        {ss === 'failed' && <i className="fa-solid fa-xmark"></i>}
                        {ss === 'pending' && <i className={`fa-solid ${stage.icon}`}></i>}
                      </div>
                      <span className="stage-label">{stage.label}</span>
                    </div>
                  )
                })}
              </div>
              <div className="patch-progress-section">
                <div className="patch-progress-bar">
                  <div className={`patch-progress-fill ${ps.status}`} style={{ width: `${ps.progress || 0}%` }}></div>
                </div>
                <span className="patch-progress-pct">{Math.round(ps.progress || 0)}%</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="action-bar">
        <button className="btn-back" onClick={onBack}><i className="fa-solid fa-arrow-left"></i> Back</button>
        <div className="action-bar-info">
          {isRunning && <><i className="fa-solid fa-spinner fa-spin" style={{ color: 'var(--secondary)' }}></i><span>Deploying patches...</span></>}
          {isComplete && <><i className="fa-solid fa-flag-checkered" style={{ color: 'var(--success)' }}></i><span>{completedCount} succeeded, {failedCount} failed.</span></>}
        </div>
        <button className="btn-proceed" disabled={!isComplete} onClick={onProceed}>View Summary <i className="fa-solid fa-arrow-right"></i></button>
      </div>
    </div>
  )
}
