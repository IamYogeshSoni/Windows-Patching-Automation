import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import './PatchPipeline.css'
import allServers from '../../data/servers'

/* ─────────────────────────────────────────────
   Stage Definitions  (based on read.text spec)
───────────────────────────────────────────── */
const STAGES = [
  { id: 1,  key: 'pre-patch-state',      short: 'Pre-Patch State',    label: 'Capturing Pre-Patch State',          icon: 'fa-camera',          ms: 3200, canSkip: false, desc: 'Collecting baseline data — installed KBs, running services, uptime, CPU/memory metrics, and registry snapshots from all target servers.' },
  { id: 2,  key: 'preparing-updates',    short: 'Prepare Updates',    label: 'Preparing Updates',                  icon: 'fa-box-archive',     ms: 2400, canSkip: false, desc: 'Validating Software Update Group "Server – May 2026" in SCCM. Confirming all required patches are approved and distributed.' },
  { id: 3,  key: 'assigning-updates',    short: 'Assign Updates',     label: 'Assigning Updates to Test Servers',  icon: 'fa-network-wired',   ms: 2000, canSkip: false, desc: 'Creating SCCM deployment targeting the "POC Patch Testing" collection and assigning the SUG to all selected test servers.' },
  { id: 4,  key: 'configuring-settings', short: 'Configure Settings', label: 'Configuring Deployment Settings',    icon: 'fa-sliders',         ms: 1800, canSkip: false, desc: 'Applying deployment config: deadline set to "As Soon As Possible", UTC timezone, suppressing user notifications, enabling alert suppression.' },
  { id: 5,  key: 'scheduling-window',    short: 'Schedule Window',    label: 'Scheduling the Install Window',      icon: 'fa-calendar-check',  ms: 1600, canSkip: false, desc: 'Configuring maintenance window: 05:00–10:00 UTC. Patches will only install within this approved window.' },
  { id: 6,  key: 'installing-patches',   short: 'Install Patches',    label: 'Installing Patches',                 icon: 'fa-download',        ms: 5800, canSkip: false, desc: 'Patch installation in progress across all servers. SCCM client is downloading and applying updates per deployment policy.' },
  { id: 7,  key: 'verifying-results',    short: 'Verify Results',     label: 'Verifying Results',                  icon: 'fa-magnifying-glass', ms: 3000, canSkip: false, desc: 'Querying SCCM for per-server deployment state. Waiting for all servers to report Installed or Error status.' },
  { id: 8,  key: 'post-patch-state',     short: 'Post-Patch State',   label: 'Capturing Post-Patch State',         icon: 'fa-camera-retro',    ms: 2800, canSkip: true,  desc: 'Re-capturing server state post-patch: installed KBs, running services, uptime, and registry. Used for diff comparison against baseline.' },
  { id: 9,  key: 'comparing-state',      short: 'Compare State',      label: 'Comparing Pre vs Post State',        icon: 'fa-code-compare',    ms: 2500, canSkip: true,  desc: 'Diffing pre vs post snapshots. Flagging: missing KBs, services that failed to restart, unexpected reboots, and configuration anomalies.' },
  { id: 10, key: 'generating-report',    short: 'Send Report',        label: 'Generating & Sending Report',        icon: 'fa-file-lines',      ms: 2200, canSkip: false, desc: 'Compiling structured report with per-server results and emailing to ops-patching@company.com with an "Action Needed: Yes/No" triage flag.' },
]

