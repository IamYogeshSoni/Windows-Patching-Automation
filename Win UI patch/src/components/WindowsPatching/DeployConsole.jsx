import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Select from 'react-select'
import {
  ApiError, asArray, describeError, pollJob, toUtcIso, toUtcInput,
  listReports, getReport, prerequisites, latestSugs, listSugs, latestCollections, listCollections, listAdServers, latestAdServers,
} from '../../api/sccmApi'
import { Card, Banner, Modal, Spinner, fmtUtc, fmtAgo, shortHost, useNow } from './ui'
import { shortName } from './hooks'
import ChangeTicketModal from './ChangeTicketModal'
import AdServerPicker from './AdServerPicker'
import { CHANGE_API_ENABLED } from '../../api/changeApi'

const SAFE = /^[A-Za-z0-9 _.\-()]+$/
const PLAN_KEY = 'nova-wp-plan-v3'
const MIN_LEFT = 30 * 60_000

const safeText = (s) => String(s || '').replace(/[^A-Za-z0-9 _.\-()]/g, ' ').replace(/\s+/g, ' ').trim()
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')

function defaultPlan(user) {
  const start = new Date(Date.now() + 15 * 60_000)
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 5) * 5, 0, 0)
  return {
    adDomain: '', adFilter: '', adSearchBase: '', adJobId: null,
    servers: [], includeNotReady: false, sugId: null, sugName: '', collectionMode: 'new', newCollectionName: '', nameTouched: false,
    collectionId: null, collectionName: '', deploymentName: '', deploymentTouched: false,
    windowStart: toUtcInput(start), windowHours: 6, deadlineMode: 'asap', deadline: toUtcInput(new Date(start.getTime() + 30 * 60_000)),
    restartMode: 'Script', changeTicket: '', chg: null, approver: '', approvalReference: '', kbsText: '', confirmed: false,
  }
}
const loadPlan = (user) => {
  try { return { ...defaultPlan(user), ...JSON.parse(localStorage.getItem(PLAN_KEY)), confirmed: false } } catch { return defaultPlan(user) }
}

const selectStyles = {
  control: (b, s) => ({ ...b, minHeight: 46, background: 'var(--bg-panel)', borderRadius: 10, borderColor: s.isFocused ? 'var(--accent)' : 'var(--border-glass-strong)', boxShadow: s.isFocused ? 'var(--focus-ring)' : 'none', '&:hover': { borderColor: 'var(--accent)' } }),
  menu: (b) => ({ ...b, background: 'var(--bg-elevated)', border: '1px solid var(--border-glass)', boxShadow: 'var(--shadow-pop)', borderRadius: 12, overflow: 'hidden', zIndex: 40 }),
  option: (b, s) => ({ ...b, background: s.isSelected ? 'var(--accent-dim)' : s.isFocused ? 'var(--bg-glass-hover)' : 'transparent', color: 'var(--text-main)', cursor: 'pointer' }),
  singleValue: (b) => ({ ...b, color: 'var(--text-main)' }),
  input: (b) => ({ ...b, color: 'var(--text-main)' }),
  placeholder: (b) => ({ ...b, color: 'var(--text-dimmed)' }),
  indicatorSeparator: (b) => ({ ...b, background: 'var(--border-glass)' }),
}

/* Loads a list job result: GET …/latest, else POST a new list job and poll it */
function useListJob(latest, start, key, enabled = true) {
  const [state, setState] = useState({ loading: false, result: null, at: null, error: null })
  const run = useCallback(async (fresh = false) => {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      if (!fresh) {
        try {
          const l = await latest()
          setState({ loading: false, result: l.result, at: l.finished_at, error: null })
          return
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e
        }
      }
      const job = await pollJob(await start())
      if (job.status !== 'SUCCEEDED') throw new Error(asArray(job.result?.errors).join(' ') || `${key} could not be loaded.`)
      setState({ loading: false, result: job.result, at: job.finished_at, error: null })
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: describeError(e) }))
    }
  }, [latest, start, key])
  useEffect(() => { if (enabled) run(false) }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh: () => run(true) }
}

