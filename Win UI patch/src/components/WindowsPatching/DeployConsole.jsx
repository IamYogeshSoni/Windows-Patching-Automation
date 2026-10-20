import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Select from 'react-select'
import {
  ApiError, asArray, describeError, pollJob, toUtcIso, toUtcInput,
  listReports, getReport, prerequisites, latestSugs, listSugs, latestCollections, listCollections, listAdServers, latestAdServers,
} from '../../api/sccmApi'
import { Card, Banner, EnvTag, Modal, Spinner, StatusPill, fmtUtc, fmtAgo, shortHost, useNow } from './ui'
import { shortName } from './hooks'
import ChangeTicketModal from './ChangeTicketModal'
import AdServerPicker from './AdServerPicker'

const SAFE = /^[A-Za-z0-9 _.\-()]+$/
const PLAN_KEY = 'nova-wp-plan-v3'
const MIN_LEFT = 30 * 60_000

const safeText = (s) => String(s || '').replace(/[^A-Za-z0-9 _.\-()]/g, ' ').replace(/\s+/g, ' ').trim()
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')

function defaultPlan() {
  const start = new Date(Date.now() + 15 * 60_000)
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 5) * 5, 0, 0)
  return {
    step: 'servers', adDomain: '', adFilter: '', adSearchBase: '', adJobId: null,
    servers: [], includeNotReady: false, sugId: null, sugName: '', collectionMode: 'new', newCollectionName: '', nameTouched: false,
    collectionId: null, collectionName: '', deploymentName: '', deploymentTouched: false,
    windowStart: toUtcInput(start), windowHours: 6, deadlineMode: 'asap', deadline: toUtcInput(new Date(start.getTime() + 30 * 60_000)),
    restartMode: 'Script', changeTicket: '', chg: null, approver: '', approvalReference: '', kbsText: '', confirmed: false,
  }
}
const loadPlan = () => {
  try { return { ...defaultPlan(), ...JSON.parse(localStorage.getItem(PLAN_KEY)), confirmed: false } } catch { return defaultPlan() }
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

export default function DeployConsole({ status, run, onStart, onGoLive, onOpenReport }) {
  const [plan, setPlanState] = useState(() => loadPlan())
  const setPlan = (patch) => setPlanState(p => {
    const next = { ...p, ...(typeof patch === 'function' ? patch(p) : patch) }
    try { localStorage.setItem(PLAN_KEY, JSON.stringify({ ...next, confirmed: false })) } catch { /* unavailable */ }
    return next
  })
  const [reviewOpen, setReviewOpen] = useState(false)
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

  /* Test servers need no change request; any other server is pre-prod / production */
  const envByName = useMemo(() => {
    const m = new Map()
    for (const r of asArray(ad.result?.servers)) if (r?.Environment) m.set(shortName(r.Name || r.Fqdn), r.Environment)
    for (const r of serverRows) if (r?.Environment) m.set(shortName(r.Server), r.Environment)
    return m
  }, [ad.result, serverRows])
  // Unknown counts as pre-prod / prod, so a change request is never skipped by mistake
  const envOf = (s) => envByName.get(shortName(s)) || 'Pre-prod / Prod'
  const prodSelected = plan.servers.filter(s => envOf(s) !== 'Test')
  const changeNeeded = prodSelected.length > 0

  /* Checks per step; the review modal shows them all */
  const platform = [
    { ok: status.api === 'up', label: 'SCCM API reachable', hint: status.error || 'The API did not answer.' },
    { ok: health?.deployment_enabled !== false, label: 'Deployments enabled on the server', hint: 'SCCM_ALLOW_DEPLOYMENT is false on the API.' },
    { ok: !locked, label: 'No other deployment in progress', hint: status.active?.message },
  ]
  const gates = {
    servers: [
      { ok: Boolean(plan.adJobId) && adAgeOk, label: ad.job ? `Server list from AD (${ad.result?.domain || 'domain'})` : 'Servers listed from AD', hint: ad.job ? 'The AD list is older than 24 hours; search AD again.' : 'Search AD and choose the servers.' },
      { ok: plan.servers.length > 0 && plan.servers.length <= maxServers, label: `${plan.servers.length || 'No'} server${plan.servers.length === 1 ? '' : 's'} selected`, hint: plan.servers.length > maxServers ? `At most ${maxServers} servers per deployment.` : 'Select at least one server.' },
      { ok: notReadySelected.length === 0 || plan.includeNotReady, label: notReadySelected.length ? `${notReadySelected.length} selected server${notReadySelected.length === 1 ? ' is' : 's are'} NOT READY` : 'Selected servers are READY or not checked yet', hint: 'Deselect them, or allow NOT READY servers.' },
    ],
    updates: [
      { ok: Boolean(sug), label: sug ? `Update group: ${sug.name}` : 'Update group selected', hint: 'Choose a software update group.' },
    ],
    target: [
      plan.collectionMode === 'new'
        ? { ok: plan.newCollectionName.trim().length >= 3 && SAFE.test(plan.newCollectionName) && !colList.some(c => c.name.toLowerCase() === plan.newCollectionName.trim().toLowerCase()), label: 'New collection name valid', hint: 'Collection name: 3–100 characters (letters, digits, spaces and _ . - ( )); it must not exist yet.' }
        : { ok: Boolean(collection) && colMatch(collection) !== false, label: collection ? `Collection: ${collection.name}` : 'Existing collection selected', hint: collection && colMatch(collection) === false ? 'Its members differ from the selected servers.' : 'Choose a collection.' },
      { ok: plan.deploymentName.trim().length >= 3 && SAFE.test(plan.deploymentName), label: 'Deployment name valid', hint: 'Deployment name: 3–100 characters (letters, digits, spaces and _ . - ( )).' },
      { ok: !Number.isNaN(startMs) && endMs >= now + MIN_LEFT && startMs <= now + 30 * 86400_000, label: 'Maintenance window open ≥ 30 min, within 30 days', hint: 'Pick a later start or a longer window.' },
      { ok: plan.deadlineMode === 'asap' || (!Number.isNaN(deadlineMs) && deadlineMs >= now - 60_000 && deadlineMs + MIN_LEFT <= endMs), label: plan.deadlineMode === 'asap' ? 'Deadline: as soon as possible' : 'Deadline inside the window', hint: 'The deadline must be in the future and ≥ 30 min before the window ends.' },
    ],
    change: [
      { ok: !changeNeeded || plan.changeTicket.trim().length >= 3, label: plan.changeTicket.trim() ? `Change ${plan.changeTicket.trim()}` : changeNeeded ? 'Change request for pre-prod / prod servers' : 'No change request needed (test servers)', hint: 'Raise a change request or enter its number.' },
      { ok: plan.approver.trim().length >= 2 && plan.approvalReference.trim().length >= 2, label: 'Approver and approval reference', hint: 'Enter the approver and the approval reference; both are recorded on the deployment.' },
    ],
  }
  const allChecks = [...platform, ...gates.servers, ...gates.updates, ...gates.target, ...gates.change]
  const ready = allChecks.every(c => c.ok) && !runBusy

  const config = () => ({
    adJobId: plan.adJobId, servers: plan.servers, includeNotReady: plan.includeNotReady, sugId: String(plan.sugId), sugName: plan.sugName,
    collectionMode: plan.collectionMode, newCollectionName: plan.newCollectionName, collectionId: plan.collectionId, collectionName: plan.collectionName,
    deploymentName: plan.deploymentName, windowStartUtc: toUtcIso(plan.windowStart), windowHours: Number(plan.windowHours),
    deadlineMode: plan.deadlineMode, deadlineUtc: plan.deadlineMode === 'at' ? toUtcIso(plan.deadline) : null, restartMode: plan.restartMode,
    kbs: plan.kbsText.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).map(k => (/^kb/i.test(k) ? k.toUpperCase() : `KB${k}`)),
    changeTicket: plan.changeTicket, approver: plan.approver, approvalReference: plan.approvalReference, chg: plan.chg,
  })

  const STEPS = [
    { key: 'servers', label: 'Servers', icon: 'fa-sitemap', summary: plan.servers.length ? `${plan.servers.length} selected${prodSelected.length ? ` · ${prodSelected.length} prod` : ''}` : 'From Active Directory' },
    { key: 'updates', label: 'Update group', icon: 'fa-box-archive', summary: sug ? sug.name : 'Choose a SUG' },
    { key: 'target', label: 'Collection & schedule', icon: 'fa-calendar-days', summary: Number.isNaN(startMs) ? 'Window' : `${fmtUtc(startMs).slice(5, 16)} UTC · ${plan.windowHours} h` },
    { key: 'change', label: 'Change & approval', icon: 'fa-ticket', summary: plan.changeTicket.trim() || (changeNeeded ? 'Change required' : 'Test servers') },
  ]
  const stepIdx = Math.max(0, STEPS.findIndex(s => s.key === plan.step))
  const step = STEPS[stepIdx]
  const stepBlock = gates[step.key].find(c => !c.ok)
  const goTo = (key) => { setReviewOpen(false); setPlan({ step: key }) }
  const restartLabel = plan.restartMode === 'Script' ? 'Automatic restart' : plan.restartMode === 'Sccm' ? 'Restart by the SCCM client' : 'No restart'

  return (
    <div className="wpx-wizard">
      {runBusy && (
        <Banner toneName="live" icon="fa-satellite-dish" title="Your deployment is running" actions={<button type="button" className="wpx-btn wpx-btn-primary wpx-btn-sm" onClick={onGoLive}><i className="fa-solid fa-eye" /> View live</button>}>
          You can prepare the next deployment; it can start when this one has finished.
        </Banner>
      )}

      {/* Step bar */}
      <nav className="wpx-steps" aria-label="Deployment steps">
        {STEPS.map((s, i) => {
          const ok = gates[s.key].every(c => c.ok)
          return (
            <button key={s.key} type="button" className={`wpx-stepbtn ${i === stepIdx ? 'active' : ''} ${ok ? 'ok' : ''}`} onClick={() => setPlan({ step: s.key })} aria-current={i === stepIdx ? 'step' : undefined} id={`wpx-step-${s.key}`}>
              <span className="wpx-stepbtn-num">{ok && i !== stepIdx ? <i className="fa-solid fa-check" /> : i + 1}</span>
              <span className="wpx-stepbtn-text"><strong>{s.label}</strong><small title={s.summary}>{s.summary}</small></span>
            </button>
          )
        })}
      </nav>

      <div className="wpx-wizard-body">
        {step.key === 'servers' && (
          <Card title="Servers from Active Directory" icon="fa-sitemap">
            <AdServerPicker
              plan={plan} setPlan={setPlan} health={health} now={now} ad={ad} onSearch={searchAd}
              readiness={readiness} readinessRows={serverRows} onCheck={runReadiness} onOpenReport={onOpenReport}
            />
            {notReadySelected.length > 0 && (
              <label className="wpx-toggle-line">
                <input type="checkbox" checked={plan.includeNotReady} onChange={e => setPlan({ includeNotReady: e.target.checked })} />
                <span>Deploy to NOT READY servers anyway ({notReadySelected.map(r => shortHost(r.Server)).join(', ')})</span>
              </label>
            )}
          </Card>
        )}

        {step.key === 'updates' && (
          <Card
            title="Software update group" icon="fa-box-archive"
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
        )}

        {step.key === 'target' && (
          <Card title="Collection & schedule" icon="fa-calendar-days">
            <div className="wpx-form-section">
              <div className="wpx-form-section-head">
                <h4><i className="fa-solid fa-layer-group" /> Target collection</h4>
                <div className="wpx-seg wpx-seg-sm" role="tablist">
                  <button type="button" className={plan.collectionMode === 'new' ? 'active' : ''} onClick={() => setPlan({ collectionMode: 'new' })}><i className="fa-solid fa-plus" /> Create new</button>
                  <button type="button" className={plan.collectionMode === 'existing' ? 'active' : ''} onClick={() => setPlan({ collectionMode: 'existing' })}><i className="fa-solid fa-list" /> Use existing</button>
                </div>
              </div>
              <div className="wpx-grid-2">
                {plan.collectionMode === 'new' ? (
                  <label className="wpx-field">
                    <span className="wpx-label">Collection name</span>
                    <input className="wpx-input" value={plan.newCollectionName} maxLength={100} onChange={e => setPlan({ newCollectionName: e.target.value, nameTouched: true })} />
                    <span className="wpx-help">Created in SCCM with exactly the {plan.servers.length} selected server{plan.servers.length === 1 ? '' : 's'}.</span>
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
                    <span className="wpx-help">Must contain exactly the selected servers.</span>
                    {collections.error && <Banner toneName="bad">{collections.error}</Banner>}
                  </div>
                )}
                <label className="wpx-field">
                  <span className="wpx-label">Deployment name</span>
                  <input className="wpx-input" value={plan.deploymentName} maxLength={100} onChange={e => setPlan({ deploymentName: e.target.value, deploymentTouched: true })} id="wpx-deployment-name" />
                  <span className="wpx-help">Shown in SCCM Monitoring → Deployments.</span>
                </label>
              </div>
            </div>

            <div className="wpx-form-section">
              <div className="wpx-form-section-head"><h4><i className="fa-solid fa-calendar-check" /> Maintenance window</h4></div>
              <div className="wpx-sched-grid">
                <label className="wpx-field">
                  <span className="wpx-label">Window start (UTC)</span>
                  <input type="datetime-local" className="wpx-input" value={plan.windowStart} onChange={e => setPlan({ windowStart: e.target.value })} />
                </label>
                <label className="wpx-field">
                  <span className="wpx-label">Length · {plan.windowHours} h</span>
                  <input type="range" min={1} max={24} value={plan.windowHours} className="wpx-range" onChange={e => setPlan({ windowHours: Number(e.target.value) })} />
                </label>
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
                <div className="wpx-field">
                  <span className="wpx-label">Restart</span>
                  <div className="wpx-seg wpx-seg-sm">
                    {[['Script', 'Automatic'], ['Sccm', 'SCCM client'], ['None', 'No restart']].map(([v, l]) => (
                      <button key={v} type="button" className={plan.restartMode === v ? 'active' : ''} onClick={() => setPlan({ restartMode: v })}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
              <WindowBar now={now} start={startMs} end={endMs} deadline={deadlineMs} />
              <div className="wpx-sched-facts">
                <span><i className="fa-solid fa-door-open" /> Opens {fmtUtc(startMs)}</span>
                <span><i className="fa-solid fa-download" /> Installs from {fmtUtc(installFrom)}</span>
                <span><i className="fa-solid fa-door-closed" /> Closes {fmtUtc(endMs)}</span>
              </div>
            </div>
          </Card>
        )}

        {step.key === 'change' && (
          <Card title="Change & approval" icon="fa-ticket">
            {changeNeeded ? (
              <Banner toneName="warn" icon="fa-shield-halved" title={`Change request required: ${prodSelected.length} pre-prod / production server${prodSelected.length === 1 ? '' : 's'}`}>
                {prodSelected.map(shortHost).join(', ')}. Enter the approved change number, or raise a change request here.
              </Banner>
            ) : (
              <Banner toneName="good" icon="fa-flask" title="Test servers only">No change request is needed for these servers. You can still record one.</Banner>
            )}
            <div className="wpx-chg-row">
              <label className="wpx-field">
                <span className="wpx-label">Change request{changeNeeded ? '' : ' (optional)'}</span>
                <input className="wpx-input wpx-input-mono" value={plan.changeTicket}  maxLength={100} onChange={e => setPlan({ changeTicket: e.target.value, chg: null })} id="wpx-change" />
              </label>
              <button type="button" className="wpx-btn wpx-btn-soft wpx-chg-btn" onClick={() => setChgOpen(true)} disabled={!plan.servers.length} id="btn-raise-change">
                <i className="fa-solid fa-plus" /> Raise change request
              </button>
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
                <input className="wpx-input" value={plan.approver} maxLength={100} onChange={e => setPlan({ approver: e.target.value })} id="wpx-approver" />
              </label>
              <label className="wpx-field">
                <span className="wpx-label">Approval reference</span>
                <input className="wpx-input" value={plan.approvalReference} maxLength={200} onChange={e => setPlan({ approvalReference: e.target.value })} id="wpx-approval-ref" />
              </label>
              <label className="wpx-field">
                <span className="wpx-label">Extra KBs to validate (optional)</span>
                <input className="wpx-input wpx-input-mono" value={plan.kbsText} placeholder="Comma separated" onChange={e => setPlan({ kbsText: e.target.value })} />
              </label>
            </div>
          </Card>
        )}
      </div>

      {/* Step navigation */}
      <div className="wpx-wizard-foot">
        <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => setPlan({ step: STEPS[stepIdx - 1].key })} disabled={stepIdx === 0}>
          <i className="fa-solid fa-arrow-left" /> Back
        </button>
        <div className={`wpx-wizard-hint ${stepBlock ? '' : 'ok'}`}>
          {stepBlock ? <><i className="fa-solid fa-circle-info" /> {stepBlock.hint || stepBlock.label}</> : <><i className="fa-solid fa-circle-check" /> {step.label} complete</>}
        </div>
        {stepIdx < STEPS.length - 1 ? (
          <button type="button" className="wpx-btn wpx-btn-primary" onClick={() => setPlan({ step: STEPS[stepIdx + 1].key })} id="btn-next-step">
            Next: {STEPS[stepIdx + 1].label} <i className="fa-solid fa-arrow-right" />
          </button>
        ) : (
          <button type="button" className="wpx-btn wpx-btn-hero wpx-btn-review" onClick={() => { setPlan({ confirmed: false }); setReviewOpen(true) }} id="btn-review" disabled={runBusy}>
            <i className="fa-solid fa-rocket" /> Review &amp; deploy
          </button>
        )}
      </div>

      {chgOpen && (
        <ChangeTicketModal
          plan={{ sugName: plan.sugName, servers: plan.servers, windowStartUtc: toUtcIso(plan.windowStart), windowHours: plan.windowHours }}
          onClose={() => setChgOpen(false)}
          onCreated={(t) => setPlan({ chg: t, changeTicket: t.number })}
        />
      )}

      {/* One-click deployment: review everything, confirm, deploy */}
      {reviewOpen && (
        <Modal
          title="Review and deploy" icon="fa-rocket" toneName="brand" wide onClose={() => setReviewOpen(false)}
          footer={<>
            <button type="button" className="wpx-btn wpx-btn-ghost" onClick={() => setReviewOpen(false)}>Cancel</button>
            <button type="button" className="wpx-btn wpx-btn-primary" id="btn-confirm-deploy" disabled={!ready || !plan.confirmed} onClick={() => { setReviewOpen(false); onStart(config()) }}>
              <i className="fa-solid fa-rocket" /> Deploy now
            </button>
          </>}
        >
          <div className="wpx-review">
            <div className="wpx-review-grid">
              <section className="wpx-review-sec wpx-review-wide">
                <header><h4><i className="fa-solid fa-server" /> Servers ({plan.servers.length})</h4><button type="button" className="wpx-link" onClick={() => goTo('servers')}>Edit</button></header>
                <div className="wpx-review-servers">
                  {plan.servers.length ? plan.servers.map(s => {
                    const r = serverRows.find(x => shortName(x.Server) === shortName(s))
                    return (
                      <span key={s} className="wpx-review-srv" title={s}>
                        <i className="fa-brands fa-windows" /><strong>{shortHost(s)}</strong>
                        <EnvTag env={envOf(s)} />
                        {r && <StatusPill status={r.Overall} size="sm" />}
                      </span>
                    )
                  }) : <span className="wpx-muted">None selected</span>}
                </div>
              </section>
              <section className="wpx-review-sec">
                <header><h4><i className="fa-solid fa-box-archive" /> Update group</h4><button type="button" className="wpx-link" onClick={() => goTo('updates')}>Edit</button></header>
                <strong>{sug?.name || '—'}</strong>
                {sug && <small>{sug.kb_count ?? '—'} KBs · {sug.update_count ?? '—'} updates</small>}
              </section>
              <section className="wpx-review-sec">
                <header><h4><i className="fa-solid fa-layer-group" /> Collection &amp; deployment</h4><button type="button" className="wpx-link" onClick={() => goTo('target')}>Edit</button></header>
                <strong>{plan.collectionMode === 'new' ? `${plan.newCollectionName || '—'} (new)` : collection?.name || '—'}</strong>
                <small>{plan.deploymentName || '—'}</small>
              </section>
              <section className="wpx-review-sec">
                <header><h4><i className="fa-solid fa-calendar-check" /> Schedule</h4><button type="button" className="wpx-link" onClick={() => goTo('target')}>Edit</button></header>
                <strong>{fmtUtc(startMs)} – {Number.isNaN(endMs) ? '—' : fmtUtc(endMs).slice(11)}</strong>
                <small>Installs from {fmtUtc(installFrom)} · {restartLabel}</small>
              </section>
              <section className="wpx-review-sec">
                <header><h4><i className="fa-solid fa-ticket" /> Change &amp; approval</h4><button type="button" className="wpx-link" onClick={() => goTo('change')}>Edit</button></header>
                <strong>{plan.changeTicket.trim() || (changeNeeded ? 'Missing' : 'Not required (test servers)')}</strong>
                <small>Approver {plan.approver || '—'} · {plan.approvalReference || '—'}</small>
              </section>
            </div>

            <div className="wpx-flow">
              {['Environment', 'Readiness', 'Collection', 'Content', 'Window', 'Deploy', 'Install', 'Restart', 'Validate', 'Report'].map((s, i) => (
                <React.Fragment key={s}>{i > 0 && <i className="fa-solid fa-chevron-right" />}<span>{s}</span></React.Fragment>
              ))}
            </div>

            <ul className="wpx-gates wpx-gates-2col">
              {allChecks.map((c, i) => (
                <li key={i} className={c.ok ? 'ok' : 'bad'} title={c.ok ? '' : c.hint}>
                  <i className={`fa-solid ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}`} />
                  <span>{c.ok ? c.label : c.hint || c.label}</span>
                </li>
              ))}
            </ul>

            {locked && <Banner toneName="warn" icon="fa-lock">{status.active.message}</Banner>}
            <label className="wpx-confirm wpx-review-confirm">
              <input type="checkbox" checked={plan.confirmed} onChange={e => setPlan({ confirmed: e.target.checked })} id="wpx-confirm-box" />
              <span>I checked DP content, client health, the maintenance window and the approvals. Deploy <strong>{plan.deploymentName || 'this deployment'}</strong> as a Required deployment to {plan.servers.length} server{plan.servers.length === 1 ? '' : 's'}.</span>
            </label>
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
