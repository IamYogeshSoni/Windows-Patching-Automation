const BASE_URL_8330 = 'http://c11ddpdra5402.dslab.ad.adp.com:8330/api';
const BASE_URL_8340 = 'http://c11ddpdra5402.dslab.ad.adp.com:8340/api';

const extractErrorMessage = (payload, status) => {
    const msg = payload?.detail || payload?.message || payload?.error || payload?.errors?.[0];
    if (msg && typeof msg === 'string' && msg.trim()) return msg.trim();
    const codeMap = {
        400: 'Invalid request. Please check your input and try again.',
        401: 'You are not authorised. Please log in and try again.',
        403: 'Access denied. You do not have permission for this action.',
        404: 'The requested resource was not found on the server.',
        409: 'A conflict occurred. The session or resource may already exist.',
        422: 'The data sent was invalid. Please verify your file or inputs.',
        429: 'Too many requests. Please wait a moment and try again.',
        500: 'An internal server error occurred. Please try again later.',
        502: 'Server is temporarily unreachable. Please try again shortly.',
        503: 'Service is currently unavailable. Please try again later.',
    };
    return codeMap[status] || `An unexpected error occurred (status ${status}). Please try again.`;
};

/* ─── Session Listing ─── */

export const fetchReadySessions = async () => {
    try {
        const res = await fetch(`${BASE_URL_8340}/sessions`);
        const payload = await res.json();
        if (res.ok && Array.isArray(payload?.sessions)) {
            return payload.sessions.map(s => ({
                session_id: s.session_id,
                short_code: s.session_id.substring(0, 8).toUpperCase(),
                created_at: s.latest_check || new Date().toISOString(),
                precheck_file: 'baseline.csv',
                postcheck_file: 'analysis.csv'
            }));
        }
    } catch (err) {
        console.warn('Failed to fetch from port 8340 sessions, falling back to port 8330:', err);
    }
    const res = await fetch(`${BASE_URL_8330}/sessions/ready`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload?.sessions ?? [];
};

export const fetchPendingSessions = async () => {
    const res = await fetch(`${BASE_URL_8330}/sessions/pending`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload?.sessions ?? [];
};

/* ─── Upload / Submit ─── */

export const uploadPrecheck = async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE_URL_8330}/upload/precheck`, { method: 'POST', body: form });
    const ct = res.headers.get('content-type') ?? '';
    const payload = ct.includes('application/json') ? await res.json() : null;
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload ?? {};
};

export const uploadPostcheck = async (sessionCode) => {
    const form = new FormData();
    form.append('session_code', sessionCode);
    const res = await fetch(`${BASE_URL_8330}/upload/v1/postcheck`, { method: 'POST', body: form });
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload;
};

export const deleteLatestSession = async () => {
    const res = await fetch(`${BASE_URL_8330}/session/latest`, { method: 'DELETE' });
    const ct = res.headers.get('content-type') ?? '';
    const payload = ct.includes('application/json') ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return true;
};

/* ─── Comparison / Reports ─── */

export const fetchCompareSummary = async (sessionId) => {
    const res = await fetch(`${BASE_URL_8340}/compare/services/${encodeURIComponent(sessionId)}/summary`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload;
};

export const fetchHostReport = async (sessionId, onlyDiff = false, page = 1, pageSize = 20) => {
    const od = onlyDiff ? 'true' : 'false';
    const res = await fetch(`${BASE_URL_8340}/compare/services/${encodeURIComponent(sessionId)}/report?only_diff=${od}&page=${page}&page_size=${pageSize}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload;
};

export const fetchHostDrill = async (sessionId, hostname, page = 1, pageSize = 20) => {
    const res = await fetch(`${BASE_URL_8340}/compare/services/${encodeURIComponent(sessionId)}/host/${encodeURIComponent(hostname)}?page=${page}&page_size=${pageSize}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload;
};

export const fetchComparePorts = async (sessionId, page = 1, pageSize = 20) => {
    const res = await fetch(`${BASE_URL_8340}/compare/ports/${encodeURIComponent(sessionId)}?page=${page}&page_size=${pageSize}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload;
};

export const fetchFailedHosts = async (sessionId) => {
    const res = await fetch(`${BASE_URL_8330}/session/${encodeURIComponent(sessionId)}/failed-hosts`);
    const payload = await res.json();
    if (!res.ok) throw new Error(extractErrorMessage(payload, res.status));
    return payload;
};
