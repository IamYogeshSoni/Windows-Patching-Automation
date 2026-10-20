import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  asArray, describeError, pollJob, listReports, getReport, getReportHtml, getJobLog, listJumphostReports, importJumphostReport,
} from '../../api/sccmApi'
import ReportView from './ReportViews'
import EvidenceButton from './EvidenceButton'
import { Banner, Empty, Modal, Spinner, StatusPill, downloadText, fmtAgo, fmtUtc, useNow } from './ui'

const TYPES = [
  { key: '', label: 'All', icon: 'fa-layer-group' },
  { key: 'deployment', label: 'Deployments', icon: 'fa-rocket' },
  { key: 'prerequisites', label: 'Readiness', icon: 'fa-list-check' },
  { key: 'environment', label: 'Environment', icon: 'fa-network-wired' },
]
const TYPE_ICON = { deployment: 'fa-rocket', prerequisites: 'fa-list-check', environment: 'fa-network-wired' }

export default function ReportsCenter({ selectedId, onSelect, refreshKey }) {
  const now = useNow(true, 60_000)
  const [type, setType] = useState('')
  const [query, setQuery] = useState('')
  const [list, setList] = useState({ loading: true, items: [], error: null })
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(async () => {
    setList(l => ({ ...l, loading: true }))
    try {
      const r = await listReports({ limit: 200 })
      setList({ loading: false, items: asArray(r.reports), error: null })
    } catch (e) {
      setList({ loading: false, items: [], error: describeError(e) })
    }
  }, [])
  useEffect(() => { load() }, [load, refreshKey])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.items.filter(i => (!type || i.report_type === type) &&
      (!q || [i.deployment_name, i.headline, i.requested_by, i.job_id, i.report_folder_name].some(v => String(v || '').toLowerCase().includes(q))))
  }, [list.items, type, query])

  useEffect(() => {
    if (!selectedId && items.length) onSelect(items[0].job_id)
  }, [items, selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const deps = list.items.filter(i => i.report_type === 'deployment')
    return {
      total: list.items.length,
      deployments: deps.length,
      succeeded: deps.filter(i => i.status === 'SUCCEEDED').length,
      issues: deps.filter(i => i.status !== 'SUCCEEDED').length,
    }
  }, [list.items])

  return (
    <div className="wpx-reports">
      <aside className="wpx-reports-list">
        <div className="wpx-reports-head">
          <div className="wpx-reports-stats">
            <div><strong>{stats.total}</strong><span>Reports</span></div>
            <div><strong>{stats.deployments}</strong><span>Deployments</span></div>
            <div className="good"><strong>{stats.succeeded}</strong><span>Succeeded</span></div>
            <div className={stats.issues ? 'bad' : ''}><strong>{stats.issues}</strong><span>Issues</span></div>
          </div>
          <label className="wpx-search">
            <i className="fa-solid fa-magnifying-glass" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, user, job…" aria-label="Search reports" />
          </label>
          <div className="wpx-filter-chips">
            {TYPES.map(t => (
              <button key={t.key} type="button" className={type === t.key ? 'active' : ''} onClick={() => setType(t.key)}>
                <i className={`fa-solid ${t.icon}`} /> {t.label}
              </button>
            ))}
          </div>
          <div className="wpx-row-gap">
            <button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={load} disabled={list.loading}>{list.loading ? <Spinner /> : <i className="fa-solid fa-rotate" />} Refresh</button>
            <button type="button" className="wpx-btn wpx-btn-soft wpx-btn-sm" onClick={() => setImportOpen(true)}><i className="fa-solid fa-cloud-arrow-down" /> Import from jumphost</button>
          </div>
        </div>
        {list.error && <Banner toneName="bad">{list.error}</Banner>}
        <div className="wpx-report-items">
          {!list.loading && !items.length && <Empty icon="fa-file-circle-question" title="No reports">Reports appear here after checks and deployments finish.</Empty>}
          {items.map(i => (
            <button key={i.job_id} type="button" className={`wpx-report-item ${selectedId === i.job_id ? 'active' : ''}`} onClick={() => onSelect(i.job_id)}>
              <span className={`wpx-report-item-icon wpx-ri-${i.report_type}`}><i className={`fa-solid ${TYPE_ICON[i.report_type] || 'fa-file'}`} /></span>
              <span className="wpx-report-item-body">
                <strong>{i.deployment_name || (i.report_type === 'prerequisites' ? 'Readiness checks' : i.report_type === 'environment' ? 'Environment check' : i.job_id)}</strong>
                <small>{i.headline}</small>
                <small className="wpx-muted">{fmtAgo(i.finished_at || i.created_at, now)}{i.requested_by ? ` · ${i.requested_by}` : ''}{i.kind === 'report_import' ? ' · imported' : ''}</small>
              </span>
              <StatusPill status={i.status} size="sm" icon={false} />
            </button>
          ))}
        </div>
      </aside>

      <section className="wpx-reports-view">
        {selectedId ? <ReportViewer key={selectedId} jobId={selectedId} /> : <Empty icon="fa-file-lines" title="Select a report">Choose a report from the list.</Empty>}
      </section>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImported={(id) => { setImportOpen(false); load(); onSelect(id) }} />}
    </div>
  )
}

