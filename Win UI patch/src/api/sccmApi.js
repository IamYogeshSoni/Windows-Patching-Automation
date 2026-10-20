/* ══════════════════════════════════════════════════════════════════
   SCCM Patching API client (API v4 — see API\API-Integration.md).

   Every long operation is a JOB: POST returns 202 + job, then we poll
   GET /api/jobs/{job_id}?wait=N&log_after=M until the status is final,
   streaming the new log lines on every poll.

   Config (.env / .env.local):
     VITE_SCCM_API_URL   base URL (default /sccm-api: the Vite dev/preview server
                         forwards it to SCCM_API_TARGET, default http://127.0.0.1:8000)
     VITE_SCCM_API_KEY   X-API-Key header
     VITE_SCCM_USER      default display name sent as X-User (editable in the UI)
══════════════════════════════════════════════════════════════════ */

const env = import.meta.env
export const BASE_URL = (env.VITE_SCCM_API_URL || '/sccm-api').replace(/\/+$/, '')
const API_KEY = env.VITE_SCCM_API_KEY ?? ''

export const FINAL_STATUSES = ['SUCCEEDED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'OUTCOME_UNKNOWN']
export const isFinal = (job) => FINAL_STATUSES.includes(job?.status)

/* ─── Current user (X-User) ─── */
const USER_KEY = 'nova-wp-user'
export function getUserName() {
  try { return localStorage.getItem(USER_KEY) || env.VITE_SCCM_USER || '' } catch { return env.VITE_SCCM_USER || '' }
}
export function setUserName(name) {
  try { localStorage.setItem(USER_KEY, String(name || '').trim()) } catch { /* storage unavailable */ }
}

/* ─── Polling settings per job kind (API-Integration §2.4) ─── */
export const POLL_CONFIG = {
  connection_test:       { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000, typical: '~15 s' },
  environment:           { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 20 * 60_000, typical: '~15 s' },
  ad_servers:            { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 20 * 60_000, typical: '10 s – 2 min' },
  prerequisites:         { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 35 * 60_000, typical: '1–3 min' },
  sugs:                  { firstDelayMs: 3000, waitSeconds: 60, gapMs: 1000, timeoutMs: 50 * 60_000, typical: '1–10 min' },
  collections:           { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 20 * 60_000, typical: '20 s – 2 min' },
  deployment:            { firstDelayMs: 2000, waitSeconds: 60, gapMs: 1000, timeoutMs: Infinity, typical: '30 min – hours' },
  deployment_resume:     { firstDelayMs: 2000, waitSeconds: 60, gapMs: 1000, timeoutMs: Infinity, typical: '30 min – hours' },
  deployment_lookup:     { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 20 * 60_000, typical: '~20 s' },
  report_list:           { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000, typical: '~10 s' },
  report_import:         { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000, typical: '~10 s' },
  dslab_connection_test: { firstDelayMs: 2000, waitSeconds: 20, gapMs: 1000, timeoutMs: 10 * 60_000, typical: '~10 s' },
  dslab_validate:        { firstDelayMs: 2000, waitSeconds: 30, gapMs: 1000, timeoutMs: 35 * 60_000, typical: '20 s – 2 min' },
}

const pollConfig = (kind) => POLL_CONFIG[kind] || POLL_CONFIG.environment

/* PowerShell may serialise a one-item list as a single object */
export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
  /* 409 deployment lock: { error, message, active_deployment, next_step } */
  get lock() {
    const d = this.body?.detail
    return d && typeof d === 'object' && !Array.isArray(d) && d.active_deployment ? d : null
  }
}

export function describeError(err) {
  if (!err) return ''
  if (err.name === 'AbortError') return 'Request cancelled.'
  if (err instanceof ApiError) {
    if (err.lock) return err.lock.message
    const hints = {
      401: 'Not authorised — check the VITE_SCCM_API_KEY configuration.',
      403: 'Not allowed — deployment is disabled on the server, or the admin key is wrong.',
      503: 'This feature is not configured on the API.',
    }
    return hints[err.status] ? `${err.message} (${hints[err.status]})` : err.message
  }
  if (err.code === 'POLL_TIMEOUT') return err.message
  return `Cannot reach the SCCM API at ${BASE_URL}. ${err.message || ''}`.trim()
}

