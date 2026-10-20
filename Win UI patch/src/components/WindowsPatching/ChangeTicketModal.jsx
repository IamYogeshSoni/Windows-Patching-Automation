import React, { useState } from 'react'
import { createChangeTicket, CHANGE_DEFAULTS } from '../../api/changeApi'
import { Modal, Banner, Spinner, fmtUtc } from './ui'

/* Raise a change request (CHG) for the patch window, prefilled from the plan. */
export default function ChangeTicketModal({ plan, onClose, onCreated }) {
  const [form, setForm] = useState(() => ({
    shortDescription: `Windows Server patching – ${plan.sugName || 'monthly updates'} – ${plan.servers.length} server${plan.servers.length === 1 ? '' : 's'}`,
    description:
      `Deploy software update group "${plan.sugName || '—'}" through SCCM as a Required deployment.\n` +
      `Servers: ${plan.servers.join(', ') || '—'}\n` +
      `Maintenance window: ${fmtUtc(plan.windowStartUtc)} for ${plan.windowHours} h.\n` +
      'Updates are installed and validated per KB; servers restart inside the window.',
    justification: '',
    backout: '',
    category: CHANGE_DEFAULTS.category,
    type: CHANGE_DEFAULTS.type,
    risk: CHANGE_DEFAULTS.risk,
    impact: CHANGE_DEFAULTS.impact,
    assignmentGroup: CHANGE_DEFAULTS.assignmentGroup,
  }))
  const [state, setState] = useState({ phase: 'form', ticket: null, error: null })
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const end = plan.windowStartUtc ? new Date(Date.parse(plan.windowStartUtc) + plan.windowHours * 3600_000).toISOString() : null

  const submit = async () => {
    setState({ phase: 'creating', ticket: null, error: null })
    try {
      const ticket = await createChangeTicket({
        ...form,
        plannedStart: plan.windowStartUtc,
        plannedEnd: end,
        configurationItems: plan.servers,
      })
      setState({ phase: 'created', ticket, error: null })
    } catch (e) {
      setState({ phase: 'form', ticket: null, error: e.message || 'The change request could not be created.' })
    }
  }

  const footer = state.phase === 'created' ? (
    <>
      <button type="button" className="wpx-btn wpx-btn-ghost" onClick={onClose}>Close</button>
      <button type="button" className="wpx-btn wpx-btn-primary" onClick={() => { onCreated(state.ticket); onClose() }}>
        <i className="fa-solid fa-check" /> Use {state.ticket.number}
      </button>
    </>
  ) : (
    <>
      <button type="button" className="wpx-btn wpx-btn-ghost" onClick={onClose} disabled={state.phase === 'creating'}>Cancel</button>
      <button type="button" className="wpx-btn wpx-btn-primary" onClick={submit} disabled={state.phase === 'creating' || form.shortDescription.trim().length < 5}>
        {state.phase === 'creating' ? <Spinner label="Creating change…" /> : <><i className="fa-solid fa-ticket" /> Create change request</>}
      </button>
    </>
  )

  return (
    <Modal title="New change request" icon="fa-ticket" onClose={onClose} footer={footer} wide>
      {state.phase === 'created' ? (
        <div className="wpx-chg-done">
          <div className="wpx-chg-badge"><i className="fa-solid fa-circle-check" /></div>
          <div className="wpx-chg-number">{state.ticket.number}</div>
          <div className="wpx-chg-sub">{[`${state.ticket.type} change`, state.ticket.state, state.ticket.approval].filter(Boolean).join(' · ')}</div>
          {state.ticket.url && <a className="wpx-link" href={state.ticket.url} target="_blank" rel="noreferrer"><i className="fa-solid fa-arrow-up-right-from-square" /> Open in the change system</a>}
          <dl className="wpx-kv">
            <div className="wpx-kv-row"><dt>Short description</dt><dd>{state.ticket.shortDescription}</dd></div>
            <div className="wpx-kv-row"><dt>Planned</dt><dd>{fmtUtc(state.ticket.plannedStart)} → {fmtUtc(state.ticket.plannedEnd)}</dd></div>
            <div className="wpx-kv-row"><dt>Assignment group</dt><dd>{state.ticket.assignmentGroup}</dd></div>
            <div className="wpx-kv-row"><dt>Configuration items</dt><dd>{state.ticket.configurationItems.join(', ')}</dd></div>
          </dl>
          <Banner toneName="good" icon="fa-link">The change number is attached to this deployment and recorded in its report and audit log.</Banner>
        </div>
      ) : (
        <div className="wpx-form">
          {state.error && <Banner toneName="bad">{state.error}</Banner>}
          <div className="wpx-chg-plan">
            <span><i className="fa-solid fa-box-archive" /> {plan.sugName || 'No update group selected'}</span>
            <span><i className="fa-solid fa-server" /> {plan.servers.length} servers</span>
            <span><i className="fa-solid fa-calendar" /> {fmtUtc(plan.windowStartUtc)} · {plan.windowHours} h</span>
          </div>
          <label className="wpx-field wpx-span-2">
            <span className="wpx-label">Short description</span>
            <input className="wpx-input" value={form.shortDescription} onChange={set('shortDescription')} maxLength={160} />
          </label>
          <div className="wpx-grid-4">
            <label className="wpx-field"><span className="wpx-label">Type</span>
              <select className="wpx-input" value={form.type} onChange={set('type')}>{['Standard', 'Normal', 'Emergency'].map(o => <option key={o}>{o}</option>)}</select>
            </label>
            <label className="wpx-field"><span className="wpx-label">Category</span>
              <select className="wpx-input" value={form.category} onChange={set('category')}>{['Software', 'Hardware', 'Network', 'Security'].map(o => <option key={o}>{o}</option>)}</select>
            </label>
            <label className="wpx-field"><span className="wpx-label">Risk</span>
              <select className="wpx-input" value={form.risk} onChange={set('risk')}>{['Low', 'Moderate', 'High'].map(o => <option key={o}>{o}</option>)}</select>
            </label>
            <label className="wpx-field"><span className="wpx-label">Impact</span>
              <select className="wpx-input" value={form.impact} onChange={set('impact')}>{['3 - Low', '2 - Medium', '1 - High'].map(o => <option key={o}>{o}</option>)}</select>
            </label>
          </div>
          <label className="wpx-field"><span className="wpx-label">Assignment group</span>
            <input className="wpx-input" value={form.assignmentGroup} onChange={set('assignmentGroup')} />
          </label>
          <label className="wpx-field"><span className="wpx-label">Description</span>
            <textarea className="wpx-input" rows={4} value={form.description} onChange={set('description')} />
          </label>
          <div className="wpx-grid-2">
            <label className="wpx-field"><span className="wpx-label">Justification</span>
              <textarea className="wpx-input" rows={3} value={form.justification} onChange={set('justification')} />
            </label>
            <label className="wpx-field"><span className="wpx-label">Backout plan</span>
              <textarea className="wpx-input" rows={3} value={form.backout} onChange={set('backout')} />
            </label>
          </div>
        </div>
      )}
    </Modal>
  )
}
