import React, { useCallback, useEffect, useState } from 'react'
import { asArray, auditLog, describeError, listJobs } from '../../api/sccmApi'
import { Banner, Card, Empty, Spinner, StatusPill, fmtAgo, fmtUtc, useNow } from './ui'

const ACTIONS = {
  deployment_started: { icon: 'fa-rocket', label: 'Started a deployment', tone: 'brand' },
  deployment_resume_started: { icon: 'fa-play', label: 'Resumed a deployment', tone: 'brand' },
  deployment_finished: { icon: 'fa-flag-checkered', label: 'Deployment finished', tone: 'good' },
  deployment_blocked: { icon: 'fa-lock', label: 'Deployment blocked by the lock', tone: 'warn' },
  lock_released: { icon: 'fa-unlock', label: 'Released the deployment lock', tone: 'bad' },
}
const KIND_LABEL = {
  environment: 'Environment check', prerequisites: 'Readiness checks', deployment: 'Deployment', deployment_resume: 'Deployment resume',
  sugs: 'Update group list', collections: 'Collection list', connection_test: 'Connection test', deployment_lookup: 'Deployment lookup',
  report_list: 'Jumphost reports', ad_servers: 'AD server list', report_import: 'Report import', dslab_connection_test: 'DSLAB connection', dslab_validate: 'DSLAB validation',
  inventory: 'Inventory', dry_run: 'Dry run',
}

export default function ActivityView({ onOpenReport }) {
  const now = useNow(true, 30_000)
  const [state, setState] = useState({ loading: true, audit: [], jobs: [], error: null })
  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true }))
    try {
      const [a, j] = await Promise.all([auditLog(100), listJobs(40)])
      setState({ loading: false, audit: asArray(a.entries), jobs: asArray(j.jobs), error: null })
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: describeError(e) }))
    }
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="wpx-activity">
      {state.error && <Banner toneName="bad">{state.error}</Banner>}
      <Card title="Audit trail" icon="fa-shield-halved" kicker="Who did what" actions={
        <button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={load} disabled={state.loading}>{state.loading ? <Spinner /> : <i className="fa-solid fa-rotate" />} Refresh</button>
      }>
        {!state.audit.length && !state.loading ? <Empty icon="fa-shield-halved" title="No audit entries yet" /> : (
          <ol className="wpx-audit">
            {state.audit.map(e => {
              const a = ACTIONS[e.action] || { icon: 'fa-circle', label: e.action, tone: 'neutral' }
              return (
                <li key={e.id} className={`wpx-audit-${a.tone}`}>
                  <span className="wpx-audit-dot"><i className={`fa-solid ${a.icon}`} /></span>
                  <div className="wpx-audit-body">
                    <div><strong>{e.user || 'unknown'}</strong> · {a.label}</div>
                    {e.detail && <div className="wpx-audit-detail">{e.detail}</div>}
                  </div>
                  <span className="wpx-audit-time" title={fmtUtc(e.ts)}>{fmtAgo(e.ts, now)}</span>
                </li>
              )
            })}
          </ol>
        )}
      </Card>
      <Card title="Recent jobs" icon="fa-list-ul" kicker="All operations">
        <div className="wpx-table-wrap">
          <table className="wpx-table">
            <thead><tr><th>Operation</th><th>Status</th><th>Requested by</th><th>Started</th><th>Job</th><th /></tr></thead>
            <tbody>
              {state.jobs.map(j => (
                <tr key={j.job_id}>
                  <td><strong>{KIND_LABEL[j.kind] || j.kind}</strong>{j.deployment_name && <div className="wpx-muted">{j.deployment_name}</div>}</td>
                  <td><StatusPill status={j.status} size="sm" /></td>
                  <td>{j.requested_by || '—'}</td>
                  <td title={fmtUtc(j.created_at)}>{fmtAgo(j.created_at, now)}</td>
                  <td><code className="wpx-code">{j.job_id}</code></td>
                  <td>{j.report_url && !['QUEUED', 'RUNNING'].includes(j.status) && (
                    <button type="button" className="wpx-link" onClick={() => onOpenReport(j.job_id)}>Report <i className="fa-solid fa-arrow-right" /></button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
