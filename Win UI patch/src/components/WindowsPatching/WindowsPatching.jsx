import React, { useCallback, useState } from 'react'
import './WindowsPatching.css'
import {
  BASE_URL, asArray, connectionTest, describeError, newIdempotencyKey, pollJob,
  releaseLock, resumeDeployment,
} from '../../api/sccmApi'
import { usePlatformStatus, useOneClickRun, useJobStream } from './hooks'
import { Banner, Modal, Spinner, StatusPill } from './ui'
import DeployConsole from './DeployConsole'
import LiveMonitor from './LiveMonitor'
import ReportsCenter from './ReportsCenter'
import ActivityView from './ActivityView'
import Dashboard from './Dashboard'

const TABS = [
  { key: 'deploy', label: 'Deploy' },
  { key: 'live', label: 'Live' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'reports', label: 'Reports' },
  { key: 'activity', label: 'Activity' },
]
const TAB_KEY = 'nova-wp-tab'

export default function WindowsPatching() {
  const status = usePlatformStatus()
  const oneClick = useOneClickRun()
  const { run } = oneClick
  const [tab, setTabState] = useState(() => { try { return localStorage.getItem(TAB_KEY) || 'deploy' } catch { return 'deploy' } })
  const setTab = (t) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t) } catch { /* unavailable */ } }
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
  // The lock is taken when the deployment job is created: show it at once
  React.useEffect(() => { if (run.jobs?.deployment) status.refresh() }, [run.jobs?.deployment]) // eslint-disable-line react-hooks/exhaustive-deps

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
      <header className="wpx-header">
        <div className="wpx-header-row">
          <h1><i className="fa-brands fa-windows" /> Windows Patching</h1>
          <div className="wpx-header-status">
            <span className={`wpx-status wpx-status-${status.api === 'up' ? 'good' : status.api === 'loading' ? 'neutral' : 'bad'}`} title={status.error || BASE_URL}>
              <span className="wpx-status-dot" />{status.api === 'loading' ? 'Connecting' : status.api === 'up' ? 'API online' : 'API offline'}
            </span>
            {status.health && (
              <span className={`wpx-status wpx-status-${status.health.deployment_enabled === false ? 'bad' : 'good'}`}>
                <span className="wpx-status-dot" />Deployments {status.health.deployment_enabled === false ? 'disabled' : 'enabled'}
              </span>
            )}
            <span className={`wpx-status wpx-status-${locked ? 'warn' : 'neutral'}`}>
              <span className="wpx-status-dot" />{locked ? `Deployment running${lockInfo?.requested_by ? ` (${lockInfo.requested_by})` : ''}` : 'No deployment running'}
            </span>
            <button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={() => setConnOpen(true)}>Test connection</button>
          </div>
        </div>
        <nav className="wpx-tabs" role="tablist" aria-label="Windows patching">
          {TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`wpx-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)} id={`wpx-tab-${t.key}`}>
              {t.label}
              {t.key === 'live' && liveBusy && <span className="wpx-tab-live" aria-label="running" />}
            </button>
          ))}
        </nav>
      </header>

      <main className="wpx-content">
        {locked && !ownDeployment && tab !== 'live' && lockInfo && (
          <Banner toneName="live" icon="fa-circle-info" title={lockInfo.requested_by ? `Deployment in progress by ${lockInfo.requested_by}` : 'A deployment is in progress'} actions={
            <button type="button" className="wpx-btn wpx-btn-primary wpx-btn-sm" onClick={() => setTab('live')}>Watch live</button>
          }>
            <strong>{lockInfo.deployment_name || 'Deployment'}</strong> · <StatusPill status={lockInfo.status} size="sm" /> {lockInfo.latest_log_line && <span className="wpx-banner-quote">{lockInfo.latest_log_line}</span>}
          </Banner>
        )}
        {actionError && <Banner toneName="bad" actions={<button type="button" className="wpx-icon-btn" onClick={() => setActionError(null)} aria-label="Dismiss"><i className="fa-solid fa-xmark" /></button>}>{actionError}</Banner>}

        {tab === 'deploy' && (
          <DeployConsole status={status} run={run} onStart={startDeployment} onGoLive={() => setTab('live')} onOpenReport={openReport} />
        )}
        {tab === 'live' && (
          <LiveMonitor
            run={watchingOther && run.phase === 'done' ? { phase: 'idle' } : run} stream={stream} watchingOther={watchingOther} status={status}
            onRetry={oneClick.retry} onDeployAnyway={oneClick.deployAnyway} onReset={oneClick.reset}
            onResume={resume} onReleaseLock={release} onOpenReport={openReport} onPlan={() => setTab('deploy')}
          />
        )}
        {tab === 'reports' && <ReportsCenter selectedId={selectedReport} onSelect={setSelectedReport} refreshKey={reportsRefresh} />}
        {tab === 'dashboard' && <Dashboard onOpenReport={openReport} refreshKey={reportsRefresh} />}
        {tab === 'activity' && <ActivityView onOpenReport={openReport} />}
      </main>

      {connOpen && <ConnectionTestModal onClose={() => setConnOpen(false)} />}
    </div>
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
