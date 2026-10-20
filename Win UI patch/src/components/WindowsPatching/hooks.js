import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError, asArray, describeError, isFinal, pollJob, getJob, getJobLog, health, activeDeployment,
  environmentCheck, prerequisites, startDeploymentWithRetry, newIdempotencyKey,
} from '../../api/sccmApi'

/* ══════════════════════════════════════════════════════════════════
   Deployment stages, derived from the job log (the API streams the
   PowerShell output; numbered headers mark the stages).
══════════════════════════════════════════════════════════════════ */
export const STAGES = [
  { key: 'environment', label: 'Environment', icon: 'fa-network-wired' },
  { key: 'readiness', label: 'Readiness', icon: 'fa-list-check' },
  { key: 'prepare', label: 'Prepare', icon: 'fa-layer-group', match: /^(SUG:|Creating device collection|Collection '.*?'.*\b(holds|contains)\b|RESUMING)/ },
  { key: 'gates', label: 'Safety gates', icon: 'fa-shield-halved', match: /^1\.\s+Connect/ },
  { key: 'baseline', label: 'Baseline', icon: 'fa-clipboard-list', match: /^2\.\s+Baseline/ },
  { key: 'content', label: 'Content', icon: 'fa-cloud-arrow-down', match: /^3\.\s+Content/ },
  { key: 'window', label: 'Window', icon: 'fa-calendar-check', match: /^4\.\s+Maintenance window/ },
  { key: 'deploy', label: 'Deployment', icon: 'fa-rocket', match: /^5\.\s+Required deployment/ },
  { key: 'install', label: 'Install', icon: 'fa-download', match: /^6\.\s+Install/ },
  { key: 'restart', label: 'Restart', icon: 'fa-power-off', match: /^7\.\s+Restart/ },
  { key: 'validate', label: 'Validate', icon: 'fa-magnifying-glass-chart', match: /^8\.\s+Validate/ },
  { key: 'report', label: 'Report', icon: 'fa-file-lines' },
]
export const stageIndex = (key) => STAGES.findIndex(s => s.key === key)

/* Index of the furthest stage reached in a deployment log (2 = prepare … 10 = validate). */
export function deployStageFromLog(lines) {
  let idx = 2
  for (const entry of lines) {
    const text = String(entry.line || '').trim()
    for (let i = STAGES.length - 2; i > idx; i--) {
      if (STAGES[i].match?.test(text)) { idx = i; break }
    }
  }
  return idx
}

/* 04-DeployAndValidatePatches.ps1 prints "  {fqdn,-34} {state,-26} {detail}" every poll,
   "Restarting <fqdn>..." / "<fqdn> is back online." around restarts, and
   "Waiting up to N min for the SCCM client to restart <fqdn>..." in SCCM restart mode. */
const STATUS_LINE = /^\s+([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\s+([A-Z][A-Z_]{3,})(?:\s+(.*))?$/
const RESTARTING = /(?:^Restarting\s+|for the SCCM client to restart\s+)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/
const BACK_ONLINE = /^\s*([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+) is back/

/* Latest install state per server from the log: { fqdn: { state, detail, time } } */
export function serverStatesFromLog(lines) {
  const states = {}
  for (const entry of lines) {
    const text = String(entry.line || '')
    let m = text.match(STATUS_LINE)
    if (m) { states[m[1].toLowerCase()] = { state: m[2], detail: (m[3] || '').trim(), time: entry.time }; continue }
    m = text.match(RESTARTING)
    if (m) { states[m[1].toLowerCase()] = { state: 'RESTARTING', detail: 'Restart in progress', time: entry.time }; continue }
    m = text.match(BACK_ONLINE)
    if (m) states[m[1].toLowerCase()] = { state: 'RESTARTED', detail: text.trim(), time: entry.time }
  }
  return states
}

/* ══════════════════════════════════════════════════════════════════
   useJobStream — follow one job: full log, then live updates.
══════════════════════════════════════════════════════════════════ */
export function useJobStream(jobId, { onFinal } = {}) {
  const [state, setState] = useState({ job: null, lines: [], error: null })
  const finalRef = useRef(onFinal)
  finalRef.current = onFinal
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!jobId) { setState({ job: null, lines: [], error: null }); return undefined }
    const ctrl = new AbortController()
    let lines = []
    setState({ job: null, lines: [], error: null })
    ;(async () => {
      try {
        const [job, full] = await Promise.all([getJob(jobId, { signal: ctrl.signal }), getJobLog(jobId, -1, { signal: ctrl.signal })])
        lines = asArray(full.log)
        setState({ job, lines, error: null })
        const final = await pollJob(job, {
          signal: ctrl.signal,
          cursor: full.log_next ?? -1,
          skipFirstDelay: true,
          onLog: (batch) => { lines = [...lines, ...batch]; setState(s => ({ ...s, lines })) },
          onUpdate: (j) => setState(s => ({ ...s, job: j })),
        })
        setState(s => ({ ...s, job: final }))
        finalRef.current?.(final)
      } catch (e) {
        if (e?.name === 'AbortError') return
        setState(s => ({ ...s, error: describeError(e), job: e?.job || s.job }))
      }
    })()
    return () => ctrl.abort()
  }, [jobId, nonce])

  return { ...state, reload: () => setNonce(n => n + 1) }
}

