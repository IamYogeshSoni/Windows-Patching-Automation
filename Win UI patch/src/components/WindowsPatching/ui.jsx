import React, { useEffect, useState } from 'react'
import { asArray } from '../../api/sccmApi'

/* ─── Formatting ─── */
export const parseTime = (value) => {
  if (typeof value === 'number') return value
  if (!value) return NaN
  let text = String(value).trim().replace(/\.(\d{3})\d*(Z|[+-]\d\d:\d\d)?$/, '.$1$2')
  // Every time the API and the scripts send is UTC: an ISO time without a zone is UTC, not browser-local
  if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(text)) text = `${text.replace(' ', 'T')}Z`
  return Date.parse(text)
}
export const fmtUtc = (value, { seconds = false } = {}) => {
  const t = parseTime(value)
  if (Number.isNaN(t)) return value ? String(value) : '—'
  return `${new Date(t).toISOString().slice(0, seconds ? 19 : 16).replace('T', ' ')} UTC`
}
export const fmtTime = (value) => {
  const t = parseTime(value)
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(11, 19)
}
export const fmtDuration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}
export const fmtAgo = (value, now = Date.now()) => {
  const t = parseTime(value)
  if (Number.isNaN(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
export const shortHost = (fqdn) => String(fqdn || '').split('.')[0].toUpperCase()

export function useNow(active = true, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return undefined
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
  return now
}

/* ─── Status vocabulary (jobs, checks, verdicts) ─── */
const GOOD = ['SUCCEEDED', 'PASS', 'READY', 'ELIGIBLE', 'PATCHED', 'INSTALLED', 'AVAILABLE', 'SUCCEEDED', 'OK', 'COMPLIANT', 'ALREADY_COMPLIANT', 'IDLE']
const WARN = ['WARN', 'WARNING', 'COMPLETED_WITH_ISSUES', 'PENDING_RESTART', 'INSTALLED_PENDING_RESTART', 'NOT VERIFIED', 'UNVERIFIED', 'REQUEST TIMEOUT', 'NOT_FOUND', 'UNKNOWN', 'NOT_REQUIRED']
const BAD = ['FAIL', 'FAILED', 'NOT READY', 'NOT ELIGIBLE', 'NOT_PATCHED', 'MISSING', 'OUTCOME_UNKNOWN', 'ERROR']
const LIVE = ['RUNNING', 'INSTALLING', 'QUEUED', 'PENDING']
export function tone(status) {
  const s = String(status ?? '').trim().toUpperCase()
  if (!s) return 'neutral'
  if (GOOD.includes(s) || s.startsWith('OK')) return 'good'
  if (BAD.includes(s) || s.startsWith('FAILED')) return 'bad'
  if (WARN.includes(s)) return 'warn'
  if (LIVE.includes(s)) return 'live'
  return 'neutral'
}
const LABELS = {
  SUCCEEDED: 'Succeeded', COMPLETED_WITH_ISSUES: 'Completed with issues', FAILED: 'Failed', OUTCOME_UNKNOWN: 'Interrupted',
  RUNNING: 'Running', QUEUED: 'Queued', NOT_PATCHED: 'Not patched', PENDING_RESTART: 'Pending restart', INSTALLED_PENDING_RESTART: 'Pending restart',
  PATCHED: 'Patched', UNVERIFIED: 'Unverified', ALREADY_COMPLIANT: 'Already compliant', NOT_REQUIRED: 'Not required', NOT_FOUND: 'Not found',
}
const ICONS = { good: 'fa-circle-check', bad: 'fa-circle-xmark', warn: 'fa-triangle-exclamation', live: 'fa-circle-notch fa-spin', neutral: 'fa-circle-info' }

export function StatusPill({ status, label, size = 'md', icon = true }) {
  if (status == null || status === '') return null
  const text = typeof status === 'boolean' ? (status ? 'Yes' : 'No') : String(status)
  const t = typeof status === 'boolean' ? (status ? 'good' : 'neutral') : tone(text)
  return (
    <span className={`wpx-pill wpx-pill-${t} wpx-pill-${size}`}>
      {icon && <i className={`fa-solid ${ICONS[t]}`} />}
      {label || LABELS[text.toUpperCase()] || text}
    </span>
  )
}

/* ─── Donut / ring ─── */
export function Ring({ value, total, size = 120, stroke = 12, label, sub, toneName }) {
  const pct = total > 0 ? Math.min(1, value / total) : 0
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const t = toneName || (total === 0 ? 'neutral' : pct === 1 ? 'good' : pct >= 0.5 ? 'warn' : 'bad')
  return (
    <div className={`wpx-ring wpx-ring-${t}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="wpx-ring-track" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} className="wpx-ring-value" strokeWidth={stroke}
          strokeDasharray={`${c * pct} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="wpx-ring-text">
        <strong>{label ?? `${Math.round(pct * 100)}%`}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  )
}

/* Segmented bar: [{ value, tone, label }] */
export function StackBar({ parts }) {
  const total = parts.reduce((n, p) => n + (p.value || 0), 0)
  return (
    <div className="wpx-stackbar" role="img" aria-label={parts.map(p => `${p.label}: ${p.value}`).join(', ')}>
      {total === 0 ? <span className="wpx-stack-empty" /> : parts.filter(p => p.value).map((p, i) => (
        <span key={i} className={`wpx-stack-${p.tone}`} style={{ flexGrow: p.value }} title={`${p.label}: ${p.value}`} />
      ))}
    </div>
  )
}

export function Kpi({ icon, label, value, sub, toneName = 'brand' }) {
  return (
    <div className={`wpx-kpi wpx-kpi-${toneName}`}>
      <div className="wpx-kpi-icon"><i className={`fa-solid ${icon}`} /></div>
      <div className="wpx-kpi-body">
        <div className="wpx-kpi-value">{value}</div>
        <div className="wpx-kpi-label">{label}</div>
        {sub && <div className="wpx-kpi-sub">{sub}</div>}
      </div>
    </div>
  )
}

export function Banner({ toneName = 'info', icon, title, children, actions }) {
  const defaultIcon = { info: 'fa-circle-info', good: 'fa-circle-check', warn: 'fa-triangle-exclamation', bad: 'fa-circle-xmark', live: 'fa-satellite-dish' }[toneName]
  return (
    <div className={`wpx-banner wpx-banner-${toneName}`} role={toneName === 'bad' ? 'alert' : 'status'}>
      <i className={`fa-solid ${icon || defaultIcon} wpx-banner-icon`} />
      <div className="wpx-banner-body">
        {title && <div className="wpx-banner-title">{title}</div>}
        {children && <div className="wpx-banner-text">{children}</div>}
      </div>
      {actions && <div className="wpx-banner-actions">{actions}</div>}
    </div>
  )
}

export function Card({ title, icon, kicker, actions, children, className = '', pad = true, id }) {
  return (
    <section className={`wpx-card ${className}`} id={id}>
      {(title || actions) && (
        <header className="wpx-card-head">
          <div className="wpx-card-title">
            {icon && <span className="wpx-card-icon"><i className={`fa-solid ${icon}`} /></span>}
            <div>
              {kicker && <div className="wpx-card-kicker">{kicker}</div>}
              <h3>{title}</h3>
            </div>
          </div>
          {actions && <div className="wpx-card-actions">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'wpx-card-body' : ''}>{children}</div>
    </section>
  )
}

export function Empty({ icon = 'fa-inbox', title, children, action }) {
  return (
    <div className="wpx-empty">
      <div className="wpx-empty-icon"><i className={`fa-solid ${icon}`} /></div>
      <div className="wpx-empty-title">{title}</div>
      {children && <div className="wpx-empty-text">{children}</div>}
      {action}
    </div>
  )
}

export function Spinner({ label }) {
  return <span className="wpx-spinner-wrap"><span className="wpx-spinner" />{label && <span>{label}</span>}</span>
}

export function ErrorBanner({ errors, title = 'Something went wrong', actions }) {
  const list = asArray(errors).filter(Boolean)
  if (!list.length) return null
  return (
    <Banner toneName="bad" title={title} actions={actions}>
      {list.length === 1 ? list[0] : <ul className="wpx-list">{list.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    </Banner>
  )
}

export function Modal({ title, icon, onClose, children, footer, wide = false, toneName = 'brand' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="wpx-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className={`wpx-modal ${wide ? 'wpx-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <header className={`wpx-modal-head wpx-modal-${toneName}`}>
          {icon && <span className="wpx-modal-icon"><i className={`fa-solid ${icon}`} /></span>}
          <h3>{title}</h3>
          <button type="button" className="wpx-icon-btn" onClick={onClose} aria-label="Close"><i className="fa-solid fa-xmark" /></button>
        </header>
        <div className="wpx-modal-body">{children}</div>
        {footer && <footer className="wpx-modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
