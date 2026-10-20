import React, { useMemo } from 'react'
import { asArray, isFinal } from '../../api/sccmApi'
import { STAGES, serverTimelineFromLog, shortName } from './hooks'
import { Card, StatusPill, fmtDuration, fmtTime, fmtUtc, parseTime, shortHost, tone, useNow } from './ui'

/* What each deployment step did, taken from its own log lines (last match wins) */
const STEP_DETAIL = {
  prepare: /^(SUG:|Creating device collection|Collection '.*?'.*\b(holds|contains)\b)/,
  gates: /^(Site |SUG ')/,
  baseline: /^(Collection '|Every server is already compliant)/,
  content: /(Content is|updates are not downloaded|All updates in the SUG|already checked)/,
  window: /^(Created:|Window '|Existing window)/,
  deploy: /^(Deadline:|Continuing with the existing deployment|Correcting deployment)/,
  install: /(Waiting for|Installation status)/,
  restart: /(is back online|Restarting |restart did not complete|no WinRM access)/,
  validate: /^(Reports:|Server verdicts)/,
}
const NOISE = /^(=+|\s*)$/
const STEP_KEYS = ['prepare', 'gates', 'baseline', 'content', 'window', 'deploy', 'install', 'restart', 'validate']

const LANE_TONE = {
  PENDING: 'idle', INSTALLING: 'live', INSTALLED_PENDING_RESTART: 'warn', RESTARTING: 'violet',
  RESTARTED: 'good', INSTALLED: 'good', ALREADY_COMPLIANT: 'good', FAILED: 'bad',
}
const LANE_LABEL = {
  PENDING: 'Waiting', INSTALLING: 'Installing', INSTALLED_PENDING_RESTART: 'Pending restart', RESTARTING: 'Restarting',
  RESTARTED: 'Back online', INSTALLED: 'Installed', ALREADY_COMPLIANT: 'Already compliant', FAILED: 'Failed',
}

/* Steps of the run with real times: [{ key, label, icon, state, start, end, detail }] */
function buildSteps(lines, job, preflight, now) {
  const final = job && isFinal(job)
  const failed = final && ['FAILED', 'OUTCOME_UNKNOWN'].includes(job.status)
  const starts = {}
  const segments = {}
  let current = null
  let finishedAt = null
  for (const l of lines) {
    const text = String(l.line || '').trim()
    if (/^Job finished with status/.test(text)) { finishedAt = l.time; current = null; continue }
    // Steps only move forward (04 also prints "Collection ... contains" inside its safety gates)
    const stage = STAGES.find(s => STEP_KEYS.includes(s.key) && s.match?.test(text))
    if (stage && STEP_KEYS.indexOf(stage.key) > STEP_KEYS.indexOf(current)) {
      if (!starts[stage.key]) starts[stage.key] = l.time
      current = stage.key
    }
    if (current && !NOISE.test(text) && !/^\d\.\s/.test(text)) (segments[current] || (segments[current] = [])).push(text)
  }
  if (!starts.prepare && job?.started_at && lines.length) starts.prepare = job.started_at

  const pre = (preflight || []).map(p => ({
    key: p.key, label: p.label, icon: p.icon, start: p.started_at, end: p.finished_at,
    state: p.status === 'SUCCEEDED' ? 'done' : p.status ? (isFinal({ status: p.status }) ? 'failed' : 'active') : 'todo',
    detail: p.headline,
  }))

  const reached = STEP_KEYS.filter(k => starts[k])
  const lastReached = reached[reached.length - 1]
  const steps = STEP_KEYS.map((key) => {
    const s = STAGES.find(x => x.key === key)
    const start = starts[key]
    const nextStart = STEP_KEYS.slice(STEP_KEYS.indexOf(key) + 1).map(k => starts[k]).find(Boolean)
    const end = start ? (nextStart || finishedAt || (final ? job.finished_at : null)) : null
    const lines_ = segments[key] || []
    const detail = [...lines_].reverse().find(t => STEP_DETAIL[key]?.test(t)) || lines_[lines_.length - 1]
    let state
    if (start) state = key === lastReached && !final ? 'active' : key === lastReached && failed ? 'failed' : 'done'
    else state = (lastReached && STEP_KEYS.indexOf(key) < STEP_KEYS.indexOf(lastReached)) || (final && !failed) ? 'skipped' : 'todo'
    return { key, label: s.label, icon: s.icon, start, end: end || (state === 'active' ? now : null), detail: detail?.replace(/^\[[^\]]*\]\s*/, ''), state }
  })
  const reportStep = {
    key: 'report', label: 'Report', icon: 'fa-file-lines', start: finishedAt || (final ? job.finished_at : null), end: null,
    state: final ? (failed ? 'failed' : 'done') : 'todo',
    detail: final ? `Job finished: ${job.status.replaceAll('_', ' ').toLowerCase()}` : null,
  }
  return [...pre, ...steps, reportStep]
}

const STATE_ICON = { done: 'fa-check', failed: 'fa-xmark', skipped: 'fa-forward', active: null, todo: null }

/* Live (or finished) deployment as a pipeline plus a timeline per server.
   lines: job log entries { time, line }; preflight: [{ key, label, icon, status, started_at, finished_at, headline }] */
export default function JourneyView({ lines = [], job, preflight, servers: serverList }) {
  const final = job && isFinal(job)
  const now = useNow(!final, 1000)
  const steps = useMemo(() => buildSteps(lines, job, preflight, now), [lines, job, preflight, now])
  const timeline = useMemo(() => serverTimelineFromLog(lines), [lines])

  const servers = asArray(serverList || job?.request?.Servers).map(String)
  const verdicts = Object.fromEntries(asArray(job?.result?.servers).map(s => [shortName(s.Server), s]))
  const t0 = parseTime(lines[0]?.time || job?.started_at)
  const t1 = final ? parseTime(job.finished_at) : now
  const span = Math.max(t1 - t0, 60_000)
  const pos = (t) => `${Math.min(100, Math.max(0, ((parseTime(t) - t0) / span) * 100))}%`
  const markers = steps.filter(s => ['install', 'restart', 'validate'].includes(s.key) && s.start)
  const ticks = Number.isNaN(t0) ? [] : [0, 0.25, 0.5, 0.75, 1].map(f => t0 + f * span)

  return (
    <Card title="Journey" icon="fa-route" kicker={final ? `Finished ${fmtUtc(job.finished_at)}` : 'Live from the jumphost'} className="wpx-journey-card">
      <ol className="wpx-journey">
        {steps.map((s, i) => {
          const took = s.start && s.end ? parseTime(s.end) - parseTime(s.start) : NaN
          return (
            <li key={s.key} className={`wpx-jstep wpx-jstep-${s.state}`}>
              {i > 0 && <span className="wpx-jstep-link" aria-hidden="true" />}
              <div className="wpx-jstep-head">
                <span className="wpx-jstep-dot">
                  {s.state === 'active' ? <span className="wpx-spinner" /> : <i className={`fa-solid ${STATE_ICON[s.state] || s.icon}`} />}
                </span>
                <div className="wpx-jstep-title">
                  <strong>{s.label}</strong>
                  <small>
                    {s.state === 'skipped' ? 'Not needed' : s.start ? fmtTime(s.start) : 'Pending'}
                    {!Number.isNaN(took) && took >= 0 && <> · {fmtDuration(took)}</>}
                  </small>
                </div>
              </div>
              {s.detail && <div className="wpx-jstep-detail" title={s.detail}>{s.detail}</div>}
            </li>
          )
        })}
      </ol>

      {servers.length > 0 && !Number.isNaN(t0) && (
        <div className="wpx-lanes">
          <div className="wpx-lanes-head">
            <span>Server timeline</span>
            <div className="wpx-lanes-legend">
              {['INSTALLING', 'INSTALLED_PENDING_RESTART', 'RESTARTING', 'RESTARTED', 'FAILED'].map(k => (
                <span key={k}><i className={`wpx-lane-sw wpx-lane-${LANE_TONE[k]}`} />{LANE_LABEL[k]}</span>
              ))}
            </div>
          </div>
          <div className="wpx-lanes-grid">
            <div className="wpx-lanes-axis" aria-hidden="true">
              <span />
              <div className="wpx-lanes-ticks">
                {ticks.map((t, i) => <span key={i} style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}>{span < 600_000 ? fmtTime(t) : fmtTime(t).slice(0, 5)}</span>)}
                {markers.map(m => <span key={m.key} className="wpx-lanes-marker" style={{ left: pos(m.start) }}><b>{m.label}</b></span>)}
              </div>
            </div>
            {servers.map(fqdn => {
              const events = timeline[fqdn.toLowerCase()] || []
              const v = verdicts[shortName(fqdn)]
              return (
                <div key={fqdn} className="wpx-lane">
                  <div className="wpx-lane-name" title={fqdn}><strong>{shortHost(fqdn)}</strong>{v ? <StatusPill status={v.Verdict} size="sm" /> : events.length ? <small>{LANE_LABEL[events[events.length - 1].state] || events[events.length - 1].state}</small> : <small>Waiting</small>}</div>
                  <div className="wpx-lane-track">
                    {markers.map(m => <span key={m.key} className="wpx-lane-mline" style={{ left: pos(m.start) }} />)}
                    {events.map((e, i) => {
                      const end = events[i + 1]?.time || (final ? job.finished_at : now)
                      return (
                        <span
                          key={i}
                          className={`wpx-lane-seg wpx-lane-${LANE_TONE[e.state] || tone(e.state)}`}
                          style={{ left: pos(e.time), width: `calc(${pos(end)} - ${pos(e.time)})` }}
                          title={`${LANE_LABEL[e.state] || e.state} from ${fmtUtc(e.time, { seconds: true })}${e.detail ? ` — ${e.detail}` : ''}`}
                        />
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Card>
  )
}