/* ══════════════════════════════════════════════════════════════════
   usePlatformStatus — API health + deployment lock, refreshed regularly.
══════════════════════════════════════════════════════════════════ */
export function usePlatformStatus() {
  const [status, setStatus] = useState({ api: 'loading', health: null, active: null, error: null })
  const refresh = useCallback(async () => {
    try {
      const [h, a] = await Promise.all([health(), activeDeployment()])
      setStatus({ api: h?.status === 'ok' ? 'up' : 'down', health: h, active: a, error: null })
    } catch (e) {
      setStatus(s => ({ ...s, api: 'down', error: describeError(e) }))
    }
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15000)
    return () => clearInterval(t)
  }, [refresh])
  return { ...status, refresh }
}

/* ══════════════════════════════════════════════════════════════════
   useOneClickRun — environment check → prerequisites → deployment.
   One click starts the whole chain; it pauses only when a selected
   server is no longer READY, or when another deployment holds the lock.
   State survives a page reload (jobs keep running on the API).
══════════════════════════════════════════════════════════════════ */
const RUN_KEY = 'nova-wp-oneclick-v3'
const IDLE = { phase: 'idle' }
const loadRun = () => { try { return JSON.parse(localStorage.getItem(RUN_KEY)) || IDLE } catch { return IDLE } }
const saveRun = (r) => { try { localStorage.setItem(RUN_KEY, JSON.stringify(r)) } catch { /* unavailable */ } }

export function buildDeploymentBody(config, precheckJobId, includeNotReady) {
  return {
    precheck_job_id: precheckJobId,
    servers: config.servers,
    include_not_ready_servers: Boolean(includeNotReady),
    sug_id: config.sugId,
    sug_name: config.sugName,
    ...(config.collectionMode === 'new' ? { new_collection_name: config.newCollectionName.trim() } : { collection_id: config.collectionId }),
    deployment_name: config.deploymentName.trim(),
    maintenance_window_start_utc: config.windowStartUtc,
    maintenance_window_hours: config.windowHours,
    ...(config.deadlineMode === 'at' && config.deadlineUtc && { deadline_utc: config.deadlineUtc }),
    restart_mode: config.restartMode,
    ...(config.kbs?.length && { kb: config.kbs }),
    change_ticket: config.changeTicket.trim(),
    approver: config.approver.trim(),
    approval_reference: config.approvalReference.trim(),
    readiness_confirmed: true,
    final_confirmation: config.deploymentName.trim(),
  }
}

