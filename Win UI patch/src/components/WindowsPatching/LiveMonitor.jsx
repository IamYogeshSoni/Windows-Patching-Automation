import React, { useEffect, useMemo, useState } from 'react'
import { asArray, describeError, getReport, isFinal } from '../../api/sccmApi'
import { STAGES, deployStageFromLog, serverStatesFromLog, shortName } from './hooks'
import { Banner, Card, Empty, Modal, Spinner, StatusPill, fmtDuration, fmtUtc, parseTime, shortHost, tone, useNow } from './ui'
import LiveLog from './LiveLog'
import ReportView from './ReportViews'

const STAGE_LABELS = { environment: 'Environment check', prerequisites: 'Readiness checks' }

export default function LiveMonitor({
  run, stream, watchingOther, status, onRetry, onDeployAnyway, onReset, onResume, onReleaseLock, onOpenReport, onPlan,
}) {
  const now = useNow(true, 1000)
  const job = stream.job
  const lines = stream.lines
  const ownRun = run.phase !== 'idle'
  const deploying = Boolean(job)
  const final = job && isFinal(job)

  /* Report for the finished deployment */
  const [report, setReport] = useState({ data: null, error: null })
  useEffect(() => {
    if (!final || !job) { setReport({ data: null, error: null }); return }
    let alive = true
    getReport(job.job_id).then(r => alive && setReport({ data: r, error: null })).catch(e => alive && setReport({ data: null, error: describeError(e) }))
    return () => { alive = false }
  }, [final, job?.job_id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Stage index across the whole one-click run ── */
  const stageIdx = useMemo(() => {
    if (deploying) return final && ['SUCCEEDED', 'COMPLETED_WITH_ISSUES'].includes(job.status) ? STAGES.length - 1 : deployStageFromLog(lines)
    if (run.stage === 'prerequisites') return 1
    if (run.stage === 'deployment') return 2
    return 0
  }, [deploying, final, job?.status, lines, run.stage]) // eslint-disable-line react-hooks/exhaustive-deps

  const stageFailed = (ownRun && run.phase === 'error') || (final && ['FAILED', 'OUTCOME_UNKNOWN'].includes(job.status))
  const servers = asArray(job?.request?.Servers || run.config?.servers)
  const states = useMemo(() => serverStatesFromLog(lines), [lines])
  const verdicts = Object.fromEntries(asArray(job?.result?.servers).map(s => [shortName(s.Server), s]))
  const waiting = [...lines].reverse().find(l => /Waiting for (the maintenance window|the deployment deadline)/.test(l.line))
  const lastLine = [...lines].reverse().find(l => l.line?.trim())
  const waitingActive = waiting && lastLine === waiting

  if (!ownRun && !deploying) {
    const last = status.active?.last_deployment
    return (
      <div className="wpx-live">
        <Empty icon="fa-satellite-dish" title="No deployment in progress" action={
          <div className="wpx-row-gap">
            <button type="button" className="wpx-btn wpx-btn-primary" onClick={onPlan}><i className="fa-solid fa-rocket" /> Plan a deployment</button>
            {last && <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => onOpenReport(last.job_id)}><i className="fa-solid fa-file-lines" /> Last report</button>}
          </div>
        }>
          {last ? <>Last deployment <strong>{last.deployment_name || last.job_id}</strong> by {last.requested_by || 'unknown'} — <StatusPill status={last.status} size="sm" /></> : 'Start a deployment from the Deploy tab. Its progress, server states and the live jumphost log appear here for everyone.'}
        </Empty>
      </div>
    )
  }

  const name = job?.deployment_name || job?.request?.DeploymentName || run.config?.deploymentName || 'Deployment'
  const startedMs = parseTime(job?.started_at || run.startedAt)
  const endedMs = final ? parseTime(job.finished_at) : now
  const pct = Math.round((stageIdx / (STAGES.length - 1)) * 100)
  const heroStatus = job ? job.status : run.phase === 'error' ? 'FAILED' : run.phase === 'paused' || run.phase === 'blocked' ? 'WARN' : 'RUNNING'

  return (
    <div className="wpx-live">
      {/* Hero */}
      <div className={`wpx-live-hero wpx-live-${tone(heroStatus)}`}>
        <div className="wpx-live-hero-bg" aria-hidden="true"><span /><span /><span /></div>
        <div className="wpx-live-hero-main">
          <div className="wpx-live-kicker">
            {watchingOther ? <><i className="fa-solid fa-eye" /> Watching deployment by {job?.requested_by || 'another user'}</> : <><i className="fa-solid fa-satellite-dish" /> Live deployment</>}
          </div>
          <h2>{name}</h2>
          <div className="wpx-live-meta">
            <StatusPill status={job?.status || (run.phase === 'running' ? 'RUNNING' : run.phase === 'error' ? 'FAILED' : 'WARN')} label={!job && run.phase === 'paused' ? 'Waiting for you' : !job && run.phase === 'blocked' ? 'Blocked' : undefined} size="lg" />
            <span><i className="fa-solid fa-stopwatch" /> {Number.isNaN(startedMs) ? '—' : fmtDuration(endedMs - startedMs)}</span>
            <span><i className="fa-solid fa-location-dot" /> {STAGES[stageIdx].label}</span>
            {(job?.requested_by || run.config) && <span><i className="fa-solid fa-user" /> {job?.requested_by || 'you'}</span>}
            {(job?.request?.ChangeTicket || run.config?.changeTicket) && <span><i className="fa-solid fa-ticket" /> {job?.request?.ChangeTicket || run.config?.changeTicket}</span>}
          </div>
        </div>
        <div className="wpx-live-progress">
          <div className="wpx-live-pct">{pct}<small>%</small></div>
          <div className="wpx-live-bar"><span style={{ width: `${pct}%` }} /></div>
          {waitingActive && <div className="wpx-live-wait"><i className="fa-solid fa-hourglass-half" /> {waiting.line.replace(/^\[[^\]]*\]\s*/, '')}</div>}
        </div>
      </div>

      {/* Stage rail */}
      <div className="wpx-rail">
        {STAGES.map((s, i) => {
          const state = i < stageIdx ? 'done' : i === stageIdx ? (stageFailed ? 'failed' : final ? 'done' : 'active') : 'todo'
          return (
            <div key={s.key} className={`wpx-rail-step wpx-rail-${state}`}>
              <span className="wpx-rail-dot">
                {state === 'done' ? <i className="fa-solid fa-check" /> : state === 'failed' ? <i className="fa-solid fa-xmark" /> : <i className={`fa-solid ${s.icon}`} />}
              </span>
              <span className="wpx-rail-label">{s.label}</span>
            </div>
          )
        })}
      </div>

      {/* Situations that need the user */}
      {ownRun && run.phase === 'paused' && (
        <Banner toneName="warn" title="Some selected servers are no longer READY" actions={<>
          <button type="button" className="wpx-btn wpx-btn-ghost" onClick={onReset}>Cancel</button>
          <button type="button" className="wpx-btn wpx-btn-warn" onClick={onDeployAnyway}><i className="fa-solid fa-forward" /> Deploy anyway</button>
        </>}>
          {asArray(run.notReady).map(r => `${shortHost(r.Server)} (${r.Failed || r.Overall})`).join(', ')} failed the latest readiness check.
        </Banner>
      )}
      {ownRun && run.phase === 'blocked' && run.lock && !deploying && (
        <Banner toneName="warn" icon="fa-lock" title="Another deployment holds the lock" actions={<>
          <button type="button" className="wpx-btn wpx-btn-ghost" onClick={onReset}>Close</button>
          <button type="button" className="wpx-btn wpx-btn-primary" onClick={onRetry}><i className="fa-solid fa-rotate" /> Try again</button>
        </>}>
          {run.lock.message}
          {run.lock.active_deployment?.latest_log_line && <div className="wpx-banner-quote">{run.lock.active_deployment.latest_log_line}</div>}
        </Banner>
      )}
      {ownRun && run.phase === 'error' && (
        <Banner toneName="bad" title={`${STAGE_LABELS[run.error?.stage] || 'Deployment'} failed`} actions={<>
          <button type="button" className="wpx-btn wpx-btn-ghost" onClick={onReset}>Start over</button>
          <button type="button" className="wpx-btn wpx-btn-primary" onClick={onRetry}><i className="fa-solid fa-rotate-right" /> Retry</button>
        </>}>
          {run.error?.message}
        </Banner>
      )}
      {stream.error && <Banner toneName="warn" title="Live updates interrupted">{stream.error} The job keeps running on the server.</Banner>}

      {/* Pre-flight results */}
      {ownRun && run.results && Object.keys(run.results).length > 0 && (
        <div className="wpx-preflight">
          {['environment', 'prerequisites'].map(k => run.results[k] && (
            <button key={k} type="button" className={`wpx-preflight-item wpx-preflight-${tone(run.results[k].status)}`} onClick={() => onOpenReport(run.results[k].job_id)}>
              <i className={`fa-solid ${k === 'environment' ? 'fa-network-wired' : 'fa-list-check'}`} />
              <span><strong>{STAGE_LABELS[k]}</strong><small>{run.results[k].headline || run.results[k].status}</small></span>
              <i className="fa-solid fa-arrow-up-right-from-square wpx-preflight-open" />
            </button>
          ))}
        </div>
      )}

      {/* Servers */}
      {servers.length > 0 && (
        <Card title="Servers" icon="fa-server" kicker={`${servers.length} targeted`}>
          <div className="wpx-live-servers">
            {servers.map(s => {
              const v = verdicts[shortName(s)]
              const st = states[String(s).toLowerCase()]
              const label = v?.Verdict || st?.state || (deploying ? 'QUEUED' : 'PENDING')
              return (
                <div key={s} className={`wpx-live-srv wpx-live-srv-${tone(label === 'RESTARTED' ? 'OK' : label === 'RESTARTING' ? 'RUNNING' : label)}`}>
                  <div className="wpx-live-srv-head">
                    <span className="wpx-live-srv-icon"><i className="fa-brands fa-windows" />{!final && st && ['INSTALLING', 'RESTARTING'].includes(st.state) && <span className="wpx-pulse" />}</span>
                    <div><strong>{shortHost(s)}</strong><small>{s}</small></div>
                  </div>
                  <StatusPill status={label} label={label === 'RESTARTED' ? 'Back online' : label === 'RESTARTING' ? 'Restarting' : undefined} size="sm" />
                  <div className="wpx-live-srv-detail">{v ? (v.MissingKbs?.length ? `Missing: ${asArray(v.MissingKbs).join(', ')}` : v.Detail) : st?.detail || 'Waiting for the deployment to reach this server.'}</div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Final outcome */}
      {final && job.status === 'OUTCOME_UNKNOWN' && <OutcomeUnknownPanel job={job} onResume={onResume} onReleaseLock={onReleaseLock} />}

      {/* Log */}
      <LiveLog
        lines={deploying ? lines : (run.preLines || [])}
        live={!final && (deploying || run.phase === 'running')}
        title={deploying ? 'Jumphost log' : 'Pre-flight log'}
        stageLabels={deploying ? null : STAGE_LABELS}
        filename={`${(name || 'deployment').replace(/[^A-Za-z0-9-]+/g, '-')}-log.txt`}
        height={final ? 300 : 460}
      />

      {final && (
        <div className="wpx-live-final">
          <div className="wpx-live-final-head">
            <h3><i className="fa-solid fa-file-lines" /> Deployment report</h3>
            <div className="wpx-row-gap">
              <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => onOpenReport(job.job_id)}><i className="fa-solid fa-up-right-from-square" /> Open in Reports</button>
              {ownRun && <button type="button" className="wpx-btn wpx-btn-primary" onClick={() => { onReset(); onPlan() }}><i className="fa-solid fa-plus" /> New deployment</button>}
            </div>
          </div>
          {report.error && <Banner toneName="bad">{report.error}</Banner>}
          {report.data ? <ReportView job={report.data.job} report={report.data.report} logs={lines} /> : !report.error && <div className="wpx-center"><Spinner label="Building the report…" /></div>}
        </div>
      )}
    </div>
  )
}

function OutcomeUnknownPanel({ job, onResume, onReleaseLock }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [adminKey, setAdminKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const released = job.lock_released
  const submit = async () => {
    setBusy(true); setError(null)
    try { await onReleaseLock(job.job_id, reason.trim(), adminKey.trim()); setOpen(false) } catch (e) { setError(describeError(e)) } finally { setBusy(false) }
  }
  return (
    <>
      <Banner toneName="bad" icon="fa-circle-question" title="The run was interrupted" actions={!released && <>
        <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => setOpen(true)}><i className="fa-solid fa-unlock" /> Release lock</button>
        <button type="button" className="wpx-btn wpx-btn-primary" onClick={() => onResume(job.result?.report_folder_name)}><i className="fa-solid fa-play" /> Resume</button>
      </>}>
        {released
          ? <>Lock released by {released.by} at {fmtUtc(released.at)}: {released.reason}</>
          : 'The deployment may already exist in SCCM and be installing. Resume continues monitoring, restart and validation; new deployments stay blocked until then.'}
      </Banner>
      {open && (
        <Modal title="Release the deployment lock" icon="fa-unlock" toneName="warn" onClose={() => setOpen(false)} footer={<>
          <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="wpx-btn wpx-btn-warn" disabled={busy || reason.trim().length < 10} onClick={submit}>{busy ? <Spinner label="Releasing…" /> : 'Release lock'}</button>
        </>}>
          <p className="wpx-modal-lead">Only release the lock after checking SCCM (Monitoring → Deployments). Your name, the time and the reason are recorded in the audit log.</p>
          {error && <Banner toneName="bad">{error}</Banner>}
          <label className="wpx-field"><span className="wpx-label">Reason (at least 10 characters)</span>
            <textarea className="wpx-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Checked SCCM: deployment exists, servers patched; validated manually." />
          </label>
          <label className="wpx-field"><span className="wpx-label">Admin key (if required)</span>
            <input className="wpx-input" type="password" value={adminKey} onChange={e => setAdminKey(e.target.value)} autoComplete="off" />
          </label>
        </Modal>
      )}
    </>
  )
}
