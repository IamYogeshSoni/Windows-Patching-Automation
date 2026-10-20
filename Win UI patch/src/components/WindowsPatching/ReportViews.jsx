import React, { useMemo, useState } from 'react'
import { asArray } from '../../api/sccmApi'
import { STAGES } from './hooks'
import { Card, Kpi, Ring, StackBar, StatusPill, Banner, fmtUtc, fmtDuration, parseTime, shortHost, tone } from './ui'

/* ══════════════════════════════════════════════════════════════════
   Reports rendered from the API's report data (GET /api/reports/{id}).
   report = the job result; job = the job (status, requested_by, times).
══════════════════════════════════════════════════════════════════ */

export function reportTypeOf(job, report) {
  if (job?.kind === 'report_import') return report?.report_type || 'other'
  if (job?.kind === 'deployment' || job?.kind === 'deployment_resume') return 'deployment'
  return job?.kind || 'other'
}

export default function ReportView({ job, report, logs = [] }) {
  const type = reportTypeOf(job, report)
  if (type === 'deployment') return <DeploymentReport job={job} report={report} logs={logs} />
  if (type === 'prerequisites') return <PrerequisiteReport job={job} report={report} />
  if (type === 'environment') return <EnvironmentReport job={job} report={report} />
  return <Card title="Report"><pre className="wpx-pre">{JSON.stringify(report, null, 2)}</pre></Card>
}

/* ─── Shared pieces ─── */
function Hero({ kicker, title, status, ring, chips = [], children }) {
  return (
    <div className={`wpx-rhero wpx-rhero-${tone(status)}`}>
      <div className="wpx-rhero-glow" aria-hidden="true" />
      <div className="wpx-rhero-main">
        <div className="wpx-rhero-kicker">{kicker}</div>
        <h2 className="wpx-rhero-title">{title}</h2>
        <div className="wpx-rhero-status"><StatusPill status={status} size="lg" /></div>
        {children && <div className="wpx-rhero-text">{children}</div>}
        <div className="wpx-chips">
          {chips.filter(c => c && c.value).map((c, i) => (
            <span key={i} className="wpx-chip" title={c.label}><i className={`fa-solid ${c.icon}`} />{c.value}</span>
          ))}
        </div>
      </div>
      {ring && <div className="wpx-rhero-ring">{ring}</div>}
    </div>
  )
}