export function useOneClickRun() {
  const [run, setRunState] = useState(loadRun)
  const runRef = useRef(run)
  const ctrlRef = useRef(null)
  // Updates the ref synchronously: the chain reads runRef.current right after each update
  const setRun = useCallback((fn) => {
    const next = typeof fn === 'function' ? fn(runRef.current) : fn
    runRef.current = next
    saveRun(next)
    setRunState(next)
  }, [])

  const appendLines = (stage, batch) =>
    setRun(r => ({ ...r, preLines: [...(r.preLines || []), ...batch.map(l => ({ ...l, stage }))].slice(-600) }))

  const fail = (stage, message) => setRun(r => ({ ...r, phase: 'error', error: { stage, message } }))

  /* One check job (environment / prerequisites): POST or resume, poll, return the final job */
  const runCheck = async (stage, start, signal) => {
    const existing = runRef.current.jobs?.[stage]
    let job = existing ? await getJob(existing, { signal }) : await start({ signal })
    if (!existing) setRun(r => ({ ...r, stage, jobs: { ...r.jobs, [stage]: job.job_id } }))
    job = await pollJob(job, { signal, cursor: existing ? (runRef.current.cursors?.[stage] ?? -1) : -1, onLog: (batch, cursor) => {
      appendLines(stage, batch)
      setRun(r => ({ ...r, cursors: { ...r.cursors, [stage]: cursor } }))
    } })
    setRun(r => ({ ...r, results: { ...r.results, [stage]: { job_id: job.job_id, status: job.status, headline: job.result?.report_headline, finished_at: job.finished_at } } }))
    return job
  }

  const execute = useCallback(async (from) => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    const { signal } = ctrl
    setRun(r => ({ ...r, phase: 'running', stage: from, error: null, lock: null }))
    try {
      if (from === 'environment') {
        const env = await runCheck('environment', environmentCheck, signal)
        const failed = asArray(env.result?.checks).filter(c => /^FAIL/i.test(c.Status))
        if (env.status !== 'SUCCEEDED') return fail('environment', asArray(env.result?.errors).join(' ') || 'The environment check failed.')
        if (failed.length) return fail('environment', `Environment check failed: ${failed.map(c => c.Check).join(', ')}.`)
        from = 'prerequisites'
        setRun(r => ({ ...r, stage: 'prerequisites' }))
      }
      if (from === 'prerequisites') {
        const { adJobId, servers } = runRef.current.config
        const pre = await runCheck('prerequisites', (o) => prerequisites({ ad_job_id: adJobId, servers }, o), signal)
        if (pre.status !== 'SUCCEEDED') return fail('prerequisites', asArray(pre.result?.errors).join(' ') || 'The prerequisite checks failed.')
        const rows = asArray(pre.result?.servers)
        const cfg = runRef.current.config
        const find = (name) => rows.find(r => shortName(r.Server) === shortName(name))
        const missing = cfg.servers.filter(s => !find(s))
        const notEligible = cfg.servers.map(find).filter(r => r && r.Eligibility !== 'ELIGIBLE')
        const notReady = cfg.servers.map(find).filter(r => r && r.Eligibility === 'ELIGIBLE' && r.Overall !== 'READY')
        if (missing.length) return fail('prerequisites', `Not covered by the prerequisite checks: ${missing.join(', ')}.`)
        if (notEligible.length) return fail('prerequisites', `Not eligible for patching: ${notEligible.map(r => r.Server).join(', ')}.`)
        setRun(r => ({ ...r, precheckJobId: pre.job_id }))
        if (notReady.length && !runRef.current.includeNotReady) {
          setRun(r => ({ ...r, phase: 'paused', notReady }))
          return
        }
        from = 'deployment'
      }
      if (from === 'deployment') {
        const r0 = runRef.current
        const body = buildDeploymentBody(r0.config, r0.precheckJobId, r0.includeNotReady)
        const sameBody = r0.idem && JSON.stringify(r0.idem.body) === JSON.stringify(body)
        const key = sameBody ? r0.idem.key : newIdempotencyKey()
        setRun(r => ({ ...r, stage: 'deployment', idem: { key, body } }))
        const job = await startDeploymentWithRetry(body, key, { signal })
        setRun(r => ({ ...r, phase: 'running', stage: 'deployment', jobs: { ...r.jobs, deployment: job.job_id } }))
      }
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (e instanceof ApiError && e.lock) {
        setRun(r => ({ ...r, phase: 'blocked', lock: e.lock }))
        return
      }
      fail(runRef.current.stage, describeError(e))
    }
  }, [setRun]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Resume a check that was running when the page was reloaded */
  useEffect(() => {
    const r = runRef.current
    if (r.phase === 'running' && (r.stage === 'environment' || r.stage === 'prerequisites')) execute(r.stage)
    return () => ctrlRef.current?.abort()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback((config, extra = {}) => {
    ctrlRef.current?.abort()
    const fresh = {
      id: newIdempotencyKey(), phase: 'running', stage: 'environment', config, includeNotReady: Boolean(config.includeNotReady),
      jobs: {}, cursors: {}, results: {}, preLines: [], startedAt: new Date().toISOString(), ...extra,
    }
    runRef.current = fresh
    setRunState(fresh)
    saveRun(fresh)
    execute('environment')
  }, [execute])

  const deployAnyway = useCallback(() => {
    setRun(r => ({ ...r, includeNotReady: true, notReady: [] }))
    execute('deployment')
  }, [execute, setRun])

  const retry = useCallback(() => {
    const r = runRef.current
    const stage = r.stage || 'environment'
    if (stage !== 'deployment') setRun(p => ({ ...p, jobs: { ...p.jobs, [stage]: undefined }, cursors: { ...p.cursors, [stage]: -1 } }))
    execute(stage)
  }, [execute, setRun])

  const markFinished = useCallback((job) => {
    setRun(r => (r.jobs?.deployment === job.job_id ? { ...r, phase: 'done', finalStatus: job.status, finishedAt: job.finished_at } : r))
  }, [setRun])

  const attach = useCallback((jobId, config) => {
    // Follow a deployment started elsewhere (e.g. resume)
    setRun(r => ({ ...r, phase: 'running', stage: 'deployment', jobs: { ...(r.jobs || {}), deployment: jobId }, config: config || r.config }))
  }, [setRun])

  const reset = useCallback(() => {
    ctrlRef.current?.abort()
    runRef.current = IDLE
    setRunState(IDLE)
    saveRun(IDLE)
  }, [])

  return { run, start, deployAnyway, retry, reset, markFinished, attach }
}

export const shortName = (s) => String(s || '').split('.')[0].toUpperCase()
export { isFinal }