const startSugs = () => listSugs()
const startCollections = () => listCollections()

export default function DeployConsole({ status, run, user, onStart, onGoLive, onOpenReport }) {
  const [plan, setPlanState] = useState(() => loadPlan(user))
  const setPlan = (patch) => setPlanState(p => {
    const next = { ...p, ...(typeof patch === 'function' ? patch(p) : patch) }
    try { localStorage.setItem(PLAN_KEY, JSON.stringify({ ...next, confirmed: false })) } catch { /* unavailable */ }
    return next
  })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [chgOpen, setChgOpen] = useState(false)
  const now = useNow(true, 30_000)

  /* ── Readiness: latest prerequisites report, or run one now ── */
  const [readiness, setReadiness] = useState({ loading: true, job: null, report: null, running: false, error: null })
  const loadReadiness = useCallback(async () => {
    try {
      const list = await listReports({ kind: 'prerequisites', limit: 1 })
      const item = asArray(list.reports)[0]
      if (!item) { setReadiness(r => ({ ...r, loading: false })); return }
      const rep = await getReport(item.job_id)
      setReadiness(r => ({ ...r, loading: false, job: rep.job, report: rep.report, error: null }))
    } catch (e) {
      setReadiness(r => ({ ...r, loading: false, error: describeError(e) }))
    }
  }, [])
  useEffect(() => { loadReadiness() }, [loadReadiness])
  const runReadiness = async () => {
    setReadiness(r => ({ ...r, running: true, error: null }))
    try {
      const job = await pollJob(await prerequisites({ ad_job_id: plan.adJobId, servers: plan.servers }))
      setReadiness({ loading: false, running: false, job, report: job.result, error: job.status === 'SUCCEEDED' ? null : asArray(job.result?.errors).join(' ') || 'The prerequisite checks failed.' })
    } catch (e) {
      setReadiness(r => ({ ...r, running: false, error: describeError(e) }))
    }
  }
  const serverRows = asArray(readiness.report?.servers).filter(s => s?.Server)

  /* ── Servers from Active Directory ── */
  const [ad, setAd] = useState({ loading: true, job: null, result: null, error: null })
  // A new list becomes the source of the selection; servers it no longer contains are dropped
  const applyAdList = (job) => {
    const listed = new Set((Array.isArray(job.result?.servers) ? job.result.servers : []).filter(s => s?.Fqdn).map(s => s.Fqdn.toLowerCase()))
    setAd({ loading: false, job, result: job.result, error: null })
    setPlan(p => ({ adJobId: job.job_id, servers: p.servers.filter(s => listed.has(String(s).toLowerCase())) }))
  }
  useEffect(() => {
    latestAdServers()
      .then(l => applyAdList({ job_id: l.job_id, finished_at: l.finished_at, result: l.result }))
      .catch(e => setAd({ loading: false, job: null, result: null, error: e instanceof ApiError && e.status === 404 ? null : describeError(e) }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const searchAd = async () => {
    setAd(a => ({ ...a, loading: true, error: null }))
    try {
      const job = await pollJob(await listAdServers({
        domain: plan.adDomain || status.health?.ad_domains?.[0],
        ...(plan.adFilter.trim() && { name_filter: plan.adFilter.trim() }),
        ...(plan.adSearchBase.trim() && { search_base: plan.adSearchBase.trim() }),
      }))
      if (job.status !== 'SUCCEEDED') throw new Error(asArray(job.result?.errors).join(' ') || 'The AD search failed.')
      applyAdList(job)
    } catch (e) {
      setAd(a => ({ ...a, loading: false, error: describeError(e) }))
    }
  }
  const adAgeOk = ad.job && Date.now() - Date.parse(ad.job.finished_at) < 24 * 3600_000
  const maxServers = status.health?.max_servers_per_run || 50

  /* ── SUGs and collections ── */
  const sugs = useListJob(latestSugs, startSugs, 'Software update groups')
  const collections = useListJob(latestCollections, startCollections, 'Collections', plan.collectionMode === 'existing')
  const sugList = asArray(sugs.result?.sugs)
  const sug = sugList.find(s => String(s.id) === String(plan.sugId)) || null
  // A saved SUG that no longer exists in SCCM is cleared, never replaced by a guess
  useEffect(() => {
    if (plan.sugId && sugs.result && !sug) setPlan({ sugId: null, sugName: '' })
  }, [sugs.result]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto names until the user edits them
  useEffect(() => {
    if (!plan.sugName) return
    const base = safeText(plan.sugName)
    setPlan(p => ({
      ...(!p.nameTouched && { newCollectionName: `WinPatch - ${base} - ${new Date().toISOString().slice(0, 10)}`.slice(0, 100) }),
      ...(!p.deploymentTouched && { deploymentName: `Patch - ${base} - ${stamp()}`.slice(0, 100) }),
    }))
  }, [plan.sugName]) // eslint-disable-line react-hooks/exhaustive-deps

  const colList = asArray(collections.result?.collections)
  const selectedShort = useMemo(() => new Set(plan.servers.map(shortName)), [plan.servers])
  const colMatch = (c) => {
    if (!c?.members) return null
    const members = new Set(asArray(c.members).map(shortName))
    return members.size === selectedShort.size && [...selectedShort].every(s => members.has(s))
  }
  const collection = colList.find(c => c.id === plan.collectionId) || null

  /* ── Validation ── */
  const startMs = Date.parse(toUtcIso(plan.windowStart))
  const endMs = startMs + plan.windowHours * 3600_000
  const deadlineMs = plan.deadlineMode === 'at' ? Date.parse(toUtcIso(plan.deadline)) : NaN
  const installFrom = Math.max(startMs, Number.isNaN(deadlineMs) ? startMs : deadlineMs)
  const selectedRows = plan.servers.map(s => serverRows.find(r => shortName(r.Server) === shortName(s))).filter(Boolean)
  const notReadySelected = selectedRows.filter(r => r.Overall !== 'READY')
  const health = status.health
  const locked = status.active?.locked
  const runBusy = ['running', 'paused', 'blocked'].includes(run.phase)

  const checks = [
    { ok: status.api === 'up', label: 'SCCM API reachable', hint: status.error || 'The API did not answer.' },
    { ok: Boolean(user?.trim()), label: user ? `Requested by ${user}` : 'Your name entered', hint: 'Enter your name at the top right; it is recorded on the deployment and in the audit log.' },
    { ok: health?.deployment_enabled !== false, label: 'Deployments enabled on the server', hint: 'SCCM_ALLOW_DEPLOYMENT is false on the API.' },
    { ok: !locked, label: 'No other deployment in progress', hint: status.active?.message },
    { ok: Boolean(plan.adJobId) && adAgeOk, label: ad.job ? `Server list from AD (${ad.result?.domain || 'domain'})` : 'Servers listed from AD', hint: ad.job ? 'The AD list is older than 24 hours; search AD again.' : 'Search AD and choose the servers.' },
    { ok: plan.servers.length > 0 && plan.servers.length <= maxServers, label: `${plan.servers.length || 'No'} server${plan.servers.length === 1 ? '' : 's'} selected`, hint: plan.servers.length > maxServers ? `At most ${maxServers} servers per deployment.` : 'Select at least one server.' },
    { ok: notReadySelected.length === 0 || plan.includeNotReady, label: notReadySelected.length ? `${notReadySelected.length} selected server${notReadySelected.length === 1 ? ' is' : 's are'} NOT READY` : 'Selected servers are READY', hint: 'Deselect them, or allow NOT READY servers.' },
    { ok: Boolean(sug), label: sug ? `Update group: ${sug.name}` : 'Update group selected', hint: 'Choose a software update group.' },
    plan.collectionMode === 'new'
      ? { ok: plan.newCollectionName.trim().length >= 3 && SAFE.test(plan.newCollectionName) && !colList.some(c => c.name.toLowerCase() === plan.newCollectionName.trim().toLowerCase()), label: 'New collection name valid', hint: '3–100 characters: letters, digits, spaces and _ . - ( ). It must not exist yet.' }
      : { ok: Boolean(collection) && colMatch(collection) !== false, label: collection ? `Collection: ${collection.name}` : 'Existing collection selected', hint: collection && colMatch(collection) === false ? 'Its members differ from the selected servers.' : 'Choose a collection.' },
    { ok: plan.deploymentName.trim().length >= 3 && SAFE.test(plan.deploymentName), label: 'Deployment name valid', hint: '3–100 characters: letters, digits, spaces and _ . - ( ).' },
    { ok: !Number.isNaN(startMs) && endMs >= now + MIN_LEFT && startMs <= now + 30 * 86400_000, label: 'Maintenance window open ≥ 30 min, within 30 days', hint: 'Pick a later start or a longer window.' },
    { ok: plan.deadlineMode === 'asap' || (!Number.isNaN(deadlineMs) && deadlineMs >= now - 60_000 && deadlineMs + MIN_LEFT <= endMs), label: plan.deadlineMode === 'asap' ? 'Deadline: as soon as possible' : 'Deadline inside the window', hint: 'The deadline must be in the future and ≥ 30 min before the window ends.' },
    { ok: plan.changeTicket.trim().length >= 3, label: plan.changeTicket ? `Change ${plan.changeTicket}` : 'Change ticket', hint: CHANGE_API_ENABLED ? 'Create a change request or enter its number.' : 'Enter the approved change number.' },
    { ok: plan.approver.trim().length >= 2 && plan.approvalReference.trim().length >= 2, label: 'Approver and approval reference', hint: 'Both are recorded on the deployment.' },
    { ok: plan.confirmed, label: 'Readiness confirmed', hint: 'Tick the confirmation box.' },
  ]
  const blocking = checks.filter(c => !c.ok)
  const ready = blocking.length === 0 && !runBusy

  const config = () => ({
    adJobId: plan.adJobId, servers: plan.servers, includeNotReady: plan.includeNotReady, sugId: String(plan.sugId), sugName: plan.sugName,
    collectionMode: plan.collectionMode, newCollectionName: plan.newCollectionName, collectionId: plan.collectionId, collectionName: plan.collectionName,
    deploymentName: plan.deploymentName, windowStartUtc: toUtcIso(plan.windowStart), windowHours: Number(plan.windowHours),
    deadlineMode: plan.deadlineMode, deadlineUtc: plan.deadlineMode === 'at' ? toUtcIso(plan.deadline) : null, restartMode: plan.restartMode,
    kbs: plan.kbsText.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).map(k => (/^kb/i.test(k) ? k.toUpperCase() : `KB${k}`)),
    changeTicket: plan.changeTicket, approver: plan.approver, approvalReference: plan.approvalReference, chg: plan.chg,
  })

  return (
    <div className="wpx-deploy">
      <div className="wpx-deploy-main">
        {/* 1. Servers */}
        <Card title="Servers from Active Directory" icon="fa-sitemap" kicker="Step 1">
          <AdServerPicker
            plan={plan} setPlan={setPlan} health={status.health} now={now} ad={ad} onSearch={searchAd}
            readiness={readiness} readinessRows={serverRows} onCheck={runReadiness} onOpenReport={onOpenReport}
          />
          {notReadySelected.length > 0 && (
            <label className="wpx-toggle-line">
              <input type="checkbox" checked={plan.includeNotReady} onChange={e => setPlan({ includeNotReady: e.target.checked })} />
              <span>Deploy to NOT READY servers anyway ({notReadySelected.map(r => shortHost(r.Server)).join(', ')})</span>
            </label>
          )}
        </Card>

        {/* 2. Update group */}
        <Card
          title="Software update group" icon="fa-box-archive" kicker="Step 2"
          actions={<button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={sugs.refresh} disabled={sugs.loading}>{sugs.loading ? <Spinner /> : <i className="fa-solid fa-rotate" />} Refresh</button>}
        >
          {sugs.error && <Banner toneName="bad">{sugs.error}</Banner>}
          <Select
            inputId="wpx-sug" styles={selectStyles} isLoading={sugs.loading} placeholder="Search software update groups…"
            options={sugList.map(s => ({ value: String(s.id), label: s.name, s }))}
            value={sug ? { value: String(sug.id), label: sug.name, s: sug } : null}
            onChange={(o) => setPlan({ sugId: o?.value || null, sugName: o?.label || '' })}
            formatOptionLabel={(o, { context }) => (
              <div className="wpx-sug-opt">
                <span>{o.label}</span>
                {context === 'menu' && <small>{o.s.kb_count ?? '—'} KBs · {o.s.update_count ?? '—'} updates{o.s.deployed ? ' · deployed before' : ''}</small>}
              </div>
            )}
          />
          {sugs.at && <div className="wpx-help">List from {fmtAgo(sugs.at, now)}.</div>}
          {sug && (
            <div className="wpx-sug-card">
              <div className="wpx-sug-stats">
                <div><strong>{sug.kb_count ?? '—'}</strong><span>KBs</span></div>
                <div><strong>{sug.update_count ?? '—'}</strong><span>Updates</span></div>
                <div className={sug.expired_count ? 'warn' : ''}><strong>{sug.expired_count ?? 0}</strong><span>Expired</span></div>
                <div><strong>{sug.superseded_count ?? 0}</strong><span>Superseded</span></div>
                <div><strong>{sug.modified_utc ? fmtAgo(sug.modified_utc, now) : '—'}</strong><span>Modified</span></div>
              </div>
              {sug.description && <p className="wpx-muted">{sug.description}</p>}
              {sug.expired_count > 0 && <Banner toneName="warn">{sug.expired_count} expired update(s) in this group will not install.</Banner>}
              <div className="wpx-kb-chips">
                {asArray(sug.updates).slice(0, 24).map(u => <span key={u.ci_id || u.kb} className="wpx-kb wpx-kb-brand" title={u.title}>{u.kb}</span>)}
                {asArray(sug.updates).length > 24 && <span className="wpx-kb">+{asArray(sug.updates).length - 24}</span>}
              </div>
            </div>
          )}
        </Card>

        {/* 3. Collection */}
        <Card title="Target collection" icon="fa-layer-group" kicker="Step 3">
          <div className="wpx-seg" role="tablist">
            <button type="button" className={plan.collectionMode === 'new' ? 'active' : ''} onClick={() => setPlan({ collectionMode: 'new' })}><i className="fa-solid fa-plus" /> Create new</button>
            <button type="button" className={plan.collectionMode === 'existing' ? 'active' : ''} onClick={() => setPlan({ collectionMode: 'existing' })}><i className="fa-solid fa-list" /> Use existing</button>
          </div>
          {plan.collectionMode === 'new' ? (
            <label className="wpx-field">
              <span className="wpx-label">Collection name</span>
              <input className="wpx-input" value={plan.newCollectionName} maxLength={100} onChange={e => setPlan({ newCollectionName: e.target.value, nameTouched: true })} />
              <span className="wpx-help">Created in SCCM with exactly the {plan.servers.length} selected server{plan.servers.length === 1 ? '' : 's'}. Content goes to the configured distribution point group.</span>
            </label>
          ) : (
            <div className="wpx-field">
              <span className="wpx-label">Existing collection</span>
              <Select
                inputId="wpx-col" styles={selectStyles} isLoading={collections.loading} placeholder="Search device collections…"
                options={colList.map(c => ({ value: c.id, label: c.name, c, isDisabled: colMatch(c) === false }))}
                value={collection ? { value: collection.id, label: collection.name, c: collection } : null}
                onChange={(o) => setPlan({ collectionId: o?.value || null, collectionName: o?.label || '' })}
                formatOptionLabel={(o) => {
                  const m = colMatch(o.c)
                  return (
                    <div className="wpx-sug-opt">
                      <span>{o.label}</span>
                      <small>{o.c.member_count} members{m === true ? ' · matches selection' : m === false ? ' · members differ' : ''}</small>
                    </div>
                  )
                }}
              />
              <span className="wpx-help">The collection must contain exactly the selected servers.</span>
              {collections.error && <Banner toneName="bad">{collections.error}</Banner>}
            </div>
          )}
        </Card>

        {/* 4. Schedule */}
        <Card title="Schedule" icon="fa-calendar-days" kicker="Step 4">
          <div className="wpx-grid-3">
            <label className="wpx-field">
              <span className="wpx-label">Window start (UTC)</span>
              <input type="datetime-local" className="wpx-input" value={plan.windowStart} onChange={e => setPlan({ windowStart: e.target.value })} />
            </label>
            <label className="wpx-field">
              <span className="wpx-label">Window length · {plan.windowHours} h</span>
              <input type="range" min={1} max={24} value={plan.windowHours} className="wpx-range" onChange={e => setPlan({ windowHours: Number(e.target.value) })} />
              <span className="wpx-help">6–8 h recommended for Windows Server 2025.</span>
            </label>
            <div className="wpx-field">
              <span className="wpx-label">Restart</span>
              <div className="wpx-seg wpx-seg-sm">
                {[['Script', 'Automatic'], ['Sccm', 'SCCM client'], ['None', 'No restart']].map(([v, l]) => (
                  <button key={v} type="button" className={plan.restartMode === v ? 'active' : ''} onClick={() => setPlan({ restartMode: v })}>{l}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="wpx-grid-2">
            <div className="wpx-field">
              <span className="wpx-label">Installation deadline</span>
              <div className="wpx-seg wpx-seg-sm">
                <button type="button" className={plan.deadlineMode === 'asap' ? 'active' : ''} onClick={() => setPlan({ deadlineMode: 'asap' })}>As soon as possible</button>
                <button type="button" className={plan.deadlineMode === 'at' ? 'active' : ''} onClick={() => setPlan({ deadlineMode: 'at' })}>Specific time</button>
              </div>
            </div>
            {plan.deadlineMode === 'at' && (
              <label className="wpx-field">
                <span className="wpx-label">Deadline (UTC)</span>
                <input type="datetime-local" className="wpx-input" value={plan.deadline} onChange={e => setPlan({ deadline: e.target.value })} />
              </label>
            )}
          </div>
          <WindowBar now={now} start={startMs} end={endMs} deadline={deadlineMs} />
          <div className="wpx-sched-facts">
            <span><i className="fa-solid fa-door-open" /> Opens {fmtUtc(startMs)}</span>
            <span><i className="fa-solid fa-download" /> Installs from {fmtUtc(installFrom)}</span>
            <span><i className="fa-solid fa-door-closed" /> Closes {fmtUtc(endMs)}</span>
          </div>
        </Card>

        {/* 5. Change and approval */}
        <Card title="Change & approval" icon="fa-ticket" kicker="Step 5">
          <div className="wpx-chg-row">
            <label className="wpx-field">
              <span className="wpx-label">Change ticket</span>
              <input className="wpx-input wpx-input-mono" value={plan.changeTicket} placeholder="CHG0000000" maxLength={100} onChange={e => setPlan({ changeTicket: e.target.value, chg: null })} />
            </label>
            {CHANGE_API_ENABLED && (
              <button type="button" className="wpx-btn wpx-btn-soft wpx-chg-btn" onClick={() => setChgOpen(true)} disabled={!plan.servers.length}>
                <i className="fa-solid fa-plus" /> Create change
              </button>
            )}
          </div>
          {plan.chg && (
            <div className="wpx-chg-linked">
              <i className="fa-solid fa-link" />
              <span><strong>{plan.chg.number}</strong> · {[plan.chg.type, plan.chg.state, plan.chg.approval].filter(Boolean).join(' · ')}</span>
              <span className="wpx-muted">{plan.chg.shortDescription}</span>
            </div>
          )}
          <div className="wpx-grid-3">
            <label className="wpx-field">
              <span className="wpx-label">Approver</span>
              <input className="wpx-input" value={plan.approver} maxLength={100} onChange={e => setPlan({ approver: e.target.value })} />
            </label>
            <label className="wpx-field">
              <span className="wpx-label">Approval reference</span>
              <input className="wpx-input" value={plan.approvalReference} maxLength={200} onChange={e => setPlan({ approvalReference: e.target.value })} />
            </label>
            <label className="wpx-field">
              <span className="wpx-label">Extra KBs to validate (optional)</span>
              <input className="wpx-input wpx-input-mono" value={plan.kbsText} placeholder="KB5066835, KB890830" onChange={e => setPlan({ kbsText: e.target.value })} />
            </label>
          </div>
        </Card>
      </div>

      {/* Summary + one-click */}
      <aside className="wpx-deploy-side">
        <div className="wpx-summary">
          <div className="wpx-summary-head">
            <div className="wpx-summary-kicker"><i className="fa-solid fa-bolt" /> One-click deployment</div>
            <label className="wpx-field">
              <span className="wpx-label">Deployment name</span>
              <input className="wpx-input" value={plan.deploymentName} maxLength={100} onChange={e => setPlan({ deploymentName: e.target.value, deploymentTouched: true })} />
            </label>
          </div>
          <div className="wpx-summary-facts">
            <div><span>Servers</span><strong>{plan.servers.length}</strong></div>
            <div><span>KBs</span><strong>{sug?.kb_count ?? '—'}</strong></div>
            <div><span>Window</span><strong>{plan.windowHours} h</strong></div>
          </div>
          <ul className="wpx-summary-list">
            <li><i className="fa-solid fa-box-archive" /><span>{sug?.name || 'No update group'}</span></li>
            <li><i className="fa-solid fa-layer-group" /><span>{plan.collectionMode === 'new' ? `New: ${plan.newCollectionName || '—'}` : collection?.name || 'No collection'}</span></li>
            <li><i className="fa-solid fa-calendar" /><span>{fmtUtc(startMs)} → {fmtUtc(endMs).slice(11)}</span></li>
            <li><i className="fa-solid fa-flag-checkered" /><span>{plan.deadlineMode === 'asap' ? 'Deadline as soon as possible' : `Deadline ${fmtUtc(deadlineMs)}`}</span></li>
            <li><i className="fa-solid fa-power-off" /><span>Restart: {plan.restartMode === 'Script' ? 'automatic' : plan.restartMode === 'Sccm' ? 'by SCCM client' : 'none'}</span></li>
            <li><i className="fa-solid fa-ticket" /><span>{plan.changeTicket || 'No change ticket'}</span></li>
          </ul>

          <div className="wpx-flow">
            {['Environment', 'Readiness', 'Deploy', 'Install', 'Restart', 'Validate', 'Report'].map((s, i) => (
              <React.Fragment key={s}>{i > 0 && <i className="fa-solid fa-chevron-right" />}<span>{s}</span></React.Fragment>
            ))}
          </div>

          <ul className="wpx-gates">
            {checks.map((c, i) => (
              <li key={i} className={c.ok ? 'ok' : 'bad'} title={c.ok ? '' : c.hint}>
                <i className={`fa-solid ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}`} />
                <span>{c.label}</span>
              </li>
            ))}
          </ul>

          <label className="wpx-confirm">
            <input type="checkbox" checked={plan.confirmed} onChange={e => setPlan({ confirmed: e.target.checked })} />
            <span>DP content, client health, maintenance window and approvals are verified.</span>
          </label>

          {runBusy ? (
            <button type="button" className="wpx-btn wpx-btn-hero" onClick={onGoLive}>
              <i className="fa-solid fa-satellite-dish" /> View live deployment
            </button>
          ) : (
            <button type="button" className="wpx-btn wpx-btn-hero" disabled={!ready} onClick={() => setConfirmOpen(true)} id="btn-one-click-deploy">
              <i className="fa-solid fa-rocket" /> Deploy now
            </button>
          )}
          {!ready && !runBusy && blocking[0] && <div className="wpx-summary-hint"><i className="fa-solid fa-circle-info" /> {blocking[0].hint || blocking[0].label}</div>}
          {locked && (
            <div className="wpx-summary-hint warn"><i className="fa-solid fa-lock" /> {status.active.message}</div>
          )}
        </div>
      </aside>

      {chgOpen && (
        <ChangeTicketModal
          plan={{ sugName: plan.sugName, servers: plan.servers, windowStartUtc: toUtcIso(plan.windowStart), windowHours: plan.windowHours }}
          requester={user}
          onClose={() => setChgOpen(false)}
          onCreated={(t) => setPlan(p => ({ chg: t, changeTicket: t.number, approvalReference: p.approvalReference || (t.approval ? `${t.number} (${t.approval})` : t.number) }))}
        />
      )}

      {confirmOpen && (
        <Modal
          title="Deploy updates now?" icon="fa-rocket" toneName="brand" onClose={() => setConfirmOpen(false)}
          footer={<>
            <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => setConfirmOpen(false)} autoFocus>Cancel</button>
            <button type="button" className="wpx-btn wpx-btn-primary" id="btn-confirm-deploy" onClick={() => { setConfirmOpen(false); onStart(config()) }}>
              <i className="fa-solid fa-rocket" /> Deploy
            </button>
          </>}
        >
          <p className="wpx-modal-lead">
            This runs the environment and readiness checks, then creates a <strong>Required</strong> deployment.
            Updates install from <strong>{fmtUtc(installFrom)}</strong> inside the window and the servers restart{plan.restartMode === 'None' ? ' only if you restart them' : ''}.
          </p>
          <div className="wpx-confirm-grid">
            <div><span>Deployment</span><strong>{plan.deploymentName}</strong></div>
            <div><span>Update group</span><strong>{sug?.name}</strong></div>
            <div><span>Collection</span><strong>{plan.collectionMode === 'new' ? `${plan.newCollectionName} (new)` : collection?.name}</strong></div>
            <div><span>Change</span><strong>{plan.changeTicket}</strong></div>
            <div><span>Window</span><strong>{fmtUtc(startMs)} – {fmtUtc(endMs).slice(11)}</strong></div>
            <div><span>Servers</span><strong>{plan.servers.map(shortHost).join(', ')}</strong></div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* Visual of now → window → deadline */
function WindowBar({ now, start, end, deadline }) {
  if (Number.isNaN(start)) return null
  const from = Math.min(now, start)
  const to = Math.max(end, now + 60_000)
  const pos = (t) => `${((t - from) / (to - from)) * 100}%`
  return (
    <div className="wpx-wbar" aria-hidden="true">
      <div className="wpx-wbar-track">
        <div className="wpx-wbar-window" style={{ left: pos(start), width: `calc(${pos(end)} - ${pos(start)})` }} />
        <div className="wpx-wbar-now" style={{ left: pos(now) }}><span>Now</span></div>
        {!Number.isNaN(deadline) && <div className="wpx-wbar-deadline" style={{ left: pos(Math.min(Math.max(deadline, from), to)) }}><span>Deadline</span></div>}
      </div>
    </div>
  )
}
