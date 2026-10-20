import React, { useCallback, useState } from 'react'
import './WindowsPatching.css'
import {
  BASE_URL, asArray, connectionTest, describeError, getUserName, newIdempotencyKey, pollJob,
  releaseLock, resumeDeployment, setUserName,
} from '../../api/sccmApi'
import { usePlatformStatus, useOneClickRun, useJobStream } from './hooks'
import { Banner, Modal, Spinner, StatusPill, shortHost } from './ui'
import DeployConsole from './DeployConsole'
import LiveMonitor from './LiveMonitor'
import ReportsCenter from './ReportsCenter'
import ActivityView from './ActivityView'

const TABS = [
  { key: 'deploy', label: 'Deploy', icon: 'fa-rocket' },
  { key: 'live', label: 'Live', icon: 'fa-satellite-dish' },
  { key: 'reports', label: 'Reports', icon: 'fa-chart-pie' },
  { key: 'activity', label: 'Activity', icon: 'fa-shield-halved' },
]
const TAB_KEY = 'nova-wp-tab'

export default function WindowsPatching() {
  const status = usePlatformStatus()
  const oneClick = useOneClickRun()
  const { run } = oneClick
  const [tab, setTabState] = useState(() => { try { return localStorage.getItem(TAB_KEY) || 'deploy' } catch { return 'deploy' } })
  const setTab = (t) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t) } catch { /* unavailable */ } }
  const [user, setUser] = useState(getUserName)
  const [selectedReport, setSelectedReport] = useState(null)
  const [reportsRefresh, setReportsRefresh] = useState(0)
  const [actionError, setActionError] = useState(null)
  const [connOpen, setConnOpen] = useState(false)

  /* Which deployment the Live view follows: ours, or whoever holds the lock */
  const ownActive = ['running', 'paused', 'blocked'].includes(run.phase) ? run.jobs?.deployment : null
  const ownFinished = run.phase === 'done' ? run.jobs?.deployment : null
  const lockJob = status.active?.locked ? status.active.active_deployment?.job_id : null
  const ownDeployment = ownActive || (lockJob ? (lockJob === ownFinished ? ownFinished : null) : ownFinished)
  const watchId = ownActive || lockJob || ownFinished || null
  const watchingOther = Boolean(watchId && watchId !== run.jobs?.deployment)

  const onFinal = useCallback((job) => {
    oneClick.markFinished(job)
    status.refresh()
    setReportsRefresh(n => n + 1)
  }, [oneClick.markFinished, status.refresh]) // eslint-disable-line react-hooks/exhaustive-deps
  const stream = useJobStream(watchId, { onFinal })

  const openReport = (jobId) => { setSelectedReport(jobId); setReportsRefresh(n => n + 1); setTab('reports') }

  const startDeployment = (config) => {
    setActionError(null)
    oneClick.start(config)
    setTab('live')
  }
  const resume = async (reportFolder) => {
    setActionError(null)
    try {
      const job = await resumeDeployment(reportFolder, newIdempotencyKey())
      oneClick.attach(job.job_id)
      status.refresh()
      setTab('live')
    } catch (e) {
      setActionError(describeError(e))
    }
  }
  const release = async (jobId, reason, adminKey) => {
    await releaseLock(jobId, reason, adminKey)
    status.refresh()
    stream.reload()
  }

  const locked = status.active?.locked
  const lockInfo = status.active?.active_deployment
  const liveBusy = ['running', 'paused', 'blocked'].includes(run.phase) || (stream.job && !['SUCCEEDED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'OUTCOME_UNKNOWN'].includes(stream.job.status))

  return (
    <div className="wpx-root">
      {/* ── Hero header ── */}
      <header className="wpx-hero">
        <div className="wpx-hero-art" aria-hidden="true">
          <span className="wpx-orb wpx-orb-1" /><span className="wpx-orb wpx-orb-2" /><span className="wpx-hero-grid" />
        </div>
        <div className="wpx-hero-row">
          <div className="wpx-hero-brand">
            <span className="wpx-hero-logo"><i className="fa-brands fa-windows" /></span>
            <div>
              <div className="wpx-hero-kicker">NOVA · Unified Patching</div>
              <h1>Windows Patching</h1>
              <p>Readiness, one-click SCCM deployment, live tracking and reports — in one place.</p>
            </div>
          </div>
          <div className="wpx-hero-side">
            <UserChip user={user} onChange={(n) => { setUserName(n); setUser(n) }} />
            <button type="button" className="wpx-btn wpx-btn-glass" onClick={() => setConnOpen(true)}><i className="fa-solid fa-plug" /> Test connection</button>
          </div>
        </div>
        <div className="wpx-hero-chips">
          <span className={`wpx-hchip wpx-hchip-${status.api}`} title={status.error || `${BASE_URL}`}>
            <span className="wpx-hchip-dot" />{status.api === 'loading' ? 'Connecting…' : status.api === 'up' ? 'API online' : 'API offline'}
          </span>
          <span className={`wpx-hchip ${status.health?.deployment_enabled === false ? 'wpx-hchip-down' : 'wpx-hchip-up'}`}>
            <i className="fa-solid fa-rocket" /> Deployments {status.health?.deployment_enabled === false ? 'disabled' : 'enabled'}
          </span>
          {status.health?.sccm_site_code && (
            <span className="wpx-hchip" title={status.health.sccm_site_server}><i className="fa-solid fa-sitemap" /> SCCM site {status.health.sccm_site_code}</span>
          )}
          {status.health?.jumphost && (
            <span className="wpx-hchip" title="Jumphost"><i className="fa-solid fa-server" /> {shortHost(status.health.jumphost)}</span>
          )}
          {status.health?.target_server_account && <span className="wpx-hchip"><i className="fa-solid fa-user-shield" /> {status.health.target_server_account}</span>}
          <span className={`wpx-hchip ${locked ? 'wpx-hchip-busy' : ''}`}>
            <i className={`fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}`} /> {locked ? `Locked by ${lockInfo?.requested_by || 'a deployment'}` : 'No deployment running'}
          </span>
        </div>

        <nav className="wpx-tabs" role="tablist" aria-label="Windows patching">
          {TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`wpx-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)} id={`wpx-tab-${t.key}`}>
              <i className={`fa-solid ${t.icon}`} /> {t.label}
              {t.key === 'live' && liveBusy && <span className="wpx-tab-live" />}
            </button>
          ))}
        </nav>
      </header>

      <main className="wpx-content">
        {locked && !ownDeployment && tab !== 'live' && lockInfo && (
          <Banner toneName="live" icon="fa-satellite-dish" title={`Deployment in progress by ${lockInfo.requested_by}`} actions={
            <button type="button" className="wpx-btn wpx-btn-primary wpx-btn-sm" onClick={() => setTab('live')}><i className="fa-solid fa-eye" /> Watch live</button>
          }>
            <strong>{lockInfo.deployment_name || 'Deployment'}</strong> · <StatusPill status={lockInfo.status} size="sm" /> {lockInfo.latest_log_line && <span className="wpx-banner-quote">{lockInfo.latest_log_line}</span>}
          </Banner>
        )}
        {actionError && <Banner toneName="bad" actions={<button type="button" className="wpx-icon-btn" onClick={() => setActionError(null)} aria-label="Dismiss"><i className="fa-solid fa-xmark" /></button>}>{actionError}</Banner>}

        {tab === 'deploy' && (
          <DeployConsole status={status} run={run} user={user} onStart={startDeployment} onGoLive={() => setTab('live')} onOpenReport={openReport} />
        )}
        {tab === 'live' && (
          <LiveMonitor
            run={watchingOther && run.phase === 'done' ? { phase: 'idle' } : run} stream={stream} watchingOther={watchingOther} status={status}
            onRetry={oneClick.retry} onDeployAnyway={oneClick.deployAnyway} onReset={oneClick.reset}
            onResume={resume} onReleaseLock={release} onOpenReport={openReport} onPlan={() => setTab('deploy')}
          />
        )}
        {tab === 'reports' && <ReportsCenter selectedId={selectedReport} onSelect={setSelectedReport} refreshKey={reportsRefresh} />}
        {tab === 'activity' && <ActivityView onOpenReport={openReport} />}
      </main>

      {connOpen && <ConnectionTestModal onClose={() => setConnOpen(false)} />}
    </div>
  )
}

function UserChip({ user, onChange }) {
  const [editing, setEditing] = useState(!user)
  const [value, setValue] = useState(user)
  if (editing) {
    return (
      <form className="wpx-user-edit" onSubmit={(e) => { e.preventDefault(); if (!value.trim()) return; onChange(value.trim()); setEditing(false) }}>
        <input value={value} onChange={e => setValue(e.target.value)} maxLength={100} autoFocus={Boolean(user)} placeholder="Enter your name" aria-label="Your display name" />
        <button type="submit" className="wpx-icon-btn" aria-label="Save"><i className="fa-solid fa-check" /></button>
      </form>
    )
  }
  return (
    <button type="button" className="wpx-user" onClick={() => { setValue(user); setEditing(true) }} title="Your name is recorded on every action">
      <span className="wpx-user-avatar">{user.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span>
      <span className="wpx-user-name"><small>Signed in as</small>{user}</span>
      <i className="fa-solid fa-pen" />
    </button>
  )
}

function ConnectionTestModal({ onClose }) {
  const [state, setState] = useState({ phase: 'idle', job: null, error: null })
  const runTest = async () => {
    setState({ phase: 'running', job: null, error: null })
    try {
      const job = await pollJob(await connectionTest(), { onUpdate: (j) => setState(s => ({ ...s, job: j })) })
      setState({ phase: 'done', job, error: null })
    } catch (e) {
      setState({ phase: 'error', job: null, error: describeError(e) })
    }
  }
  React.useEffect(() => { runTest() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const result = state.job?.result || {}
  const rows = [
    ['Jumphost', result.host], ['Runs as', result.run_as], ['Project folder', result.project_root],
    ['Scripts folder', result.scripts_folder], ['Reports folder', result.reports_folder], ['SCCM site', result.sccm], ['Server account', result.target_servers],
  ].filter(([, v]) => v)
  return (
    <Modal title="Connection test" icon="fa-plug" onClose={onClose} footer={<>
      <button type="button" className="wpx-btn wpx-btn-ghost" onClick={onClose}>Close</button>
      <button type="button" className="wpx-btn wpx-btn-primary" onClick={runTest} disabled={state.phase === 'running'}><i className="fa-solid fa-rotate" /> Run again</button>
    </>}>
      {state.phase === 'running' && <div className="wpx-center wpx-pad-lg"><Spinner label={state.job?.status === 'RUNNING' ? 'Checking the jumphost…' : 'Connecting…'} /></div>}
      {state.error && <Banner toneName="bad">{state.error}</Banner>}
      {state.phase === 'done' && (
        <>
          {asArray(result.errors).map((e, i) => <Banner key={i} toneName="bad">{e}</Banner>)}
          <ul className="wpx-conn">
            {rows.map(([k, v]) => {
              const bad = /^FAILED/i.test(v), ok = /^OK/i.test(v)
              return (
                <li key={k} className={bad ? 'bad' : ok ? 'ok' : ''}>
                  <i className={`fa-solid ${bad ? 'fa-circle-xmark' : ok ? 'fa-circle-check' : 'fa-circle-info'}`} />
                  <span>{k}</span><strong>{String(v).replace(/^FAILED:\s*/i, '')}</strong>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Modal>
  )
}