const S = { PENDING: 'pending', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', FAILED: 'failed', SKIPPED: 'skipped' }
const STATUS_LABEL = { [S.PENDING]: 'Pending', [S.IN_PROGRESS]: 'In Progress', [S.COMPLETED]: 'Completed', [S.FAILED]: 'Failed', [S.SKIPPED]: 'Skipped' }

/* ─── CMDB Data: enrich servers with owner/risk/patch-window ─── */
const OWNER_TEAMS = ['Platform Ops', 'App Infra', 'Network Eng', 'DBA Team', 'Security Ops', 'Cloud Eng']
const RISK_LEVELS = ['High', 'Medium', 'Low']
const PATCH_WINDOWS = ['05:00–10:00 UTC', '22:00–04:00 UTC', '02:00–06:00 UTC', '18:00–00:00 UTC']

function enrichWithCMDB(servers) {
  return servers.map((srv, i) => ({
    ...srv,
    owner: OWNER_TEAMS[i % OWNER_TEAMS.length],
    risk: srv.criticalUpdates >= 3 ? 'High' : srv.criticalUpdates >= 1 ? 'Medium' : 'Low',
    patchWindow: PATCH_WINDOWS[i % PATCH_WINDOWS.length],
    selected: true,
  }))
}

const CMDB_SERVERS = enrichWithCMDB(allServers.slice(0, 15))

/* ─── Application Validation Lane ─── */
const APP_VAL_STEPS = [
  { id: 'harness',       label: 'Harness',       icon: 'fa-play',              desc: 'Scheduled / release trigger',   ms: 1800 },
  { id: 'playwright',    label: 'Playwright',     icon: 'fa-masks-theater',     desc: 'UI journeys + screenshots',     ms: 2500 },
  { id: 'new-relic',     label: 'New Relic',      icon: 'fa-chart-line',        desc: 'API + dashboard signals',       ms: 2000 },
  { id: 'microservices', label: 'Microservices',  icon: 'fa-cubes',             desc: 'Endpoint health probes',        ms: 1600 },
  { id: 'evidence',      label: 'Evidence',       icon: 'fa-file-shield',       desc: 'HTML / PDF evidence bundle',    ms: 1400 },
  { id: 'notify',        label: 'Notify',         icon: 'fa-bell',              desc: 'Email / Teams routing',         ms: 1000 },
]

/* ─── CountUp hook ─── */
function useCountUp(target, duration = 700) {
  const [val, setVal] = useState(0)
  const prev = useRef(0)
  useEffect(() => {
    const start = prev.current
    if (start === target) return
    const steps = 24
    const stepMs = duration / steps
    let step = 0
    const id = setInterval(() => {
      step++
      const t = step / steps
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      setVal(Math.round(start + (target - start) * eased))
      if (step >= steps) { clearInterval(id); setVal(target); prev.current = target }
    }, stepMs)
    return () => clearInterval(id)
  }, [target, duration])
  return val
}

/* ─── Helpers ─── */
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

function generateResults(servers, gatePassed) {
  const errorCodes = ['0x80240022', '0x8024401C', '0x80070005', '0x80072EFD', '0x8024200D']
  return servers.map(srv => {
    const ok = Math.random() > 0.15
    const prePatch = rand(3, 10)
    const postPatch = ok ? prePatch : rand(0, prePatch - 1)
    const svcChanged = rand(0, 5)
    const rebootExp = Math.random() > 0.35
    const rebootOcc = ok ? rebootExp : !rebootExp
    const anomalies = ok ? (Math.random() > 0.55 ? 0 : rand(1, 2)) : rand(1, 4)
    const code = ok ? '0x00000000' : errorCodes[rand(0, 4)]
    return {
      ...srv,
      deployStatus: ok ? 'success' : 'failed',
      prePatch, postPatch: gatePassed ? postPatch : null,
      svcChanged: gatePassed ? svcChanged : null,
      rebootExp, rebootOcc: gatePassed ? rebootOcc : null,
      rebootMatch: gatePassed ? (rebootOcc === rebootExp) : null,
      code, anomalies: gatePassed ? anomalies : null,
      hasAnomaly: gatePassed && anomalies > 0,
      /* Evidence view extras */
      riskScore: srv.risk === 'High' ? rand(70, 95) : srv.risk === 'Medium' ? rand(35, 65) : rand(5, 30),
      slaImpact: ok ? 'None' : (Math.random() > 0.5 ? 'SLA Breach' : 'Degraded'),
    }
  })
}

/* ═══════════════════════════════════════════
   KPI Card with animated counter
═══════════════════════════════════════════ */
function KpiCard({ icon, value, label, colorClass }) {
  const animated = useCountUp(value)
  return (
    <div className="pp-kpi-card">
      <div className={`pp-kpi-icon-wrap ${colorClass}`}><i className={`fa-solid ${icon}`} /></div>
      <div className="pp-kpi-content">
        <div className="pp-kpi-val">{animated}</div>
        <div className="pp-kpi-lbl">{label}</div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Pre-Validate Sub-Check Component
═══════════════════════════════════════════ */
const PRE_VALIDATE_CHECKS = [
  { id: 'infra',  label: 'Infra Baseline',  icon: 'fa-server',      desc: 'Services, uptime, patch count' },
  { id: 'api',    label: 'API Health',       icon: 'fa-cloud',       desc: 'Key endpoint ping check' },
  { id: 'ui',     label: 'UI Smoke',         icon: 'fa-desktop',     desc: 'App responding check' },
]

function PreValidatePanel({ checks }) {
  return (
    <div className="pp-prevalidate-panel" key="prevalidate">
      <div className="pp-prevalidate-title">
        <i className="fa-solid fa-shield-halved" />
        <span>Pre-Validate Sub-Checks</span>
      </div>
      <div className="pp-prevalidate-checks">
        {PRE_VALIDATE_CHECKS.map((chk, i) => {
          const status = checks[chk.id] || 'pending'
          return (
            <div key={chk.id} className={`pp-prevalidate-item pp-pv-${status}`} style={{ animationDelay: `${i * 80}ms` }}>
              <div className={`pp-pv-icon pp-pv-icon-${status}`}>
                {status === 'running' && <i className="fa-solid fa-spinner fa-spin" />}
                {status === 'pass' && <i className="fa-solid fa-check" />}
                {status === 'fail' && <i className="fa-solid fa-xmark" />}
                {status === 'pending' && <i className={`fa-solid ${chk.icon}`} />}
              </div>
              <div className="pp-pv-text">
                <div className="pp-pv-label">{chk.label}</div>
                <div className="pp-pv-desc">{chk.desc}</div>
              </div>
              <div className={`pp-pv-badge pp-pv-badge-${status}`}>
                {status === 'pending' && 'Queued'}
                {status === 'running' && 'Running…'}
                {status === 'pass' && 'Pass'}
                {status === 'fail' && 'Fail'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   HITL Approval Gate Component
═══════════════════════════════════════════ */
function HITLApprovalGate({ servers, onApprove, onReject }) {
  const highRisk = servers.filter(s => s.risk === 'High').length
  const medRisk = servers.filter(s => s.risk === 'Medium').length
  const lowRisk = servers.filter(s => s.risk === 'Low').length
  return (
    <div className="pp-hitl-gate" id="hitl-approval-gate">
      <div className="pp-hitl-header">
        <div className="pp-hitl-icon-wrap">
          <i className="fa-solid fa-user-shield" />
        </div>
        <div>
          <div className="pp-hitl-title">Human-in-the-Loop Approval Required</div>
          <div className="pp-hitl-subtitle">Pipeline paused — awaiting authorized operator approval before patch deployment</div>
        </div>
      </div>

      <div className="pp-hitl-body">
        <div className="pp-hitl-summary-card">
          <div className="pp-hitl-summary-title">Change Request Summary</div>
          <div className="pp-hitl-summary-grid">
            <div className="pp-hitl-field">
              <span className="pp-hitl-field-label">Target Servers</span>
              <span className="pp-hitl-field-value">{servers.length}</span>
            </div>
            <div className="pp-hitl-field">
              <span className="pp-hitl-field-label">Patch Window</span>
              <span className="pp-hitl-field-value">05:00–10:00 UTC</span>
            </div>
            <div className="pp-hitl-field">
              <span className="pp-hitl-field-label">SUG</span>
              <span className="pp-hitl-field-value">Server – May 2026</span>
            </div>
            <div className="pp-hitl-field">
              <span className="pp-hitl-field-label">Environment</span>
              <span className="pp-hitl-field-value">Test / POC</span>
            </div>
          </div>
          <div className="pp-hitl-risk-row">
            <span className="pp-hitl-risk-label">Risk Profile:</span>
            <span className="pp-risk-badge pp-risk-high">{highRisk} High</span>
            <span className="pp-risk-badge pp-risk-medium">{medRisk} Medium</span>
            <span className="pp-risk-badge pp-risk-low">{lowRisk} Low</span>
          </div>
        </div>

        <div className="pp-hitl-actions">
          <button className="pp-btn-approve" onClick={onApprove} id="btn-hitl-approve">
            <i className="fa-solid fa-check-double" /> Approve & Continue
          </button>
          <button className="pp-btn-reject" onClick={onReject} id="btn-hitl-reject">
            <i className="fa-solid fa-ban" /> Reject & Abort
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Application Validation Lane Component
═══════════════════════════════════════════ */
function AppValidationLane({ stepStatuses, activeStep }) {
  return (
    <div className="pp-section pp-appval-section">
      <div className="pp-section-header">
        <span className="pp-section-title">APPLICATION VALIDATION LANE</span>
        {activeStep && (
          <span className="pp-section-active-lbl">
            <span className="pp-live-dot" />
            {activeStep}
          </span>
        )}
      </div>
      <div className="pp-appval-track-wrap">
        <div className="pp-appval-track">
          {APP_VAL_STEPS.map((step, idx) => {
            const status = stepStatuses[step.id] || 'pending'
            const isActive = status === 'in_progress'
            return (
              <React.Fragment key={step.id}>
                {idx > 0 && (
                  <div className={`pp-appval-connector ${status === 'completed' || status === 'in_progress' ? 'pp-appval-connector-filled' : ''}`} />
                )}
                <div className={`pp-appval-node pp-appval-${status}`} style={{ animationDelay: `${idx * 65}ms` }}>
                  <div className={`pp-appval-circle ${isActive ? 'pp-appval-active' : ''}`}>
                    {status === 'completed' && <i className="fa-solid fa-check" />}
                    {status === 'failed' && <i className="fa-solid fa-xmark" />}
                    {status === 'in_progress' && <i className={`fa-solid ${step.icon} pp-icon-spin`} />}
                    {status === 'pending' && <i className={`fa-solid ${step.icon}`} />}
                  </div>
                  <div className="pp-appval-label">{step.label}</div>
                  <div className="pp-appval-desc">{step.desc}</div>
                  <div className={`pp-status-chip pp-chip-${status}`}>{STATUS_LABEL[status] || 'Pending'}</div>
                </div>
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Evidence & Escalation View Component
═══════════════════════════════════════════ */
function EvidenceView({ results, servers }) {
  const [activeTab, setActiveTab] = useState('risk')
  const highRiskFailed = results.filter(r => r.riskScore >= 70 && r.deployStatus === 'failed')
  const hasEscalation = highRiskFailed.length > 0

  /* Group by owner for Owner Actions tab */
  const byOwner = {}
  results.forEach(r => {
    const owner = r.owner || 'Unknown'
    if (!byOwner[owner]) byOwner[owner] = []
    byOwner[owner].push(r)
  })

  return (
    <div className="pp-section pp-evidence-section">
      <div className="pp-section-header">
        <span className="pp-section-title">EVIDENCE & ESCALATION VIEW</span>
        {hasEscalation && (
          <span className="pp-escalation-indicator">
            <i className="fa-solid fa-triangle-exclamation" /> Escalation Required
          </span>
        )}
      </div>

      {/* Tab strip */}
      <div className="pp-ev-tabs">
        <button className={`pp-ev-tab ${activeTab === 'risk' ? 'pp-ev-tab-active' : ''}`} onClick={() => setActiveTab('risk')}>
          <i className="fa-solid fa-shield-halved" /> Risk & SLA
        </button>
        <button className={`pp-ev-tab ${activeTab === 'owner' ? 'pp-ev-tab-active' : ''}`} onClick={() => setActiveTab('owner')}>
          <i className="fa-solid fa-users" /> Owner Actions
        </button>
        <button className={`pp-ev-tab ${activeTab === 'escalate' ? 'pp-ev-tab-active' : ''}`} onClick={() => setActiveTab('escalate')}>
          <i className="fa-solid fa-bell" /> Escalation
          {hasEscalation && <span className="pp-ev-tab-badge">{highRiskFailed.length}</span>}
        </button>
      </div>

      {/* Tab content: Risk & SLA */}
      {activeTab === 'risk' && (
        <div className="pp-ev-content pp-ev-risk-content">
          <div className="pp-table-wrap">
            <table className="pp-table" id="pp-evidence-risk-table">
              <thead>
                <tr>
                  <th>Server</th><th>Risk Level</th><th className="pp-th-center">Risk Score</th>
                  <th>SLA Impact</th><th>Deploy Status</th><th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={r.id} style={{ animationDelay: `${i * 30}ms` }}
                      className={r.riskScore >= 70 ? 'pp-tr-high-risk' : ''}>
                    <td>
                      <div className="pp-cell-name">
                        <i className="fa-solid fa-server pp-row-srv-icon" />
                        <span>{r.name}</span>
                      </div>
                    </td>
                    <td><span className={`pp-risk-badge pp-risk-${r.risk?.toLowerCase()}`}>{r.risk}</span></td>
                    <td className="pp-td-center">
                      <div className="pp-risk-score-bar">
                        <div className={`pp-risk-score-fill pp-risk-fill-${r.riskScore >= 70 ? 'high' : r.riskScore >= 35 ? 'med' : 'low'}`}
                             style={{ width: `${r.riskScore}%` }} />
                        <span className="pp-risk-score-num">{r.riskScore}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`pp-sla-chip pp-sla-${r.slaImpact === 'None' ? 'ok' : r.slaImpact === 'Degraded' ? 'warn' : 'breach'}`}>
                        {r.slaImpact}
                      </span>
                    </td>
                    <td>
                      <span className={`pp-deploy-chip ${r.deployStatus === 'success' ? 'pp-deploy-ok' : 'pp-deploy-fail'}`}>
                        <i className={`fa-solid ${r.deployStatus === 'success' ? 'fa-circle-check' : 'fa-circle-xmark'}`} />
                        {r.deployStatus === 'success' ? 'Success' : 'Failed'}
                      </span>
                    </td>
                    <td><span className="pp-owner-label">{r.owner}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab content: Owner Actions */}
      {activeTab === 'owner' && (
        <div className="pp-ev-content pp-ev-owner-content">
          {Object.entries(byOwner).map(([owner, srvs]) => {
            const needsAction = srvs.filter(s => s.deployStatus === 'failed' || s.hasAnomaly)
            return (
              <div className="pp-owner-group" key={owner}>
                <div className="pp-owner-group-header">
                  <div className="pp-owner-group-left">
                    <i className="fa-solid fa-users" />
                    <span className="pp-owner-group-name">{owner}</span>
                    <span className="pp-owner-group-count">{srvs.length} server{srvs.length !== 1 ? 's' : ''}</span>
                  </div>
                  {needsAction.length > 0 && (
                    <span className="pp-owner-action-badge">
                      <i className="fa-solid fa-flag" /> {needsAction.length} need{needsAction.length === 1 ? 's' : ''} attention
                    </span>
                  )}
                </div>
                <div className="pp-owner-group-servers">
                  {srvs.map(s => (
                    <div key={s.id} className={`pp-owner-srv ${s.deployStatus === 'failed' || s.hasAnomaly ? 'pp-owner-srv-alert' : ''}`}>
                      <i className="fa-solid fa-server" />
                      <span className="pp-owner-srv-name">{s.name}</span>
                      <span className={`pp-risk-badge pp-risk-${s.risk?.toLowerCase()}`}>{s.risk}</span>
                      <span className={`pp-deploy-chip ${s.deployStatus === 'success' ? 'pp-deploy-ok' : 'pp-deploy-fail'}`}>
                        {s.deployStatus === 'success' ? 'OK' : 'Failed'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Tab content: Escalation */}
      {activeTab === 'escalate' && (
        <div className="pp-ev-content pp-ev-escalate-content">
          {hasEscalation ? (
            <div className="pp-escalation-alert">
              <div className="pp-escalation-alert-header">
                <div className="pp-escalation-alert-icon">
                  <i className="fa-solid fa-bell" />
                </div>
                <div>
                  <div className="pp-escalation-alert-title">SME Escalation Alert</div>
                  <div className="pp-escalation-alert-desc">
                    {highRiskFailed.length} high-risk server{highRiskFailed.length !== 1 ? 's' : ''} failed deployment. Immediate SME review and potential rollback required.
                  </div>
                </div>
              </div>
              <div className="pp-escalation-servers">
                {highRiskFailed.map(s => (
                  <div key={s.id} className="pp-escalation-srv-row">
                    <div className="pp-cell-name"><i className="fa-solid fa-server pp-row-srv-icon" /><span>{s.name}</span></div>
                    <span className="pp-risk-badge pp-risk-high">Risk: {s.riskScore}</span>
                    <code className="pp-code pp-code-err">{s.code}</code>
                    <span className="pp-sla-chip pp-sla-breach">{s.slaImpact}</span>
                    <span className="pp-owner-label">{s.owner}</span>
                  </div>
                ))}
              </div>
              <div className="pp-escalation-routing">
                <i className="fa-solid fa-paper-plane" />
                <span>Routed to: <strong>SME Team</strong> via Email + Microsoft Teams</span>
              </div>
            </div>
          ) : (
            <div className="pp-escalation-clear">
              <i className="fa-solid fa-circle-check" />
              <div className="pp-escalation-clear-title">No Escalation Needed</div>
              <div className="pp-escalation-clear-desc">All high-risk servers passed deployment successfully. No SME intervention required.</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


/* ════════════════════════════════════════════
   PatchPipeline Component
════════════════════════════════════════════ */
export default function PatchPipeline() {
  const initStatuses = () => Object.fromEntries(STAGES.map(s => [s.key, S.PENDING]))

  /* Core cycle state */
  const [cycleState,    setCycleState]   = useState('idle')      // idle | cmdb_loading | cmdb | running | hitl_gate | complete
  const [statuses,      setStatuses]     = useState(initStatuses)
  const [poppingStage,  setPoppingStage] = useState(null)
  const [activeId,      setActiveId]     = useState(null)
  const [stageProgress, setStageProgress] = useState(0)
  const [gateVisible,   setGateVisible]  = useState(false)
  const [gatePassed,    setGatePassed]   = useState(null)
  const [results,       setResults]      = useState([])
  const [reportReady,   setReportReady]  = useState(false)
  const [rollbackDone,  setRollbackDone] = useState(false)
  const [startTime,     setStartTime]    = useState(null)
  const cancelled = useRef(false)
  const cmdbLoadingTimer = useRef(null)

  /* Enhancement 1: CMDB */
  const [cmdbServers, setCmdbServers] = useState(CMDB_SERVERS)

  /* Enhancement 2: Pre-validate sub-checks */
  const [preValChecks, setPreValChecks] = useState({ infra: 'pending', api: 'pending', ui: 'pending' })

  /* Enhancement 3: HITL */
  const [hitlVisible,  setHitlVisible]  = useState(false)
  const [hitlResult,   setHitlResult]   = useState(null) // null | 'approved' | 'rejected'
  const [hitlApprover, setHitlApprover] = useState(null)
  const hitlResolve = useRef(null)

  /* Enhancement 4: App Validation Lane */
  const [appValStatuses, setAppValStatuses] = useState(Object.fromEntries(APP_VAL_STEPS.map(s => [s.id, 'pending'])))
  const [appValActive,   setAppValActive]   = useState(null)
  const [appValDone,     setAppValDone]     = useState(false)

  /* Enhancement 5: Generic server filters */
  const [serverTypeFilter, setServerTypeFilter] = useState('all')
  const [environmentFilter, setEnvironmentFilter] = useState('all')

  /* Enhancement 6: Prepare Updates readiness gate */
  const [readinessPrompt, setReadinessPrompt] = useState(null)
  const [readinessSummary, setReadinessSummary] = useState('')
  const [readinessServers, setReadinessServers] = useState([])
  const readinessResolve = useRef(null)

  /* derived */
  const getServerPlatform = (server) => {
    const os = (server?.os || '').toLowerCase()
    return os.includes('linux') || os.includes('rhel') || os.includes('ubuntu') || os.includes('centos') || os.includes('suse')
      ? 'linux'
      : 'windows'
  }

  const filteredCmdbServers = useMemo(() => {
    return cmdbServers.filter((srv) => {
      const platform = getServerPlatform(srv)
      const environment = (srv.environment || '').toLowerCase()
      const matchesType = serverTypeFilter === 'all' || platform === serverTypeFilter
      const matchesEnvironment = environmentFilter === 'all' || (environmentFilter === 'prod' ? environment === 'production' : environment !== 'production')
      return matchesType && matchesEnvironment
    })
  }, [cmdbServers, serverTypeFilter, environmentFilter])

  const selectedServers = filteredCmdbServers.filter(s => s.selected)
  const targetServerCount = ['cmdb', 'running', 'hitl_gate', 'complete'].includes(cycleState) ? selectedServers.length : 0
  const completedCount  = Object.values(statuses).filter(v => v === S.COMPLETED).length
  const overallPct      = Math.round((completedCount / STAGES.length) * 100)
  const patchedCount    = results.filter(r => r.deployStatus === 'success').length
  const failedCount     = results.filter(r => r.deployStatus === 'failed').length
  const hasAnomalies    = results.some(r => r.hasAnomaly)
  const activeStage     = STAGES.find(s => s.id === activeId)

  const setS = (key, status) => setStatuses(prev => ({ ...prev, [key]: status }))
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  const promptReadiness = (prompt) => {
    setReadinessPrompt(prompt)
    setReadinessServers(prompt.servers || [])
    return new Promise(resolve => {
      readinessResolve.current = resolve
    })
  }

  const handleReadinessChoice = (choice) => {
    if (readinessResolve.current) {
      const resolve = readinessResolve.current
      readinessResolve.current = null
      setReadinessPrompt(null)
      resolve(choice)
    }
  }

  useEffect(() => {
    return () => {
      if (cmdbLoadingTimer.current) clearTimeout(cmdbLoadingTimer.current)
    }
  }, [])

  const animateProgress = durationMs => new Promise(resolve => {
    const steps = 50
    const stepMs = durationMs / steps
    let step = 0
    setStageProgress(0)
    const id = setInterval(() => {
      if (cancelled.current) { clearInterval(id); resolve(); return }
      step++
      const t = step / steps
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      setStageProgress(Math.min(Math.round(eased * 100), 99))
      if (step >= steps) { clearInterval(id); setStageProgress(100); resolve() }
    }, stepMs)
  })

  const completeStage = async (key) => {
    setS(key, S.COMPLETED)
    setPoppingStage(key)
    await sleep(420)
    setPoppingStage(null)
  }

  /* ─── Toggle CMDB server selection ─── */
  const toggleServer = (id) => {
    setCmdbServers(prev => prev.map(s => s.id === id ? { ...s, selected: !s.selected } : s))
  }
  const toggleAll = () => {
    const visibleIds = filteredCmdbServers.map(s => s.id)
    if (visibleIds.length === 0) return
    const allSelected = filteredCmdbServers.every(s => s.selected)
    setCmdbServers(prev => prev.map(s => visibleIds.includes(s.id) ? { ...s, selected: !allSelected } : s))
  }

  /* ─── Enter CMDB selection phase ─── */
  const openCmdb = () => {
    if (cmdbLoadingTimer.current) clearTimeout(cmdbLoadingTimer.current)
    setCycleState('cmdb_loading')
    cmdbLoadingTimer.current = setTimeout(() => {
      setCycleState('cmdb')
      cmdbLoadingTimer.current = null
    }, 10000)
  }

  /* ─── Run Pre-Validate sub-checks ─── */
  const runPreValidate = async () => {
    for (const chk of PRE_VALIDATE_CHECKS) {
      if (cancelled.current) return
      setPreValChecks(prev => ({ ...prev, [chk.id]: 'running' }))
      await sleep(900 + rand(200, 600))
      if (cancelled.current) return
      const pass = Math.random() > 0.1
      setPreValChecks(prev => ({ ...prev, [chk.id]: pass ? 'pass' : 'fail' }))
      await sleep(300)
    }
  }

  /* ─── Run App Validation Lane ─── */
  const runAppValidation = async () => {
    setAppValStatuses(Object.fromEntries(APP_VAL_STEPS.map(s => [s.id, 'pending'])))
    setAppValDone(false)
    for (const step of APP_VAL_STEPS) {
      if (cancelled.current) return
      setAppValActive(step.label)
      setAppValStatuses(prev => ({ ...prev, [step.id]: 'in_progress' }))
      await sleep(step.ms)
      if (cancelled.current) return
      const ok = Math.random() > 0.08
      setAppValStatuses(prev => ({ ...prev, [step.id]: ok ? 'completed' : 'failed' }))
      await sleep(250)
    }
    setAppValActive(null)
    setAppValDone(true)
  }

  const runPrepareUpdateGate = async () => {
    const snapshot = selectedServers.map(srv => ({
      ...srv,
      isActive: srv.status !== 'offline',
      diskUsage: rand(72, 98)
    }))
    setReadinessServers(snapshot)

    const inactiveServers = snapshot.filter(srv => !srv.isActive)
    if (inactiveServers.length > 0) {
      const availabilityChoice = await promptReadiness({
        type: 'inactive',
        title: 'Availability review required',
        message: `${inactiveServers.length} selected server(s) appear inactive. Review the risk before proceeding.`,
        servers: inactiveServers,
        actions: ['accept', 'reject']
      })
      if (cancelled.current || availabilityChoice === 'reject') {
        setReadinessSummary('Patch prep was rejected. The cycle was stopped before deployment.')
        return false
      }
    }

    const highUsageServers = snapshot.filter(srv => srv.diskUsage >= 90)
    const lowUsageServers = snapshot.filter(srv => srv.diskUsage < 90)
    const diskChoice = await promptReadiness({
      type: 'disk',
      title: 'Disk usage review',
      message: highUsageServers.length > 0
        ? `${highUsageServers.length} server(s) are at or above 90% disk usage. Clean logs to continue safely.`
        : 'All selected servers are below 90% disk usage and look ready for patching.',
      servers: snapshot,
      highUsageServers,
      lowUsageServers,
      actions: highUsageServers.length > 0 ? ['clean-logs', 'continue'] : ['continue']
    })

    if (cancelled.current) return false

    if (diskChoice === 'clean-logs') {
      setReadinessSummary('Disk cleanup requested. All selected servers are now ready for patching and can proceed.')
      return true
    }

    setReadinessSummary('Disk usage review completed. Selected servers can proceed to the patching workflow.')
    return true
  }

  /* ─── Main Start Cycle ─── */
  const startCycle = async () => {
    if (selectedServers.length === 0) return
    cancelled.current = false
    setCycleState('running')
    setStartTime(new Date())
    setStatuses(initStatuses())
    setActiveId(null)
    setStageProgress(0)
    setGateVisible(false)
    setGatePassed(null)
    setResults([])
    setReportReady(false)
    setRollbackDone(false)
    setPreValChecks({ infra: 'pending', api: 'pending', ui: 'pending' })
    setHitlVisible(false)
    setHitlResult(null)
    setHitlApprover(null)
    setAppValStatuses(Object.fromEntries(APP_VAL_STEPS.map(s => [s.id, 'pending'])))
    setAppValActive(null)
    setAppValDone(false)
    setServerTypeFilter('all')
    setEnvironmentFilter('all')

    /* Stage 1 — with Pre-Validate sub-checks */
    const stg1 = STAGES[0]
    setActiveId(stg1.id)
    setS(stg1.key, S.IN_PROGRESS)
    // Run baseline checks and application validation during Pre-Patch State.
    await Promise.all([animateProgress(stg1.ms), runPreValidate(), runAppValidation()])
    if (cancelled.current) return
    await completeStage(stg1.key)
    setActiveId(null)
    await sleep(260)

    /* Stages 2–3 */
    for (let i = 1; i < 3; i++) {
      if (cancelled.current) return
      const stg = STAGES[i]
      setActiveId(stg.id)
      setS(stg.key, S.IN_PROGRESS)
      await animateProgress(stg.ms)
      if (stg.key === 'preparing-updates') {
        const readinessPassed = await runPrepareUpdateGate()
        if (!readinessPassed) {
          setS(stg.key, S.FAILED)
          setCycleState('complete')
          return
        }
      }
      await completeStage(stg.key)
      setActiveId(null)
      await sleep(260)
    }

    /* Enhancement 3: HITL Approval Gate between Stage 3 and Stage 4 */
    if (cancelled.current) return
    setHitlVisible(true)
    setCycleState('hitl_gate')

    // Wait for user to approve or reject
    const hitlDecision = await new Promise(resolve => {
      hitlResolve.current = resolve
    })

    if (cancelled.current) return

    if (hitlDecision === 'rejected') {
      setHitlResult('rejected')
      setCycleState('complete')
      // Mark remaining stages as skipped
      for (let i = 3; i < STAGES.length; i++) {
        setS(STAGES[i].key, S.SKIPPED)
      }
      return
    }

    setHitlResult('approved')
    setHitlApprover('operator@company.com')
    setCycleState('running')
    await sleep(800)
    setHitlVisible(false)

    /* Stages 4–7 */
    for (let i = 3; i < 7; i++) {
      if (cancelled.current) return
      const stg = STAGES[i]
      setActiveId(stg.id)
      setS(stg.key, S.IN_PROGRESS)
      await animateProgress(stg.ms)
      await completeStage(stg.key)
      setActiveId(null)
      await sleep(260)
    }

    /* Health-Check Gate */
    setGateVisible(true)
    await sleep(1100)
    if (cancelled.current) return
    const passed = Math.random() > 0.28
    setGatePassed(passed)
    await sleep(1600)

    if (passed) {
      for (let i = 7; i < 9; i++) {
        if (cancelled.current) return
        const stg = STAGES[i]
        setActiveId(stg.id)
        setS(stg.key, S.IN_PROGRESS)
        await animateProgress(stg.ms)
        await completeStage(stg.key)
        setActiveId(null)
        await sleep(260)
      }
    } else {
      setS(STAGES[7].key, S.SKIPPED)
      setS(STAGES[8].key, S.SKIPPED)
      await sleep(500)
    }

    /* Stage 10 — always */
    if (cancelled.current) return
    const stg10 = STAGES[9]
    const serverResults = generateResults(selectedServers, passed)
    setActiveId(stg10.id)
    setS(stg10.key, S.IN_PROGRESS)
    await animateProgress(stg10.ms)
    if (cancelled.current) return
    await completeStage(stg10.key)

    setResults(serverResults)
    setReportReady(true)

    /* Run the second application validation after patching, within Stage 10. */
    await runAppValidation()
    if (cancelled.current) return
    setActiveId(null)

    setCycleState('complete')
  }

  /* HITL callbacks */
  const handleHitlApprove = () => {
    if (hitlResolve.current) hitlResolve.current('approved')
  }
  const handleHitlReject = () => {
    if (hitlResolve.current) hitlResolve.current('rejected')
  }

  const resetCycle = () => {
    cancelled.current = true
    if (cmdbLoadingTimer.current) {
      clearTimeout(cmdbLoadingTimer.current)
      cmdbLoadingTimer.current = null
    }
    if (hitlResolve.current) { hitlResolve.current('rejected'); hitlResolve.current = null }
    setCycleState('idle')
    setStatuses(initStatuses())
    setActiveId(null)
    setStageProgress(0)
    setGateVisible(false)
    setGatePassed(null)
    setResults([])
    setReportReady(false)
    setRollbackDone(false)
    setStartTime(null)
    setPreValChecks({ infra: 'pending', api: 'pending', ui: 'pending' })
    setHitlVisible(false)
    setHitlResult(null)
    setHitlApprover(null)
    setAppValStatuses(Object.fromEntries(APP_VAL_STEPS.map(s => [s.id, 'pending'])))
    setAppValActive(null)
    setAppValDone(false)
    setServerTypeFilter('all')
    setEnvironmentFilter('all')
    setReadinessPrompt(null)
    setReadinessSummary('')
    setReadinessServers([])
    readinessResolve.current = null
  }

  /* ════════════════════════════════════════
     RENDER
  ════════════════════════════════════════ */
  const isRunning = cycleState === 'running' || cycleState === 'hitl_gate'

  return (
    <div className="pp-root">

      {/* ── Page Header ── */}
      <div className="pp-header">
        <div className="pp-header-left">
          <div className="pp-breadcrumb">
            <i className="fa-solid fa-house-chimney" />
            <span className="pp-bc-active">Patch Pipeline</span>
          </div>
          <div className="pp-title-row">
            <h1 className="pp-title">Patch Cycle — Server May 2026</h1>
            <span className="pp-env-badge">TEST ENV</span>
            <span className="pp-sug-badge">SUG: Server – May 2026</span>
          </div>
          {startTime && (
            <div className="pp-meta-row">
              <span><i className="fa-regular fa-clock" /> Started: {startTime.toUTCString()}</span>
              <span className="pp-meta-sep">·</span>
              <span><i className="fa-solid fa-calendar-days" /> Window: 05:00–10:00 UTC</span>
              <span className="pp-meta-sep">·</span>
              <span><i className="fa-solid fa-layer-group" /> Collection: POC Patch Testing</span>
              {hitlResult === 'approved' && <>
                <span className="pp-meta-sep">·</span>
                <span className="pp-hitl-approved-tag"><i className="fa-solid fa-user-check" /> Approved by {hitlApprover}</span>
              </>}
            </div>
          )}
        </div>
        <div className="pp-header-actions">
          {cycleState === 'idle' && (
            <button className="pp-btn-primary" onClick={openCmdb} id="btn-start-cycle">
              <i className="fa-solid fa-play" /> Start Cycle
            </button>
          )}
          {cycleState === 'cmdb_loading' && (
            <div className="pp-running-indicator pp-cmdb-fetch-indicator">
              <i className="fa-solid fa-database pp-icon-spin" />
              Fetching CMDB
            </div>
          )}
          {cycleState === 'running' && (
            <div className="pp-running-indicator">
              <span className="pp-live-dot" />
              Cycle Running
            </div>
          )}
          {cycleState === 'hitl_gate' && (
            <div className="pp-running-indicator pp-hitl-waiting-indicator">
              <i className="fa-solid fa-user-shield" />
              Awaiting Approval
            </div>
          )}
          {cycleState === 'complete' && (
            <button className="pp-btn-outline" onClick={resetCycle} id="btn-new-cycle">
              <i className="fa-solid fa-arrow-rotate-left" /> New Cycle
            </button>
          )}
        </div>
      </div>

      {/* ── KPI Row ── */}
      <div className="pp-kpi-row">
        <KpiCard icon="fa-server"       value={targetServerCount} label="Target Servers" colorClass="pp-kpi-blue"  />
        <KpiCard icon="fa-circle-check" value={patchedCount}           label="Patched"        colorClass="pp-kpi-green" />
        <KpiCard icon="fa-circle-xmark" value={failedCount}            label="Failed"         colorClass="pp-kpi-red"   />
        <div className="pp-kpi-card">
          <div className="pp-kpi-icon-wrap pp-kpi-slate"><i className="fa-solid fa-list-check" /></div>
          <div className="pp-kpi-content">
            <div className="pp-kpi-val">
              {completedCount}<span className="pp-kpi-total">/{STAGES.length}</span>
            </div>
            <div className="pp-kpi-lbl">Stages Done</div>
          </div>
        </div>
        {isRunning && (
          <div className="pp-kpi-card pp-kpi-progress-card">
            <div className="pp-kpi-progress-body">
              <div className="pp-kpi-progress-header">
                <span className="pp-kpi-lbl">Overall Progress</span>
                <span className="pp-kpi-progress-pct">{overallPct}%</span>
              </div>
              <div className="pp-overall-track">
                <div className="pp-overall-fill" style={{ width: `${overallPct}%` }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════
         Enhancement 1: CMDB Inventory Panel
      ═══════════════════════════════════════ */}
      {cycleState === 'cmdb_loading' && (
        <div className="pp-section pp-cmdb-loading-section" role="status" aria-live="polite">
          <div className="pp-cmdb-loader-shell">
            <div className="pp-cmdb-loader-icon">
              <i className="fa-solid fa-database"></i>
              <span className="pp-cmdb-loader-ring"></span>
            </div>
            <div className="pp-cmdb-loader-copy">
              <span className="pp-section-title">FETCHING SERVER DETAILS FROM CMDB</span>
              <h2>Please wait while we load the target inventory</h2>
              <p>
                NOVA is querying CMDB for server ownership, risk level, patch windows, operating system data, and current reachability.
              </p>
            </div>
            <div className="pp-cmdb-loader-steps">
              <span><i className="fa-solid fa-circle-check"></i> Connecting to CMDB</span>
              <span><i className="fa-solid fa-spinner fa-spin"></i> Resolving server details</span>
              <span><i className="fa-regular fa-clock"></i> Preparing selection table</span>
            </div>
          </div>
        </div>
      )}

      {cycleState === 'cmdb' && (
        <div className="pp-section pp-cmdb-section">
          <div className="pp-section-header">
            <span className="pp-section-title">CMDB INVENTORY — SERVER SELECTION</span>
            <span className="pp-cmdb-selected-count">
              <i className="fa-solid fa-check-double" /> {selectedServers.length} of {filteredCmdbServers.length} selected
            </span>
          </div>
          <div className="pp-cmdb-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="pp-filter-label">Server Type</span>
              <button type="button" className={`pp-btn-sm ${serverTypeFilter === 'all' ? 'pp-btn-primary' : 'pp-btn-outline'}`} onClick={() => setServerTypeFilter('all')}>All</button>
              <button type="button" className={`pp-btn-sm ${serverTypeFilter === 'windows' ? 'pp-btn-primary' : 'pp-btn-outline'}`} onClick={() => setServerTypeFilter('windows')}>Windows</button>
              <button type="button" className={`pp-btn-sm ${serverTypeFilter === 'linux' ? 'pp-btn-primary' : 'pp-btn-outline'}`} onClick={() => setServerTypeFilter('linux')}>Linux</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="pp-filter-label">Environment</span>
              <button type="button" className={`pp-btn-sm ${environmentFilter === 'all' ? 'pp-btn-primary' : 'pp-btn-outline'}`} onClick={() => setEnvironmentFilter('all')}>All</button>
              <button type="button" className={`pp-btn-sm ${environmentFilter === 'prod' ? 'pp-btn-primary' : 'pp-btn-outline'}`} onClick={() => setEnvironmentFilter('prod')}>Prod</button>
              <button type="button" className={`pp-btn-sm ${environmentFilter === 'non-prod' ? 'pp-btn-primary' : 'pp-btn-outline'}`} onClick={() => setEnvironmentFilter('non-prod')}>Non-Prod</button>
            </div>
            <button className="pp-btn-outline pp-btn-sm" onClick={toggleAll}>
              <i className={`fa-solid ${filteredCmdbServers.length > 0 && filteredCmdbServers.every(s => s.selected) ? 'fa-square-minus' : 'fa-square-check'}`} />
              {filteredCmdbServers.length > 0 && filteredCmdbServers.every(s => s.selected) ? 'Deselect All' : 'Select All'}
            </button>
            <div className="pp-cmdb-risk-summary">
              <span className="pp-risk-badge pp-risk-high"><i className="fa-solid fa-circle" /> {filteredCmdbServers.filter(s => s.risk === 'High').length} High</span>
              <span className="pp-risk-badge pp-risk-medium"><i className="fa-solid fa-circle" /> {filteredCmdbServers.filter(s => s.risk === 'Medium').length} Med</span>
              <span className="pp-risk-badge pp-risk-low"><i className="fa-solid fa-circle" /> {filteredCmdbServers.filter(s => s.risk === 'Low').length} Low</span>
            </div>
          </div>
          <div className="pp-cmdb-help-banner">
            <i className="fa-solid fa-circle-info" />
            <span>Select the servers you want to patch, then use Confirm &amp; Start when you are ready.</span>
          </div>
          <div className="pp-table-wrap">
            <table className="pp-table" id="pp-cmdb-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}><input type="checkbox" checked={cmdbServers.every(s => s.selected)} onChange={toggleAll} /></th>
                  <th>Server Name</th><th>IP Address</th><th>OS</th><th>Environment</th>
                  <th>Risk Level</th><th>Owner Team</th><th>Patch Window</th><th>Last Patched</th>
                </tr>
              </thead>
              <tbody>
                {filteredCmdbServers.map((srv, i) => (
                      <tr key={srv.id} className={`pp-cmdb-row ${srv.selected ? 'pp-cmdb-row-selected' : ''} ${srv.status === 'offline' ? 'pp-cmdb-row-offline' : ''}`}
                      style={{ animationDelay: `${i * 25}ms` }}
                      onClick={() => toggleServer(srv.id)}>
                    <td><input type="checkbox" checked={srv.selected} onChange={() => toggleServer(srv.id)} onClick={e => e.stopPropagation()} /></td>
                    <td>
                      <div className="pp-cell-name">
                        <i className={`fa-solid fa-server pp-row-srv-icon ${srv.status === 'offline' ? 'pp-srv-offline' : ''}`} />
                        <span>{srv.name}</span>
                        {srv.status === 'offline' && <span className="pp-offline-badge">Offline</span>}
                      </div>
                    </td>
                    <td><code className="pp-code">{srv.ip}</code></td>
                    <td className="pp-cmdb-os">{srv.os}</td>
                    <td><span className={`pp-env-chip pp-env-${srv.environment.toLowerCase().replace(' ', '-')}`}>{srv.environment}</span></td>
                    <td><span className={`pp-risk-badge pp-risk-${srv.risk.toLowerCase()}`}>{srv.risk}</span></td>
                    <td><span className="pp-owner-label">{srv.owner}</span></td>
                    <td className="pp-cmdb-window">{srv.patchWindow}</td>
                    <td className="pp-cmdb-lastpatched">{srv.lastPatched}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pp-cmdb-footer">
            <button className="pp-btn-outline" onClick={() => setCycleState('idle')}>
              <i className="fa-solid fa-arrow-left" /> Back
            </button>
            <button className="pp-btn-primary" onClick={startCycle} disabled={selectedServers.length === 0} id="btn-confirm-start">
              <i className="fa-solid fa-rocket" /> Confirm & Start ({selectedServers.length} servers)
            </button>
          </div>
        </div>
      )}

      {/* ── Pipeline Stage Track ── */}
      {cycleState !== 'cmdb' && cycleState !== 'cmdb_loading' && (
        <div className="pp-section pp-pipeline-section">
          <div className="pp-section-header">
            <span className="pp-section-title">PIPELINE STAGES</span>
            {isRunning && activeStage && (
              <span className="pp-section-active-lbl">
                <span className="pp-live-dot" />
                {activeStage.label}
              </span>
            )}
          </div>

          <div className="pp-stage-track-wrap">
            <div className={`pp-stage-track ${cycleState !== 'idle' ? 'pp-track-started' : ''}`}>
              {STAGES.map((stg, idx) => {
                const status = statuses[stg.key]
                const isActive = activeId === stg.id
                const isPopping = poppingStage === stg.key
                const isGateConn = idx === 6
                const isHitlConn = idx === 3
                const prevCompleted = idx > 0 && statuses[STAGES[idx - 1].key] === S.COMPLETED

                return (
                  <React.Fragment key={stg.key}>
                    {/* Connector */}
                    {idx > 0 && (
                      <div className={`pp-connector ${prevCompleted ? 'pp-connector-filled' : ''} ${isGateConn ? 'pp-connector-gate-after' : ''} ${isHitlConn ? 'pp-connector-gate-after' : ''}`}>
                        {isGateConn && gateVisible && (
                          <div className={`pp-gate-pip ${gatePassed === null ? 'checking' : gatePassed ? 'pass' : 'fail'}`}>
                            <i className={`fa-solid ${gatePassed === null ? 'fa-spinner fa-spin' : gatePassed ? 'fa-shield-halved' : 'fa-triangle-exclamation'}`} />
                            <span>{gatePassed === null ? 'Checking…' : gatePassed ? 'Pass' : 'Fail'}</span>
                          </div>
                        )}
                        {isHitlConn && (hitlVisible || hitlResult) && (
                          <div className={`pp-gate-pip ${hitlResult === null ? 'checking' : hitlResult === 'approved' ? 'pass' : 'fail'}`}>
                            <i className={`fa-solid ${hitlResult === null ? 'fa-user-shield' : hitlResult === 'approved' ? 'fa-check-double' : 'fa-ban'}`} />
                            <span>{hitlResult === null ? 'HITL' : hitlResult === 'approved' ? 'Approved' : 'Rejected'}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Stage Node */}
                    <div
                      className={`pp-stage-node ${status} ${isActive ? 'pp-stage-active' : ''} ${isPopping ? 'pp-stage-pop' : ''}`}
                      style={{ animationDelay: `${idx * 55}ms` }}
                    >
                      <div className="pp-stage-circle">
                        {status === S.COMPLETED   && <i className="fa-solid fa-check" />}
                        {status === S.FAILED       && <i className="fa-solid fa-xmark" />}
                        {status === S.SKIPPED      && <i className="fa-solid fa-minus" />}
                        {status === S.IN_PROGRESS  && <i className={`fa-solid ${stg.icon} pp-icon-spin`} />}
                        {status === S.PENDING      && <span className="pp-stage-num">{stg.id}</span>}
                      </div>
                      <div className="pp-stage-short">{stg.short}</div>
                      <div className={`pp-status-chip pp-chip-${status}`}>{STATUS_LABEL[status]}</div>
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          </div>

          {/* Active Stage Detail Panel */}
          {isRunning && activeStage && (
            <div className="pp-active-panel" key={activeStage.key}>
              <div className="pp-active-panel-left">
                <div className="pp-active-icon">
                  <i className={`fa-solid ${activeStage.icon}`} />
                </div>
                <div className="pp-active-text">
                  <div className="pp-active-name">
                    <span className="pp-active-step">Stage {activeStage.id} of {STAGES.length}</span>
                    {activeStage.label}
                  </div>
                  <div className="pp-active-desc">{activeStage.desc}</div>
                </div>
              </div>
              <div className="pp-active-right">
                <div className="pp-active-pct">{stageProgress}%</div>
                <div className="pp-active-bar-track">
                  <div className="pp-active-bar-fill" style={{ width: `${stageProgress}%` }}>
                    <div className="pp-bar-shimmer" />
                  </div>
                </div>
                <div className="pp-active-lbl">In Progress</div>
              </div>
            </div>
          )}

          {/* Enhancement 2: Pre-Validate sub-checks (visible during Stage 1) */}
          {isRunning && activeId === 1 && (
            <PreValidatePanel checks={preValChecks} />
          )}
          {/* Also show when Stage 1 is done but cycle is still running for a moment */}
          {isRunning && !activeId && statuses['pre-patch-state'] === S.COMPLETED && completedCount === 1 && (
            <PreValidatePanel checks={preValChecks} />
          )}
        </div>
      )}

      {readinessPrompt && (
        <div className="pp-section pp-cmdb-section" style={{ marginTop: 20 }}>
          <div className="pp-section-header">
            <span className="pp-section-title">PREPARE UPDATES — READINESS GATE</span>
            <span className="pp-section-active-lbl">
              <i className="fa-solid fa-shield-halved" /> {readinessPrompt.type === 'inactive' ? 'Availability Review' : 'Disk Review'}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 12, marginTop: 12, padding: '4px 8px 8px 8px' }}>
            <div style={{ fontSize: '1.02rem', fontWeight: 700, paddingLeft: 4 }}>{readinessPrompt.title}</div>
            <div className="pp-readiness-message">{readinessPrompt.message}</div>
            <div style={{ display: 'grid', gap: 8, paddingLeft: 2, paddingRight: 2 }}>
              {readinessServers.map((srv) => (
                <div
                  key={srv.id}
                  className={`pp-readiness-row ${(
                    readinessPrompt.type === 'inactive'
                      ? !srv.isActive
                      : typeof srv.diskUsage === 'number' && srv.diskUsage >= 90
                  ) ? 'pp-readiness-alert' : ''}`}
                >
                  <span className="pp-readiness-name">{srv.name}</span>
                  <span className="pp-readiness-meta">
                    {readinessPrompt.type === 'inactive'
                      ? (srv.isActive ? 'Active' : 'Inactive')
                      : `${srv.diskUsage}% disk usage`}
                  </span>
                </div>
              ))}
            </div>
            {readinessSummary && (
              <div className="pp-readiness-summary">
                {readinessSummary}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
              {readinessPrompt.actions.includes('accept') && (
                <button type="button" className="pp-btn-primary" onClick={() => handleReadinessChoice('accept')}>
                  <i className="fa-solid fa-check" /> Accept & Continue
                </button>
              )}
              {readinessPrompt.actions.includes('reject') && (
                <button type="button" className="pp-btn-outline" onClick={() => handleReadinessChoice('reject')}>
                  <i className="fa-solid fa-ban" /> Reject & Abort
                </button>
              )}
              {readinessPrompt.actions.includes('clean-logs') && (
                <button type="button" className="pp-btn-outline" onClick={() => handleReadinessChoice('clean-logs')}>
                  <i className="fa-solid fa-broom" /> Clean Logs
                </button>
              )}
              {readinessPrompt.actions.includes('continue') && (
                <button type="button" className="pp-btn-outline" onClick={() => handleReadinessChoice('continue')}>
                  <i className="fa-solid fa-arrow-right" /> Continue
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════
         Enhancement 3: HITL Approval Gate
      ═══════════════════════════════════════ */}
      {hitlVisible && cycleState === 'hitl_gate' && (
        <HITLApprovalGate servers={selectedServers} onApprove={handleHitlApprove} onReject={handleHitlReject} />
      )}

      {/* HITL approved/rejected banner */}
      {hitlResult === 'approved' && !hitlVisible && (
        <div className="pp-gate-banner pp-gate-pass">
          <div className="pp-gate-banner-left">
            <div className="pp-gate-icon-wrap pass"><i className="fa-solid fa-user-check" /></div>
            <div className="pp-gate-text">
              <div className="pp-gate-title">HITL Approval — <strong>APPROVED</strong></div>
              <div className="pp-gate-desc">Change approved by {hitlApprover}. Pipeline proceeding to deployment stages 4–10.</div>
            </div>
          </div>
          <div className="pp-gate-route-pill pass">4 → 5 → 6 → 7 → Gate → 8–10</div>
        </div>
      )}
      {hitlResult === 'rejected' && (
        <div className="pp-gate-banner pp-gate-fail">
          <div className="pp-gate-banner-left">
            <div className="pp-gate-icon-wrap fail"><i className="fa-solid fa-ban" /></div>
            <div className="pp-gate-text">
              <div className="pp-gate-title">HITL Approval — <strong>REJECTED</strong></div>
              <div className="pp-gate-desc">Change request rejected by operator. All remaining stages have been skipped. No patches were deployed.</div>
            </div>
          </div>
          <div className="pp-gate-route-pill fail">Pipeline Aborted</div>
        </div>
      )}

      {/* ── Health-Check Gate Banner ── */}
      {gateVisible && gatePassed !== null && (
        <div className={`pp-gate-banner ${gatePassed ? 'pp-gate-pass' : 'pp-gate-fail'}`}>
          <div className="pp-gate-banner-left">
            <div className={`pp-gate-icon-wrap ${gatePassed ? 'pass' : 'fail'}`}>
              <i className={`fa-solid ${gatePassed ? 'fa-shield-halved' : 'fa-triangle-exclamation'}`} />
            </div>
            <div className="pp-gate-text">
              <div className="pp-gate-title">
                Health-Check Gate — <strong>{gatePassed ? 'PASSED' : 'FAILED'}</strong>
              </div>
              <div className="pp-gate-desc">
                {gatePassed
                  ? 'Deployment verified successfully. Pipeline proceeding to post-patch state capture (Stage 8) and comparison (Stage 9).'
                  : 'Deployment failed health verification. Stages 8 & 9 marked Skipped. Pipeline routing directly to report generation (Stage 10).'}
              </div>
            </div>
          </div>
          <div className={`pp-gate-route-pill ${gatePassed ? 'pass' : 'fail'}`}>
            {gatePassed ? '8 → 9 → 10' : 'Skip 8 & 9 → 10'}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════
         Enhancement 4: Application Validation Lane
      ═══════════════════════════════════════ */}
      {((isRunning && (activeId === 1 || activeId === 10)) || (reportReady && appValDone)) && (
        <AppValidationLane stepStatuses={appValStatuses} activeStep={appValActive} />
      )}

      {/* ── Report Panel ── */}
      {reportReady && (
        <div className="pp-section pp-report-section">
          <div className="pp-report-header">
            <div className="pp-report-header-left">
              <div className="pp-report-icon"><i className="fa-solid fa-file-lines" /></div>
              <div className="pp-report-title-block">
                <div className="pp-report-title">Patch Cycle Report — Server May 2026</div>
                <div className="pp-report-meta">
                  Generated: {new Date().toUTCString()}
                  <span className="pp-meta-sep">·</span>
                  Sent to: ops-patching@company.com
                  {!gatePassed && <><span className="pp-meta-sep">·</span><span className="pp-skipped-note">⚠ Stages 8 & 9 skipped</span></>}
                </div>
              </div>
            </div>
            <div className={`pp-triage-flag ${hasAnomalies ? 'pp-triage-yes' : 'pp-triage-no'}`}>
              <div className="pp-triage-label">ACTION NEEDED</div>
              <div className="pp-triage-value">{hasAnomalies ? 'YES' : 'NO'}</div>
            </div>
          </div>

          <div className="pp-report-summary-chips">
            <span className="pp-chip-success"><i className="fa-solid fa-circle-check" /> {patchedCount} Patched Successfully</span>
            <span className="pp-chip-fail"><i className="fa-solid fa-circle-xmark" /> {failedCount} Failed</span>
            {hasAnomalies && <span className="pp-chip-warn"><i className="fa-solid fa-flag" /> {results.filter(r => r.hasAnomaly).length} Server{results.filter(r => r.hasAnomaly).length !== 1 ? 's' : ''} with Anomalies</span>}
            {!gatePassed  && <span className="pp-chip-skip"><i className="fa-solid fa-minus" /> Post-state comparison skipped</span>}
          </div>

          <div className="pp-table-wrap">
            <table className="pp-table" id="pp-report-table">
              <thead>
                <tr>
                  <th>Server Name</th><th>IP Address</th><th>Environment</th>
                  <th className="pp-th-center">Pre Patches</th><th className="pp-th-center">Post Patches</th>
                  <th className="pp-th-center">Svcs Changed</th><th>Reboot Status</th>
                  <th>Deploy Code</th><th>Anomalies</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={r.id} className={`pp-tr ${r.hasAnomaly ? 'pp-tr-anomaly' : ''}`}
                      style={{ animationDelay: `${i * 40}ms` }}>
                    <td>
                      <div className="pp-cell-name">
                        <i className="fa-solid fa-server pp-row-srv-icon" />
                        <span>{r.name}</span>
                      </div>
                    </td>
                    <td><code className="pp-code">{r.ip}</code></td>
                    <td><span className={`pp-env-chip pp-env-${r.environment.toLowerCase().replace(' ', '-')}`}>{r.environment}</span></td>
                    <td className="pp-td-center">{r.prePatch}</td>
                    <td className="pp-td-center">
                      {r.postPatch !== null ? <span className={r.postPatch < r.prePatch ? 'pp-val-warn' : 'pp-val-ok'}>{r.postPatch}</span> : <span className="pp-val-skip">—</span>}
                    </td>
                    <td className="pp-td-center">
                      {r.svcChanged !== null ? <span className={r.svcChanged > 0 ? 'pp-val-warn' : ''}>{r.svcChanged}</span> : <span className="pp-val-skip">—</span>}
                    </td>
                    <td>
                      {r.rebootOcc !== null
                        ? <span className={`pp-reboot-chip ${r.rebootMatch ? 'pp-reboot-ok' : 'pp-reboot-warn'}`}>
                            <i className={`fa-solid ${r.rebootOcc ? 'fa-rotate-right' : 'fa-ban'}`} />
                            {r.rebootOcc ? 'Rebooted' : 'No Reboot'}
                            {!r.rebootMatch && <span className="pp-reboot-mismatch">  Unexpected</span>}
                          </span>
                        : <span className="pp-val-skip">—</span>}
                    </td>
                    <td><code className={`pp-code ${r.code !== '0x00000000' ? 'pp-code-err' : 'pp-code-ok'}`}>{r.code}</code></td>
                    <td>
                      {r.anomalies !== null
                        ? r.anomalies > 0
                            ? <span className="pp-anomaly-badge"><i className="fa-solid fa-flag" /> {r.anomalies} flag{r.anomalies > 1 ? 's' : ''}</span>
                            : <span className="pp-no-anomaly"><i className="fa-solid fa-check" /> None</span>
                        : <span className="pp-val-skip">—</span>}
                    </td>
                    <td>
                      <span className={`pp-deploy-chip ${r.deployStatus === 'success' ? 'pp-deploy-ok' : 'pp-deploy-fail'}`}>
                        <i className={`fa-solid ${r.deployStatus === 'success' ? 'fa-circle-check' : 'fa-circle-xmark'}`} />
                        {r.deployStatus === 'success' ? 'Success' : 'Failed'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Rollback Banner */}
          {hasAnomalies && !rollbackDone && (
            <div className="pp-rollback-banner">
              <div className="pp-rollback-left">
                <div className="pp-rollback-icon"><i className="fa-solid fa-triangle-exclamation" /></div>
                <div className="pp-rollback-text">
                  <div className="pp-rollback-title">Rollback Available — {results.filter(r => r.hasAnomaly).length} Server{results.filter(r => r.hasAnomaly).length !== 1 ? 's' : ''} Flagged</div>
                  <div className="pp-rollback-desc">Anomalies detected during post-patch comparison. A rollback action is available for manual trigger by an authorized operator. Review the report above before proceeding. This action cannot be automated.</div>
                </div>
              </div>
              <button className="pp-btn-rollback" onClick={() => setRollbackDone(true)} id="btn-trigger-rollback">
                <i className="fa-solid fa-arrow-rotate-left" /> Trigger Rollback
              </button>
            </div>
          )}

          {rollbackDone && (
            <div className="pp-rollback-confirmed">
              <i className="fa-solid fa-circle-check" />
              <span>Rollback initiated by operator at <strong>{new Date().toUTCString()}</strong>. Monitor SCCM for per-server rollback status.</span>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════
         Enhancement 5: Evidence & Escalation View
      ═══════════════════════════════════════ */}
      {reportReady && appValDone && (
        <EvidenceView results={results} servers={selectedServers} />
      )}

      {/* ── Idle State ── */}
      {cycleState === 'idle' && (
        <div className="pp-idle">
          <div className="pp-idle-icon"><i className="fa-solid fa-diagram-project" /></div>
          <div className="pp-idle-title">No Active Patch Cycle</div>
            <div className="pp-idle-desc">
            Click <strong>Start Cycle</strong> to begin the NOVA autonomous patching pipeline.<br />
            You'll select servers from the CMDB inventory, then approve via the HITL gate before patches deploy.<br />
            Application validation runs in parallel after patching completes.
          </div>
          <div className="pp-idle-flow">
            <span className="pp-idle-flow-step">CMDB Select</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-step">1–3 Pre-Validate</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-gate">HITL Approval</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-step">4–7 Deploy</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-gate">Health Gate</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-step">8–10 Report</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-gate">App Validation</span>
            <i className="fa-solid fa-arrow-right pp-idle-flow-arrow" />
            <span className="pp-idle-flow-rollback">Evidence & Escalation</span>
          </div>
        </div>
      )}

    </div>
  )
}