function KeyValues({ items }) {
  return (
    <dl className="wpx-kv">
      {items.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v, raw]) => (
        <div key={k} className="wpx-kv-row">
          <dt>{k}</dt>
          <dd>{raw ? v : String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function DataTable({ rows, empty = 'Nothing to show.', badgeColumns = [] }) {
  const list = asArray(rows).filter(r => r && typeof r === 'object')
  if (!list.length) return <p className="wpx-muted">{empty}</p>
  const cols = [...new Set(list.flatMap(r => Object.keys(r)))]
  return (
    <div className="wpx-table-wrap">
      <table className="wpx-table">
        <thead><tr>{cols.map(c => <th key={c}>{c.replace(/([a-z])([A-Z])/g, '$1 $2')}</th>)}</tr></thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={i}>
              {cols.map(c => {
                const v = r[c]
                const text = Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : v
                return <td key={c}>{badgeColumns.includes(c) ? <StatusPill status={text} size="sm" /> : String(text ?? '')}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const errorsOf = (report) => asArray(report?.errors).filter(Boolean)
const warningsOf = (report) => asArray(report?.warnings).filter(Boolean)

function Notices({ report }) {
  const errors = errorsOf(report)
  const warnings = warningsOf(report)
  if (!errors.length && !warnings.length) return null
  return (
    <div className="wpx-stack">
      {errors.map((e, i) => <Banner key={`e${i}`} toneName="bad" title="Error">{e}</Banner>)}
      {warnings.map((w, i) => <Banner key={`w${i}`} toneName="info" icon="fa-circle-info">{w}</Banner>)}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════
   Deployment report
══════════════════════════════════════════════════════════════════ */
const SOP_SETTINGS = {
  OverrideServiceWindows: { label: 'Install outside maintenance window', want: false },
  RebootOutsideOfServiceWindows: { label: 'Restart outside maintenance window', want: false },
  SuppressReboot: { label: 'Restarts suppressed', want: 0, show: v => (Number(v) === 0 ? 'No (restarts allowed)' : `Yes (${v})`) },
  DisableMomAlerts: { label: 'Operations Manager alerts disabled', want: true },
  UseGMTTimes: { label: 'Schedule in UTC', want: true },
  Enabled: { label: 'Deployment enabled', want: true },
}
const truthy = (v) => v === true || v === 'True' || v === 'true'

export function DeploymentReport({ job = {}, report = {}, logs = [] }) {
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {}
  const request = job.request || {}
  const servers = asArray(report.servers?.length ? report.servers : summary.Results).filter(s => s && s.Server)
  const validation = asArray(report.validation).filter(v => v && v.Server)
  const deployment = report.deployment || summary.Deployment || {}
  const window = report.maintenance_window || summary.MaintenanceWindow || {}
  const status = job.status

  const patched = servers.filter(s => s.Verdict === 'PATCHED').length
  const restarted = servers.filter(s => truthy(s.Restarted)).length
  const compliant = servers.filter(s => truthy(s.AlreadyCompliant)).length
  const kbInstalled = validation.filter(v => v.Result === 'INSTALLED').length
  const kbMissing = validation.filter(v => v.Result === 'MISSING').length
  const name = report.deployment_name || summary.DeploymentName || request.DeploymentName || job.deployment_name || 'Deployment'
  const duration = report.duration_seconds ? fmtDuration(report.duration_seconds * 1000) : null

  const headline = {
    SUCCEEDED: `All ${servers.length} server${servers.length === 1 ? '' : 's'} patched and validated.`,
    COMPLETED_WITH_ISSUES: `${patched} of ${servers.length} servers patched — review the servers marked below.`,
    FAILED: errorsOf(report)[0] || 'The deployment did not complete.',
    OUTCOME_UNKNOWN: 'The run was interrupted after the deployment may have been created.',
  }[status] || report.report_headline

  return (
    <div className="wpx-report">
      <Hero
        kicker="Patch deployment report"
        title={name}
        status={status}
        ring={servers.length ? <Ring value={patched} total={servers.length} size={150} stroke={14} label={`${patched}/${servers.length}`} sub="patched" /> : null}
        chips={[
          { icon: 'fa-box-archive', label: 'Software update group', value: report.sug || summary.SUG || request.SugName },
          { icon: 'fa-layer-group', label: 'Collection', value: report.collection || summary.Collection || request.CollectionName },
          { icon: 'fa-ticket', label: 'Change ticket', value: summary.ChangeTicket || request.ChangeTicket },
          { icon: 'fa-user', label: 'Requested by', value: job.requested_by },
          { icon: 'fa-stopwatch', label: 'Duration', value: duration },
          { icon: 'fa-calendar', label: 'Finished', value: job.finished_at && fmtUtc(job.finished_at) },
        ]}
      >
        {headline}
      </Hero>

      <Notices report={report} />

      <div className="wpx-kpi-grid">
        <Kpi icon="fa-server" label="Servers" value={servers.length} toneName="brand" />
        <Kpi icon="fa-circle-check" label="Patched" value={patched} toneName="good" />
        <Kpi icon="fa-circle-xmark" label="Not patched" value={servers.length - patched} toneName={servers.length - patched ? 'bad' : 'neutral'} />
        <Kpi icon="fa-power-off" label="Restarted" value={restarted} toneName="indigo" />
        <Kpi icon="fa-shield-halved" label="Already compliant" value={compliant} toneName="teal" />
        <Kpi icon="fa-puzzle-piece" label="KBs installed" value={kbInstalled} sub={kbMissing ? `${kbMissing} missing` : 'none missing'} toneName={kbMissing ? 'warn' : 'good'} />
      </div>

      <ScheduleTimeline job={job} window={window} deployment={deployment} request={request} />

      {servers.length > 0 && (
        <Card title="Server results" icon="fa-server" kicker={`${servers.length} servers`}>
          <div className="wpx-server-grid">
            {servers.map(s => <ServerResultCard key={s.Server} server={s} validation={validation.filter(v => v.Server === s.Server)} />)}
          </div>
        </Card>
      )}

      {validation.length > 0 && <KbMatrix validation={validation} servers={servers.map(s => s.Server)} />}

      <div className="wpx-two-col">
        <Card title="Deployment settings" icon="fa-sliders" kicker="Read back from SCCM">
          {Object.keys(deployment).length ? (
            <ul className="wpx-settings">
              {Object.entries(deployment).map(([k, v]) => {
                const sop = SOP_SETTINGS[k]
                const ok = sop ? (typeof sop.want === 'number' ? Number(v) === sop.want : truthy(v) === sop.want) : null
                return (
                  <li key={k}>
                    <span className={`wpx-setting-icon ${ok === null ? '' : ok ? 'ok' : 'bad'}`}>
                      <i className={`fa-solid ${ok === null ? 'fa-circle-info' : ok ? 'fa-check' : 'fa-xmark'}`} />
                    </span>
                    <span className="wpx-setting-name">{sop?.label || k.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>
                    <span className="wpx-setting-val">{sop?.show ? sop.show(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : /Time|Deadline/.test(k) ? fmtUtc(v) : String(v)}</span>
                  </li>
                )
              })}
            </ul>
          ) : <p className="wpx-muted">No deployment was created.</p>}
        </Card>
        <Card title="Run details" icon="fa-circle-info">
          <KeyValues items={[
            ['Change ticket', summary.ChangeTicket || request.ChangeTicket],
            ['Approver', summary.Approver || request.Approver],
            ['Approval reference', summary.ApprovalReference || request.ApprovalReference],
            ['Collection ID', summary.CollectionId || request.CollectionId],
            ['Collection created', report.collection_created || summary.CollectionCreated ? 'Yes — created with the selected servers' : 'No — existing collection'],
            ['Restart mode', request.RestartMode],
            ['Requested deadline', request.DeadlineUtc ? `${request.DeadlineUtc} UTC` : 'As soon as possible'],
            ['Report folder', report.report_folder_name],
            ['Jumphost', report.host],
            ['Run as', report.run_as],
            ['Job', job.job_id],
          ]} />
        </Card>
      </div>

      {asArray(summary.Baseline).length > 0 && (
        <Card title="Baseline before deployment" icon="fa-clipboard-list" kicker="Updates each server needed">
          <DataTable rows={summary.Baseline} />
        </Card>
      )}
      {summary.ContentPackages && (
        <Card title="Content distribution" icon="fa-cloud-arrow-down">
          {Array.isArray(summary.ContentPackages) || typeof summary.ContentPackages === 'object'
            ? <DataTable rows={summary.ContentPackages} /> : <p>{String(summary.ContentPackages)}</p>}
        </Card>
      )}

      <StageTimeline logs={logs} />
      <LogIssues logs={logs} />
    </div>
  )
}

function ScheduleTimeline({ job, window, deployment, request }) {
  const points = [
    { key: 'start', label: 'Run started', t: parseTime(job.started_at), icon: 'fa-play' },
    { key: 'ws', label: 'Window opens', t: parseTime(window.StartUtc), icon: 'fa-door-open' },
    { key: 'dl', label: 'Deadline', t: parseTime(deployment.EnforcementDeadline) || (request.DeadlineUtc ? parseTime(`${request.DeadlineUtc.replace(' ', 'T')}:00Z`) : NaN), icon: 'fa-flag-checkered' },
    { key: 'end', label: 'Run finished', t: parseTime(job.finished_at), icon: 'fa-stop' },
    { key: 'we', label: 'Window closes', t: parseTime(window.EndUtc), icon: 'fa-door-closed' },
  ].filter(p => !Number.isNaN(p.t))
  if (points.length < 2) return null
  const min = Math.min(...points.map(p => p.t))
  const max = Math.max(...points.map(p => p.t))
  const pos = (t) => (max === min ? 0 : ((t - min) / (max - min)) * 100)
  const ws = parseTime(window.StartUtc), we = parseTime(window.EndUtc)
  // Points closer than 8% share one marker with stacked labels, so labels never overlap
  const groups = []
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    const last = groups.at(-1)
    if (last && pos(p.t) - pos(last.t) < 8) last.items.push(p)
    else groups.push({ key: p.key, t: p.t, icon: p.icon, items: [p] })
  }
  return (
    <Card title="Schedule" icon="fa-calendar-days" kicker="Maintenance window and deadline">
      <div className="wpx-sched">
        <div className="wpx-sched-track">
          {!Number.isNaN(ws) && !Number.isNaN(we) && (
            <div className="wpx-sched-window" style={{ left: `${pos(ws)}%`, width: `${Math.max(1, pos(we) - pos(ws))}%` }}><span>Maintenance window</span></div>
          )}
          {groups.map((g, i) => (
            <div key={g.key} className={`wpx-sched-point wpx-sched-${g.items.at(-1).key} ${i % 2 ? 'below' : ''} ${pos(g.t) < 12 ? 'edge-left' : pos(g.t) > 88 ? 'edge-right' : ''}`} style={{ left: `${pos(g.t)}%` }}>
              <span className="wpx-sched-dot"><i className={`fa-solid ${g.items.length > 1 ? 'fa-layer-group' : g.icon}`} /></span>
              <span className="wpx-sched-label">
                {g.items.map(p => <span key={p.key}><strong>{p.label}</strong> {fmtUtc(p.t).slice(11)}</span>)}
                <em>{fmtUtc(g.t).slice(0, 10)}</em>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

function ServerResultCard({ server, validation }) {
  const required = asArray(server.RequiredKbsBefore)
  const missing = new Set(asArray(server.MissingKbs))
  const kbs = validation.length ? validation.map(v => ({ kb: v.KB, result: v.Result })) : required.map(kb => ({ kb, result: missing.has(kb) ? 'MISSING' : 'INSTALLED' }))
  return (
    <div className={`wpx-srv wpx-srv-${tone(server.Verdict)}`}>
      <div className="wpx-srv-head">
        <span className="wpx-srv-icon"><i className="fa-brands fa-windows" /></span>
        <div className="wpx-srv-name">
          <strong>{shortHost(server.Server)}</strong>
          <span>{server.Server}</span>
        </div>
        <StatusPill status={server.Verdict} />
      </div>
      <div className="wpx-srv-facts">
        <span><i className="fa-solid fa-gear" /> {String(server.InstallState || '—').replace(/_/g, ' ').toLowerCase()}</span>
        <span><i className="fa-solid fa-power-off" /> {truthy(server.Restarted) ? 'Restarted' : 'No restart'}</span>
        {truthy(server.AlreadyCompliant) && <span><i className="fa-solid fa-shield-halved" /> Already compliant</span>}
      </div>
      {kbs.length > 0 && (
        <div className="wpx-kb-chips">
          {kbs.map(k => <span key={k.kb} className={`wpx-kb wpx-kb-${tone(k.result)}`} title={k.result}>{k.kb}</span>)}
        </div>
      )}
      {server.Detail && <div className="wpx-srv-detail">{server.Detail}</div>}
    </div>
  )
}

function KbMatrix({ validation, servers }) {
  const [showTable, setShowTable] = useState(false)
  const kbs = useMemo(() => [...new Set(validation.map(v => v.KB))].sort(), [validation])
  const titles = Object.fromEntries(validation.map(v => [v.KB, v.Title]))
  const cell = (server, kb) => validation.find(v => v.Server === server && v.KB === kb)
  const counts = ['INSTALLED', 'MISSING', 'NOT_REQUIRED', 'NOT_FOUND', 'UNKNOWN'].map(r => ({ r, n: validation.filter(v => v.Result === r).length })).filter(c => c.n)
  return (
    <Card
      title="KB validation"
      icon="fa-table-cells"
      kicker={`${kbs.length} KBs × ${servers.length} servers`}
      actions={<button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={() => setShowTable(v => !v)}><i className={`fa-solid ${showTable ? 'fa-table-cells' : 'fa-list'}`} /> {showTable ? 'Matrix' : 'Details'}</button>}
    >
      <div className="wpx-legend">
        {counts.map(c => <span key={c.r}><StatusPill status={c.r} size="sm" /> {c.n}</span>)}
      </div>
      {!showTable ? (
        <div className="wpx-table-wrap">
          <table className="wpx-matrix">
            <thead>
              <tr><th>KB</th>{servers.map(s => <th key={s} title={s}>{shortHost(s)}</th>)}</tr>
            </thead>
            <tbody>
              {kbs.map(kb => (
                <tr key={kb}>
                  <th scope="row"><strong>{kb}</strong><span>{titles[kb]}</span></th>
                  {servers.map(s => {
                    const c = cell(s, kb)
                    return (
                      <td key={s}>
                        {c ? <span className={`wpx-cell wpx-cell-${tone(c.Result)}`} title={`${c.Result}${c.Evidence ? ` · ${c.Evidence}` : ''}`}>
                          <i className={`fa-solid ${c.Result === 'INSTALLED' ? 'fa-check' : c.Result === 'MISSING' ? 'fa-xmark' : 'fa-minus'}`} />
                        </span> : <span className="wpx-cell wpx-cell-empty">·</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="wpx-table-wrap">
          <table className="wpx-table">
            <thead><tr><th>Server</th><th>KB</th><th>Title</th><th>Result</th><th>SCCM status</th><th>Evidence</th><th>Note</th></tr></thead>
            <tbody>
              {validation.map((v, i) => (
                <tr key={i}>
                  <td>{shortHost(v.Server)}</td><td><strong>{v.KB}</strong></td><td>{v.Title}</td>
                  <td><StatusPill status={v.Result} size="sm" /></td><td>{v.SccmStatus}</td><td>{v.Evidence}</td><td>{v.Note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function StageTimeline({ logs }) {
  const marks = useMemo(() => {
    const out = []
    for (const l of logs) {
      const text = String(l.line || '').trim()
      const stage = STAGES.find(s => s.match?.test(text))
      if (stage && !out.some(o => o.key === stage.key)) out.push({ key: stage.key, label: stage.label, icon: stage.icon, time: l.time, text })
      if (/^Job finished with status/.test(text)) out.push({ key: 'done', label: 'Finished', icon: 'fa-flag-checkered', time: l.time, text })
    }
    return out
  }, [logs])
  if (!marks.length) return null
  return (
    <Card title="Run timeline" icon="fa-timeline" kicker="From the jumphost log">
      <ol className="wpx-vtl">
        {marks.map((m, i) => {
          const next = marks[i + 1]
          const took = next ? parseTime(next.time) - parseTime(m.time) : null
          return (
            <li key={`${m.key}-${i}`}>
              <span className="wpx-vtl-dot"><i className={`fa-solid ${m.icon}`} /></span>
              <div className="wpx-vtl-body">
                <div className="wpx-vtl-title">{m.label}<span>{fmtUtc(m.time, { seconds: true })}</span></div>
                <div className="wpx-vtl-text">{m.text}</div>
              </div>
              {took != null && !Number.isNaN(took) && <span className="wpx-vtl-took">{fmtDuration(took)}</span>}
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function LogIssues({ logs }) {
  const issues = logs.filter(l => /^\s*(WARNING|ERROR)\b/.test(String(l.line || '')))
  if (!issues.length) return null
  return (
    <Card title={`Warnings and errors (${issues.length})`} icon="fa-triangle-exclamation">
      <div className="wpx-issues">
        {issues.slice(-100).map((l, i) => (
          <div key={i} className={`wpx-issue ${/^\s*ERROR/.test(l.line) ? 'bad' : 'warn'}`}>
            <span>{fmtUtc(l.time, { seconds: true })}</span>{l.line.replace(/^\s*(WARNING|ERROR):?\s*/, '')}
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ══════════════════════════════════════════════════════════════════
   Prerequisites report
══════════════════════════════════════════════════════════════════ */
export function PrerequisiteReport({ job = {}, report = {} }) {
  const servers = asArray(report.servers).filter(s => s && s.Server)
  const checks = asArray(report.checks).filter(c => c && c.Check)
  const ready = servers.filter(s => s.Overall === 'READY').length
  const eligible = servers.filter(s => s.Eligibility === 'ELIGIBLE').length
  const failed = checks.filter(c => tone(c.Status) === 'bad').length
  const warns = checks.filter(c => tone(c.Status) === 'warn').length
  const siteChecks = checks.filter(c => !servers.some(s => s.Server === c.Target))
  const status = job.status === 'SUCCEEDED' && servers.length && ready < servers.length ? 'COMPLETED_WITH_ISSUES' : job.status
  return (
    <div className="wpx-report">
      <Hero
        kicker="Prerequisite checks"
        title={servers.length ? `${ready} of ${servers.length} servers ready` : 'Prerequisite checks'}
        status={status}
        ring={servers.length ? <Ring value={ready} total={servers.length} size={150} stroke={14} label={`${ready}/${servers.length}`} sub="ready" /> : null}
        chips={[
          { icon: 'fa-user', label: 'Requested by', value: job.requested_by },
          { icon: 'fa-calendar', label: 'Checked', value: job.finished_at && fmtUtc(job.finished_at) },
          { icon: 'fa-desktop', label: 'Jumphost', value: report.host },
          { icon: 'fa-folder-open', label: 'Report folder', value: report.report_folder_name },
        ]}
      >
        Checked against the T1 Server Patch Deployment SOP: AD object, DNS, reachability, uptime, disk, pending reboot and SCCM client health.
      </Hero>
      <Notices report={report} />
      <div className="wpx-kpi-grid">
        <Kpi icon="fa-server" label="Servers" value={servers.length} />
        <Kpi icon="fa-circle-check" label="Ready" value={ready} toneName="good" />
        <Kpi icon="fa-circle-xmark" label="Not ready" value={servers.length - ready} toneName={servers.length - ready ? 'bad' : 'neutral'} />
        <Kpi icon="fa-user-check" label="Eligible" value={eligible} toneName="teal" />
        <Kpi icon="fa-bug" label="Failed checks" value={failed} toneName={failed ? 'bad' : 'neutral'} />
        <Kpi icon="fa-triangle-exclamation" label="Warnings" value={warns} toneName={warns ? 'warn' : 'neutral'} />
      </div>
      <Card title="Servers" icon="fa-server" kicker="Readiness per server">
        <div className="wpx-server-grid">
          {servers.map(s => <PrereqServerCard key={s.Server} server={s} checks={checks.filter(c => c.Target === s.Server)} />)}
        </div>
      </Card>
      {siteChecks.length > 0 && (
        <Card title="Site and collection" icon="fa-sitemap">
          <CheckList checks={siteChecks} />
        </Card>
      )}
    </div>
  )
}

function PrereqServerCard({ server, checks }) {
  const [open, setOpen] = useState(server.Overall !== 'READY')
  const good = checks.filter(c => tone(c.Status) === 'good').length
  const bad = checks.filter(c => tone(c.Status) === 'bad').length
  const warn = checks.length - good - bad
  return (
    <div className={`wpx-srv wpx-srv-${server.Overall === 'READY' ? 'good' : 'bad'}`}>
      <div className="wpx-srv-head">
        <span className="wpx-srv-icon"><i className="fa-brands fa-windows" /></span>
        <div className="wpx-srv-name"><strong>{shortHost(server.Server)}</strong><span>{server.Server}</span></div>
        <StatusPill status={server.Overall} />
      </div>
      <div className="wpx-srv-facts">
        <StatusPill status={server.Eligibility} size="sm" />
        {server.Failed && <span className="wpx-tone-bad"><i className="fa-solid fa-xmark" /> {server.Failed}</span>}
        {server.Warnings && <span className="wpx-tone-warn"><i className="fa-solid fa-triangle-exclamation" /> {server.Warnings}</span>}
      </div>
      {checks.length > 0 && (
        <>
          <StackBar parts={[{ value: good, tone: 'good', label: 'Passed' }, { value: warn, tone: 'warn', label: 'Warnings / info' }, { value: bad, tone: 'bad', label: 'Failed' }]} />
          <button type="button" className="wpx-link" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            <i className={`fa-solid fa-chevron-${open ? 'up' : 'down'}`} /> {checks.length} checks · {good} passed{bad ? ` · ${bad} failed` : ''}
          </button>
          {open && <CheckList checks={checks} compact />}
        </>
      )}
    </div>
  )
}

function CheckList({ checks, compact = false }) {
  return (
    <ul className={`wpx-checks ${compact ? 'compact' : ''}`}>
      {checks.map((c, i) => (
        <li key={i} className={`wpx-check wpx-check-${tone(c.Status)}`}>
          <span className="wpx-check-icon"><i className={`fa-solid ${tone(c.Status) === 'good' ? 'fa-check' : tone(c.Status) === 'bad' ? 'fa-xmark' : tone(c.Status) === 'warn' ? 'fa-exclamation' : 'fa-info'}`} /></span>
          <div className="wpx-check-body">
            <div className="wpx-check-title">{c.Check}<StatusPill status={c.Status} size="sm" icon={false} /></div>
            {c.Detail && <div className="wpx-check-detail">{c.Detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ══════════════════════════════════════════════════════════════════
   Environment report
══════════════════════════════════════════════════════════════════ */
export function EnvironmentReport({ job = {}, report = {} }) {
  const checks = asArray(report.checks).filter(c => c && c.Check)
  const passed = checks.filter(c => tone(c.Status) === 'good').length
  return (
    <div className="wpx-report">
      <Hero
        kicker="Environment check"
        title={checks.length ? `${passed} of ${checks.length} checks passed` : 'Environment check'}
        status={job.status}
        ring={checks.length ? <Ring value={passed} total={checks.length} size={150} stroke={14} label={`${passed}/${checks.length}`} sub="passed" /> : null}
        chips={[
          { icon: 'fa-desktop', label: 'Jumphost', value: report.host },
          { icon: 'fa-user-gear', label: 'Run as', value: report.run_as },
          { icon: 'fa-user', label: 'Requested by', value: job.requested_by },
          { icon: 'fa-calendar', label: 'Checked', value: job.finished_at && fmtUtc(job.finished_at) },
        ]}
      >
        PowerShell, Active Directory and Configuration Manager tooling on the SCCM jumphost.
      </Hero>
      <Notices report={report} />
      <Card title="Checks" icon="fa-list-check">
        {checks.length ? <CheckList checks={checks} /> : <pre className="wpx-pre">{report.output}</pre>}
      </Card>
    </div>
  )
}
