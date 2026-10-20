/* ══════════════════════════════════════════════════════════════════
   Change management: raises the change request (CHG) for a patch window.

   Config (.env.local):
     VITE_CHANGE_API_URL   POST endpoint that creates a change request
     VITE_CHANGE_API_KEY   optional, sent as X-API-Key

   The endpoint receives the form as JSON and must answer with the new
   change number as "number" (or result.number / change_number).
   Without VITE_CHANGE_API_URL the UI hides "Create change" and the
   change number is entered by hand.
══════════════════════════════════════════════════════════════════ */

const env = import.meta.env
const CHANGE_API_URL = env.VITE_CHANGE_API_URL ?? ''
const CHANGE_API_KEY = env.VITE_CHANGE_API_KEY ?? ''
export const CHANGE_API_ENABLED = Boolean(CHANGE_API_URL)

export async function createChangeTicket(payload, { signal } = {}) {
  if (!CHANGE_API_ENABLED) throw new Error('Change request creation is not configured (VITE_CHANGE_API_URL).')
  const res = await fetch(CHANGE_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(CHANGE_API_KEY && { 'X-API-Key': CHANGE_API_KEY }),
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { message: text } }
  if (!res.ok) {
    const d = data?.detail ?? data?.error ?? data?.message
    throw new Error(`Change request not created: ${typeof d === 'string' ? d : res.statusText || `HTTP ${res.status}`}`)
  }
  const r = data?.result && typeof data.result === 'object' ? data.result : data
  const number = r.number ?? r.change_number ?? r.changeNumber
  if (!number) throw new Error('The change system answered without a change number.')
  return {
    ...payload,
    number: String(number),
    state: r.state ?? '',
    approval: r.approval ?? '',
    created_at: r.created_at ?? r.sys_created_on ?? new Date().toISOString(),
    url: r.url ?? r.link ?? null,
  }
}

export const CHANGE_DEFAULTS = {
  category: 'Software',
  type: 'Standard',
  risk: 'Low',
  impact: '3 - Low',
  assignmentGroup: 'Windows Server Operations',
}
