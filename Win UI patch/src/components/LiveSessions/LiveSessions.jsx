import React, { useState, useEffect, useRef } from 'react'
import { fetchReadySessions, fetchPendingSessions, uploadPrecheck, uploadPostcheck } from '../../api/patchingApi'
import SessionDetails from './SessionDetails'
import './LiveSessions.css'

const steps = [
  { id: 1, label: 'Pre-check Upload', icon: 'fa-upload', description: 'Upload pre-check CSV' },
  { id: 2, label: 'Post-check Upload', icon: 'fa-rotate', description: 'Upload post-check CSV' },
  { id: 3, label: 'Live Summary', icon: 'fa-chart-column', description: 'View live results' },
]

const MAX_SIZE_MB = 25

export default function LiveSessions() {
  const [currentStep, setCurrentStep] = useState(1)
  const [viewSessionId, setViewSessionId] = useState(null)

  // Pre-check state
  const [preFile, setPreFile] = useState(null)
  const [preSubmitting, setPreSubmitting] = useState(false)
  const [preSuccess, setPreSuccess] = useState(null)
  const [preError, setPreError] = useState(null)
  const preInputRef = useRef(null)

  // Post-check state
  const [postFile, setPostFile] = useState(null)
  const [postSubmitting, setPostSubmitting] = useState(false)
  const [postSuccess, setPostSuccess] = useState(null)
  const [postError, setPostError] = useState(null)
  const postInputRef = useRef(null)

  // Sessions state
  const [readySessions, setReadySessions] = useState([])
  const [pendingSessions, setPendingSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [pendingSessionId, setPendingSessionId] = useState(null)
  const [pendingShortCode, setPendingShortCode] = useState(null)

  useEffect(() => { loadSessions() }, [])

  const loadSessions = async () => {
    setSessionsLoading(true)
    try {
      const [ready, pending] = await Promise.all([
        fetchReadySessions().catch(() => []),
        fetchPendingSessions().catch(() => [])
      ])
      setReadySessions(ready)
      setPendingSessions(pending)
      if (pending.length > 0) {
        setPendingSessionId(pending[0].session_id)
        setPendingShortCode(pending[0].short_code)
      }
    } finally {
      setSessionsLoading(false)
    }
  }

  const handlePreFileSelect = (f) => {
    setPreError(null)
    if (!f) return setPreFile(null)
    if (!f.name.toLowerCase().endsWith('.csv')) return setPreError('Only CSV files are accepted.')
    if (f.size > MAX_SIZE_MB * 1024 * 1024) return setPreError(`File must be under ${MAX_SIZE_MB}MB.`)
    setPreFile(f)
  }

  const handlePreSubmit = async (e) => {
    e?.preventDefault()
    if (!preFile) return setPreError('Please select a CSV file first.')
    setPreSubmitting(true); setPreError(null)
    try {
      const result = await uploadPrecheck(preFile)
      setPreSuccess(result)
      await loadSessions()
      setCurrentStep(2)
    } catch (err) {
      setPreError(err.message || 'Upload failed. Please try again.')
    } finally { setPreSubmitting(false) }
  }

  const handlePostSubmit = async (e) => {
    e?.preventDefault()
    if (!pendingShortCode) return setPostError('No pending session found. Please complete pre-check first.')
    setPostSubmitting(true); setPostError(null)
    try {
      const result = await uploadPostcheck(pendingShortCode)
      setPostSuccess(result)
      await loadSessions()
      setCurrentStep(3)
    } catch (err) {
      setPostError(err.message || 'Post-check failed. Please try again.')
    } finally { setPostSubmitting(false) }
  }

  if (viewSessionId) {
    return <SessionDetails sessionId={viewSessionId} onBack={() => setViewSessionId(null)} />
  }

  return (
    <div className="live-sessions animate-fade-in" id="live-sessions-view">
      {/* Header */}
      <div className="ls-header glass">
        <div className="ls-header-left">
          <h2><i className="fa-solid fa-bolt" style={{ color: 'var(--accent-text)' }}></i> Live Patching Sessions</h2>
          <p>Upload pre/post-check CSVs and view real-time patching results from the backend</p>
        </div>
        <div className="ls-header-right">
          <button className="btn-ghost-sm" onClick={loadSessions} disabled={sessionsLoading}>
            <i className={`fa-solid fa-rotate ${sessionsLoading ? 'fa-spin' : ''}`}></i> Refresh
          </button>
          <div className="ls-session-pill">
            {pendingSessionId
              ? <><i className="fa-solid fa-circle fa-beat" style={{ color: 'var(--success)', fontSize: 8 }}></i> Active Session</>
              : <><i className="fa-solid fa-circle" style={{ color: 'var(--text-dimmed)', fontSize: 8 }}></i> No Active Session</>
            }
          </div>
        </div>
      </div>

      {/* Stepper */}
      <div className="stepper-container glass" id="ls-stepper">
        <div className="stepper">
          {steps.map((step, index) => {
            const isActive = step.id === currentStep
            const isCompleted = step.id < currentStep
            const isLast = index === steps.length - 1
            return (
              <React.Fragment key={step.id}>
                <button
                  className={`stepper-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
                  onClick={() => isCompleted && setCurrentStep(step.id)}
                  disabled={!isCompleted && !isActive}
                  id={`ls-step-${step.id}`}
                >
                  <div className="step-circle">
                    {isCompleted ? <i className="fa-solid fa-check"></i> : <i className={`fa-solid ${step.icon}`}></i>}
                  </div>
                  <div className="stepper-step-info">
                    <span className="step-label">{step.label}</span>
                    <span className="step-desc">{step.description}</span>
                  </div>
                </button>
                {!isLast && (
                  <div className={`step-connector ${isCompleted ? 'completed' : ''}`}>
                    <div className="connector-line"><div className="connector-fill"></div></div>
                  </div>
                )}
              </React.Fragment>
            )
          })}
        </div>
      </div>

      {/* Step Content */}
      <div className="step-content">
        {currentStep === 1 && (
          <PreCheckUpload
            preFile={preFile} onFileSelect={handlePreFileSelect}
            onSubmit={handlePreSubmit} submitting={preSubmitting}
            success={preSuccess} error={preError} inputRef={preInputRef}
            pendingSessions={pendingSessions} readySessions={readySessions}
            onViewSession={(id) => setViewSessionId(id)}
          />
        )}
        {currentStep === 2 && (
          <PostCheckUpload
            postFile={postFile} onFileSelect={handlePostFileSelect}
            onSubmit={handlePostSubmit} submitting={postSubmitting}
            success={postSuccess} error={postError} inputRef={postInputRef}
            pendingSessionId={pendingSessionId} pendingShortCode={pendingShortCode}
            onBack={() => setCurrentStep(1)}
          />
        )}
        {currentStep === 3 && (
          <LiveSummaryView
            readySessions={readySessions} pendingSessions={pendingSessions}
            loading={sessionsLoading} onRefresh={loadSessions}
            onViewSession={(id) => setViewSessionId(id)}
            onNewCycle={() => { setCurrentStep(1); setPreFile(null); setPreSuccess(null); setPostFile(null); setPostSuccess(null) }}
          />
        )}
      </div>
    </div>
  )

  function handlePostFileSelect(f) {
    setPostError(null)
    if (!f) return setPostFile(null)
    if (!f.name.toLowerCase().endsWith('.csv')) return setPostError('Only CSV files are accepted.')
    if (f.size > MAX_SIZE_MB * 1024 * 1024) return setPostError(`File must be under ${MAX_SIZE_MB}MB.`)
    setPostFile(f)
  }
}

/* ─── Step 1: Pre-check Upload ─── */
function PreCheckUpload({ preFile, onFileSelect, onSubmit, submitting, success, error, inputRef, pendingSessions, readySessions, onViewSession }) {
  return (
    <div className="ls-step-view animate-fade-in">
      <div className="ls-two-col">
        {/* Upload Card */}
        <div className="glass ls-card">
          <div className="ls-card-header">
            <div className="ls-card-icon" style={{ background: 'var(--accent-dim)', color: 'var(--accent-text)' }}>
              <i className="fa-solid fa-upload"></i>
            </div>
            <div>
              <h3>Pre-check CSV Upload</h3>
              <p>Upload a pre-check snapshot file to begin a patching session</p>
            </div>
          </div>

          {success ? (
            <div className="ls-success-banner">
              <i className="fa-solid fa-circle-check"></i>
              <div>
                <strong>Pre-check uploaded successfully!</strong>
                <span>Session ID: <code>{success.session_id}</code></span>
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit}>
              <div
                className={`ls-dropzone ${preFile ? 'has-file' : ''}`}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); onFileSelect(e.dataTransfer.files[0]) }}
              >
                <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }}
                  onChange={(e) => onFileSelect(e.target.files[0])} />
                {preFile ? (
                  <>
                    <i className="fa-solid fa-file-csv" style={{ color: 'var(--success)', fontSize: 32 }}></i>
                    <span className="ls-file-name">{preFile.name}</span>
                    <span className="ls-file-size">{(preFile.size / 1024 / 1024).toFixed(2)} MB</span>
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-cloud-arrow-up" style={{ color: 'var(--text-dimmed)', fontSize: 32 }}></i>
                    <span>Drag & drop or <strong>click to browse</strong></span>
                    <span className="ls-file-hint">CSV files only · Max 25MB</span>
                  </>
                )}
              </div>
              {error && <div className="ls-alert ls-alert-error"><i className="fa-solid fa-circle-exclamation"></i> {error}</div>}
              <div className="ls-card-actions">
                {preFile && <button type="button" className="btn-back" onClick={() => onFileSelect(null)}><i className="fa-solid fa-xmark"></i> Clear</button>}
                <button type="submit" className="btn-proceed" disabled={!preFile || submitting} id="btn-upload-precheck">
                  {submitting ? <><i className="fa-solid fa-spinner fa-spin"></i> Uploading...</> : <>Upload Pre-check <i className="fa-solid fa-arrow-right"></i></>}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Active Sessions Panel */}
        <div className="glass ls-card">
          <div className="ls-card-header">
            <div className="ls-card-icon" style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}>
              <i className="fa-solid fa-clock"></i>
            </div>
            <div>
              <h3>Pending Sessions</h3>
              <p>Currently active sessions awaiting post-check</p>
            </div>
          </div>
          <div className="ls-session-list">
            {pendingSessions.length === 0 ? (
              <div className="ls-empty"><i className="fa-solid fa-inbox"></i><p>No pending sessions</p></div>
            ) : pendingSessions.map(s => (
              <div key={s.session_id} className="ls-session-row pending">
                <div className="ls-session-dot" style={{ background: 'var(--warning)' }}></div>
                <div className="ls-session-info">
                  <code>{s.session_id}</code>
                  <span>Code: {s.short_code}</span>
                </div>
                <span className="ls-badge warning">In Progress</span>
              </div>
            ))}
          </div>
          <div className="ls-ready-section">
            <h4><i className="fa-solid fa-check-circle" style={{ color: 'var(--success)' }}></i> Ready Sessions ({readySessions.length})</h4>
            <div className="ls-session-list">
              {readySessions.length === 0 ? (
                <div className="ls-empty"><i className="fa-solid fa-inbox"></i><p>No completed sessions</p></div>
              ) : readySessions.slice(0, 4).map(s => (
                <div key={s.session_id} className="ls-session-row ready" onClick={() => onViewSession(s.session_id)}>
                  <div className="ls-session-dot" style={{ background: 'var(--success)' }}></div>
                  <div className="ls-session-info">
                    <code>{s.session_id}</code>
                    <span>{new Date(s.created_at).toLocaleString()}</span>
                  </div>
                  <i className="fa-solid fa-chevron-right" style={{ color: 'var(--text-dimmed)' }}></i>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="action-bar">
        <div className="action-bar-info">
          <i className="fa-solid fa-info-circle" style={{ color: 'var(--accent-text)' }}></i>
          <span>Upload a pre-check CSV to create a new patching session, or click a Ready session to view its full report.</span>
        </div>
        <button className="btn-proceed" disabled={!success} onClick={() => {}} id="btn-goto-postcheck" style={{ opacity: success ? 1 : 0.4 }}>
          Continue to Post-check <i className="fa-solid fa-arrow-right"></i>
        </button>
      </div>
    </div>
  )
}

/* ─── Step 2: Post-check Upload ─── */
function PostCheckUpload({ onSubmit, submitting, success, error, pendingSessionId, pendingShortCode, onBack }) {
  return (
    <div className="ls-step-view animate-fade-in">
      <div className="glass ls-card ls-card-centered">
        <div className="ls-card-header">
          <div className="ls-card-icon" style={{ background: 'var(--secondary-dim)', color: 'var(--secondary)' }}>
            <i className="fa-solid fa-rotate"></i>
          </div>
          <div>
            <h3>Post-check Submission</h3>
            <p>Submit the post-check for the active session</p>
          </div>
        </div>

        {pendingSessionId ? (
          <div className="ls-session-info-box glass-strong">
            <div className="ls-info-row"><span>Session ID</span><code>{pendingSessionId}</code></div>
            <div className="ls-info-row"><span>Session Code</span><code>{pendingShortCode}</code></div>
            <div className="ls-info-row"><span>Status</span><span className="ls-badge warning"><i className="fa-solid fa-hourglass-half"></i> Pending Post-check</span></div>
          </div>
        ) : (
          <div className="ls-alert ls-alert-warning">
            <i className="fa-solid fa-triangle-exclamation"></i>
            No pending session found. Please upload a pre-check CSV first to create a session.
          </div>
        )}

        {success ? (
          <div className="ls-success-banner">
            <i className="fa-solid fa-circle-check"></i>
            <div>
              <strong>Post-check submitted successfully!</strong>
              <span>Session is now ready for comparison.</span>
            </div>
          </div>
        ) : null}

        {error && <div className="ls-alert ls-alert-error"><i className="fa-solid fa-circle-exclamation"></i> {error}</div>}
      </div>

      <div className="action-bar">
        <button className="btn-back" onClick={onBack}><i className="fa-solid fa-arrow-left"></i> Back to Pre-check</button>
        <div className="action-bar-info">
          {pendingSessionId && !success && <><i className="fa-solid fa-hourglass-half" style={{ color: 'var(--warning)' }}></i><span>Ready to submit post-check for session <code>{pendingShortCode}</code></span></>}
          {success && <><i className="fa-solid fa-circle-check" style={{ color: 'var(--success)' }}></i><span>Post-check complete! Proceed to view results.</span></>}
        </div>
        <button className="btn-proceed" disabled={!pendingSessionId || submitting || !!success} onClick={onSubmit} id="btn-submit-postcheck">
          {submitting ? <><i className="fa-solid fa-spinner fa-spin"></i> Submitting...</> : <>Submit Post-check <i className="fa-solid fa-arrow-right"></i></>}
        </button>
      </div>
    </div>
  )
}

/* ─── Step 3: Live Summary ─── */
function LiveSummaryView({ readySessions, pendingSessions, loading, onRefresh, onViewSession, onNewCycle }) {
  return (
    <div className="ls-step-view animate-fade-in">
      {/* KPI Row */}
      <div className="ls-kpi-row">
        <div className="glass ls-kpi-card">
          <div className="ls-kpi-icon" style={{ background: 'var(--success-dim)', color: 'var(--success)' }}><i className="fa-solid fa-check-circle"></i></div>
          <div><h3>{readySessions.length}</h3><p>Ready Sessions</p></div>
        </div>
        <div className="glass ls-kpi-card">
          <div className="ls-kpi-icon" style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}><i className="fa-solid fa-hourglass-half"></i></div>
          <div><h3>{pendingSessions.length}</h3><p>Pending Sessions</p></div>
        </div>
        <div className="glass ls-kpi-card">
          <div className="ls-kpi-icon" style={{ background: 'var(--accent-dim)', color: 'var(--accent-text)' }}><i className="fa-solid fa-server"></i></div>
          <div><h3>{readySessions.length + pendingSessions.length}</h3><p>Total Sessions</p></div>
        </div>
      </div>

      {/* Ready Sessions Table */}
      <div className="glass ls-table-card">
        <div className="ls-table-header">
          <h3><i className="fa-solid fa-table-list"></i> Completed Patching Sessions</h3>
          <button className="btn-ghost-sm" onClick={onRefresh} disabled={loading}>
            <i className={`fa-solid fa-rotate ${loading ? 'fa-spin' : ''}`}></i> Refresh
          </button>
        </div>
        <div className="ls-table-wrap">
          <table className="ls-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Created At</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="4" style={{ textAlign: 'center', padding: 32 }}><i className="fa-solid fa-spinner fa-spin"></i> Loading sessions...</td></tr>
              ) : readySessions.length === 0 ? (
                <tr><td colSpan="4"><div className="ls-empty"><i className="fa-solid fa-inbox"></i><p>No completed sessions found</p></div></td></tr>
              ) : readySessions.map((s, i) => (
                <tr key={s.session_id} className="ls-table-row" style={{ animationDelay: `${i * 40}ms` }}>
                  <td><code className="ls-session-code">{s.session_id}</code></td>
                  <td>{new Date(s.created_at).toLocaleString()}</td>
                  <td><span className="ls-badge success"><i className="fa-solid fa-check-circle"></i> Ready</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-view-session" onClick={() => onViewSession(s.session_id)} id={`btn-view-${s.session_id}`}>
                      View Report <i className="fa-solid fa-arrow-right"></i>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="action-bar">
        <div className="action-bar-info">
          <i className="fa-solid fa-flag-checkered" style={{ color: 'var(--success)' }}></i>
          <span>All sessions loaded. Click "View Report" to drill into any session's full diff details.</span>
        </div>
        <button className="btn-proceed" onClick={onNewCycle} id="btn-new-live-cycle">
          <i className="fa-solid fa-plus"></i> New Patching Session
        </button>
      </div>
    </div>
  )
}