function ReportViewer({ jobId }) {
  const [state, setState] = useState({ loading: true, data: null, logs: [], error: null })
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const data = await getReport(jobId)
        let logs = []
        if (['deployment', 'deployment_resume'].includes(data.job?.kind)) {
          try { logs = asArray((await getJobLog(jobId)).log) } catch { /* the report still renders without the log */ }
        }
        if (alive) setState({ loading: false, data, logs, error: null })
      } catch (e) {
        if (alive) setState({ loading: false, data: null, logs: [], error: describeError(e) })
      }
    })()
    return () => { alive = false }
  }, [jobId])

  const downloadHtml = async () => {
    setDownloading(true)
    try {
      const html = await getReadyHtml(jobId)
      downloadText(`${state.data?.report_type || 'report'}-${jobId}.html`, html, 'text/html')
    } catch (e) {
      setState(s => ({ ...s, error: describeError(e) }))
    } finally {
      setDownloading(false)
    }
  }
  const openPrintable = async () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write('<p style="font-family:sans-serif;padding:24px">Loading report…</p>')
    try {
      const html = await getReadyHtml(jobId)
      w.document.open(); w.document.write(html); w.document.close()
      setTimeout(() => w.print(), 400)
    } catch (e) {
      w.document.body.textContent = describeError(e)
    }
  }

  if (state.loading) return <div className="wpx-center wpx-pad-lg"><Spinner label="Loading report…" /></div>
  if (state.error && !state.data) return <Banner toneName="bad">{state.error}</Banner>
  const { job, report } = state.data
  return (
    <div className="wpx-viewer">
      <div className="wpx-viewer-bar">
        <div className="wpx-viewer-meta">
          <span><i className="fa-solid fa-hashtag" /> {job.job_id}</span>
          <span><i className="fa-regular fa-calendar" /> {fmtUtc(job.finished_at || job.created_at)}</span>
          {report?.report_folder_name && <span><i className="fa-regular fa-folder-open" /> {report.report_folder_name}</span>}
        </div>
        <div className="wpx-row-gap">
          {state.data?.report_type === 'deployment' && <EvidenceButton jobId={jobId} small />}
          <button type="button" className="wpx-btn wpx-btn-ghost wpx-btn-sm" onClick={openPrintable}><i className="fa-solid fa-print" /> Print / PDF</button>
          <button type="button" className="wpx-btn wpx-btn-soft wpx-btn-sm" onClick={downloadHtml} disabled={downloading}>{downloading ? <Spinner /> : <i className="fa-solid fa-download" />} Download HTML</button>
        </div>
      </div>
      {state.error && <Banner toneName="bad">{state.error}</Banner>}
      <ReportView job={job} report={report} logs={state.logs} />
    </div>
  )
}

const getReadyHtml = (jobId) => getReportHtml(jobId)

function ImportModal({ onClose, onImported }) {
  const [state, setState] = useState({ loading: true, reports: [], error: null, importing: null })
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const job = await pollJob(await listJumphostReports(100))
        if (job.status !== 'SUCCEEDED') throw new Error(asArray(job.result?.errors).join(' ') || 'The jumphost reports could not be listed.')
        if (alive) setState({ loading: false, reports: asArray(job.result?.reports), error: null, importing: null })
      } catch (e) {
        if (alive) setState(s => ({ ...s, loading: false, error: describeError(e) }))
      }
    })()
    return () => { alive = false }
  }, [])
  const doImport = async (folder) => {
    setState(s => ({ ...s, importing: folder, error: null }))
    try {
      const job = await pollJob(await importJumphostReport(folder))
      if (job.status !== 'SUCCEEDED') throw new Error(asArray(job.result?.errors).join(' ') || 'Import failed.')
      onImported(job.job_id)
    } catch (e) {
      setState(s => ({ ...s, importing: null, error: describeError(e) }))
    }
  }
  return (
    <Modal title="Import reports from the jumphost" icon="fa-cloud-arrow-down" onClose={onClose} wide>
      <p className="wpx-modal-lead">Report folders on the SCCM jumphost, including runs made with Run-Patching.ps1. Importing adds one to the report library.</p>
      {state.error && <Banner toneName="bad">{state.error}</Banner>}
      {state.loading ? <div className="wpx-center wpx-pad-lg"><Spinner label="Reading the jumphost Reports folder…" /></div> : (
        <div className="wpx-import-list">
          {!state.reports.length && <Empty icon="fa-folder-open" title="No report folders found" />}
          {state.reports.map(r => (
            <div key={r.report_folder} className="wpx-import-item">
              <span className={`wpx-report-item-icon wpx-ri-${r.type}`}><i className={`fa-solid ${TYPE_ICON[r.type] || 'fa-folder'}`} /></span>
              <div className="wpx-import-body">
                <strong>{r.deployment_name || (r.type === 'prerequisites' ? 'Readiness checks' : r.report_folder)}</strong>
                <small>{r.report_folder} · {fmtUtc(r.created_utc)}</small>
                <small className="wpx-muted">
                  {r.type === 'deployment' ? `${r.sug || ''} · ${r.patched ?? '—'}/${r.servers ?? '—'} patched` : r.type === 'prerequisites' ? `${r.ready ?? '—'}/${r.servers ?? '—'} ready` : 'Other files'}
                  {r.error ? ` · ${r.error}` : ''}
                </small>
              </div>
              <button type="button" className="wpx-btn wpx-btn-soft wpx-btn-sm" disabled={r.type === 'other' || Boolean(state.importing)} onClick={() => doImport(r.report_folder)}>
                {state.importing === r.report_folder ? <Spinner /> : <i className="fa-solid fa-file-import" />} Import
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
