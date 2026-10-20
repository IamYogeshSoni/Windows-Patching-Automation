/* ══════════════════════════════════════════════════════════════════
   Change management: raises the change request (CHG) for a patch window
   through the SCCM Patching API (POST /api/change-requests), which
   forwards it to the change system.
══════════════════════════════════════════════════════════════════ */
import { createChangeRequest } from './sccmApi'

/* form: the change form fields; resolves to the created ticket ({ number, state, approval, ... }) */
export async function createChangeTicket(form, { signal } = {}) {
  const ticket = await createChangeRequest({
    short_description: form.shortDescription,
    description: form.description,
    justification: form.justification,
    backout_plan: form.backout,
    change_type: form.type,
    category: form.category,
    risk: form.risk,
    impact: form.impact,
    assignment_group: form.assignmentGroup,
    planned_start_utc: form.plannedStart || null,
    planned_end_utc: form.plannedEnd || null,
    servers: form.configurationItems || [],
  }, { signal })
  return {
    ...form,
    number: ticket.number,
    state: ticket.state,
    approval: ticket.approval,
    created_at: ticket.created_at,
  }
}

export const CHANGE_DEFAULTS = {
  category: 'Software',
  type: 'Normal',
  risk: 'Low',
  impact: '3 - Low',
  assignmentGroup: '',
}
