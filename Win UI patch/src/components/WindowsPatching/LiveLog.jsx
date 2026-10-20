import React, { useEffect, useMemo, useRef, useState } from 'react'
import { downloadText, fmtTime } from './ui'

const lineTone = (text) => {
  if (/^\s*ERROR\b/i.test(text)) return 'err'
  if (/^\s*WARNING\b/i.test(text)) return 'warn'
  if (/^=+$/.test(text.trim())) return 'rule'
  if (/^\d+\.\s+[A-Z]/.test(text.trim())) return 'step'
  if (/\b(PATCHED|INSTALLED|Succeeded|SUCCEEDED|is back online|contains|holds exactly)\b/.test(text)) return 'ok'
  if (/\b(INSTALLING|PENDING|Waiting|Restarting)\b/.test(text)) return 'live'
  if (/^Job /.test(text)) return 'meta'
  return ''
}

/* Terminal-style live log. lines: [{ seq, time, line, stage? }] */
export default function LiveLog({ lines, title = 'Live log', live = false, filename = 'deployment-log.txt', height = 420, stageLabels }) {
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const boxRef = useRef(null)

  const counts = useMemo(() => ({
    warn: lines.filter(l => lineTone(l.line) === 'warn').length,
    err: lines.filter(l => lineTone(l.line) === 'err').length,
  }), [lines])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter(l => {
      const t = lineTone(l.line)
      if (filter === 'warn' && t !== 'warn' && t !== 'err') return false
      if (filter === 'steps' && t !== 'step') return false
      return !q || String(l.line).toLowerCase().includes(q)
    })
  }, [lines, filter, query])

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [shown, follow])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  return (
    <div className="wpx-term">
      <div className="wpx-term-bar">
        <div className="wpx-term-dots" aria-hidden="true"><span /><span /><span /></div>
        <div className="wpx-term-title">
          {live && <span className="wpx-live-dot" />}
          {title}
          <span className="wpx-term-count">{lines.length} lines</span>
        </div>
        <div className="wpx-term-tools">
          <div className="wpx-seg wpx-seg-dark" role="tablist" aria-label="Log filter">
            {[['all', 'All'], ['steps', 'Steps'], ['warn', `Issues${counts.warn + counts.err ? ` · ${counts.warn + counts.err}` : ''}`]].map(([k, label]) => (
              <button key={k} type="button" className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          <label className="wpx-term-search">
            <i className="fa-solid fa-magnifying-glass" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search log" aria-label="Search log" />
          </label>
          <button type="button" className="wpx-term-btn" title="Download log"
            onClick={() => downloadText(filename, lines.map(l => `${l.time || ''}  ${l.line}`).join('\n'))}>
            <i className="fa-solid fa-download" />
          </button>
        </div>
      </div>
      <div className="wpx-term-body" ref={boxRef} onScroll={onScroll} style={{ height }}>
        {shown.length === 0 && <div className="wpx-term-empty">{lines.length ? 'No lines match.' : 'Waiting for output from the jumphost…'}</div>}
        {shown.map((l, i) => {
          const prev = shown[i - 1]
          const newStage = stageLabels && l.stage && l.stage !== prev?.stage
          return (
            <React.Fragment key={`${l.stage || ''}-${l.seq}-${i}`}>
              {newStage && <div className="wpx-term-stage">── {stageLabels[l.stage] || l.stage} ──</div>}
              <div className={`wpx-term-line ${lineTone(l.line)}`}>
                <span className="wpx-term-time">{fmtTime(l.time)}</span>
                <span className="wpx-term-text">{l.line || ' '}</span>
              </div>
            </React.Fragment>
          )
        })}
        {live && <div className="wpx-term-cursor"><span /></div>}
      </div>
      {!follow && (
        <button type="button" className="wpx-term-follow" onClick={() => setFollow(true)}>
          <i className="fa-solid fa-arrow-down" /> Follow live
        </button>
      )}
    </div>
  )
}