async function request(method, path, { body, headers = {}, signal, raw = false } = {}) {
  const user = getUserName()
  const res = await fetch(BASE_URL + path, {
    method,
    signal,
    headers: {
      ...(path !== '/health' && { 'X-API-Key': API_KEY }),
      ...(user && { 'X-User': user }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (raw && res.ok) return res
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  if (!res.ok) {
    const d = data?.detail
    const msg = typeof d === 'string' ? d
      : Array.isArray(d) ? d.map((e) => `${(e.loc || []).slice(1).join('.')}: ${e.msg}`).join('; ')
      : d?.message ?? (d ? JSON.stringify(d) : (res.statusText || `HTTP ${res.status}`))
    throw new ApiError(res.status, msg, data)
  }
  return data
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

/* Poll a job until final, streaming its log.
   onLog(lines) gets each batch of new lines, onUpdate(job) every poll.
   cursor = last seen log seq (-1 = from the start). Returns the final job.
   Throws AbortError, ApiError (4xx, or 3 failures in a row), or
   { code: 'POLL_TIMEOUT', job, cursor } when the UI limit is hit (the job keeps running). */
export async function pollJob(job, { onUpdate, onLog, signal, cursor = -1, skipFirstDelay = false } = {}) {
  onUpdate?.(job)
  const cfg = pollConfig(job.kind)
  const stopAt = Date.now() + cfg.timeoutMs
  let failures = 0
  if (isFinal(job) && cursor >= (job.log_lines ?? 0) - 1) return job
  if (!skipFirstDelay && !isFinal(job)) await sleep(cfg.firstDelayMs, signal)
  for (;;) {
    try {
      job = await request('GET', `/api/jobs/${encodeURIComponent(job.job_id)}?wait=${cfg.waitSeconds}&log_after=${cursor}`, { signal })
      failures = 0
      const lines = asArray(job.log)
      if (lines.length) { cursor = job.log_next; onLog?.(lines, cursor) }
      onUpdate?.(job)
      if (job.log_more) continue
      if (isFinal(job)) return job
    } catch (e) {
      if (e.name === 'AbortError' || (e instanceof ApiError && e.status < 500)) throw e
      if (++failures >= 3) throw e
    }
    if (Date.now() > stopAt) throw Object.assign(new Error('Still running – check again later.'), { code: 'POLL_TIMEOUT', job, cursor })
    await sleep(cfg.gapMs, signal)
  }
}

/* ─── Endpoints ─── */
export const health              = (o) => request('GET', '/health', o)
export const activeDeployment    = (o) => request('GET', '/api/sccm/deployments/active', o)
export const getJob              = (id, o) => request('GET', `/api/jobs/${encodeURIComponent(id)}`, o)
export const getJobLog           = (id, after = -1, o) => request('GET', `/api/jobs/${encodeURIComponent(id)}/log?after=${after}&limit=5000`, o)
export const listJobs            = (limit = 30, o) => request('GET', `/api/jobs?limit=${limit}`, o)
export const auditLog            = (limit = 100, o) => request('GET', `/api/audit?limit=${limit}`, o)
export const connectionTest      = (o) => request('POST', '/api/sccm/connection-test', o)
export const environmentCheck    = (o) => request('POST', '/api/sccm/environment-check', o)
/* body: { ad_job_id, servers } — servers chosen from an AD list job (without it the API checks its allowlist file) */
export const prerequisites       = (body, o) => request('POST', '/api/sccm/prerequisites', { ...o, ...(body?.servers?.length && { body }) })
export const listAdServers       = (opts = {}, o) => request('POST', '/api/sccm/ad-servers', { ...o, body: opts })
export const latestAdServers     = (o) => request('GET', '/api/sccm/ad-servers/latest', o)
export const listSugs            = (opts = {}, o) => request('POST', '/api/sccm/sugs', { ...o, body: { include_kbs: true, ...opts } })
export const latestSugs          = (o) => request('GET', '/api/sccm/sugs/latest', o)
export const listCollections     = (opts = {}, o) => request('POST', '/api/sccm/collections', { ...o, body: { include_members: true, ...opts } })
export const latestCollections   = (o) => request('GET', '/api/sccm/collections/latest', o)
export const lookupDeployment    = (name, o) => request('POST', '/api/sccm/deployments/lookup', { ...o, body: { deployment_name: name } })
export const listReports         = ({ kind, limit = 100, offset = 0 } = {}, o) =>
  request('GET', `/api/reports?limit=${limit}&offset=${offset}${kind ? `&kind=${kind}` : ''}`, o)
export const getReport           = (id, o) => request('GET', `/api/reports/${encodeURIComponent(id)}`, o)
export const getReportHtml       = async (id, o) => (await request('GET', `/api/reports/${encodeURIComponent(id)}/html`, { ...o, raw: true })).text()
export const listJumphostReports = (limit = 50, o) => request('POST', '/api/sccm/reports/jumphost', { ...o, body: { limit } })
export const importJumphostReport = (folder, o) => request('POST', '/api/sccm/reports/jumphost/import', { ...o, body: { report_folder: folder } })

export const startDeployment = (body, idempotencyKey, o) =>
  request('POST', '/api/sccm/deployments', { ...o, headers: { 'Idempotency-Key': idempotencyKey }, body })
export const resumeDeployment = (reportFolder, idempotencyKey, o) =>
  request('POST', '/api/sccm/deployments/resume', { ...o, headers: { 'Idempotency-Key': idempotencyKey }, body: reportFolder ? { report_folder: reportFolder } : {} })
export const releaseLock = (jobId, reason, adminKey, o) =>
  request('POST', '/api/sccm/deployments/release-lock', { ...o, headers: adminKey ? { 'X-Admin-Key': adminKey } : {}, body: { job_id: jobId, reason } })

/* Create a deployment, retrying network/5xx failures with the SAME idempotency key */
export async function startDeploymentWithRetry(body, idempotencyKey, o = {}) {
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await startDeployment(body, idempotencyKey, o)
    } catch (e) {
      if (e.name === 'AbortError' || (e instanceof ApiError && e.status < 500)) throw e
      lastErr = e
      await sleep(1500 * (attempt + 1), o.signal)
    }
  }
  throw lastErr
}

export const newIdempotencyKey = () =>
  (globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    }))

/* The user enters UTC in a datetime-local field */
export const toUtcIso = (localValue) => (localValue ? `${localValue}:00Z` : '')
export const toUtcInput = (date) => date.toISOString().slice(0, 16)

/* "SUCCEEDED and less than N hours old" */
export const isFresh = (job, maxAgeMs = 24 * 3600_000) =>
  job?.status === 'SUCCEEDED' && Date.now() - new Date(job.finished_at || job.created_at).getTime() < maxAgeMs
