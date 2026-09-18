// api.js — SupportAssist API client
//
// Talks to the PHP/PostgreSQL backend described in the endpoint reference.
// If your backend runs somewhere other than localhost:8080, change API_BASE_URL.
//
// NOTE ON CORS: if you serve this frontend from a different origin/port than
// the PHP server (e.g. VS Code Live Server on :5500 vs `php -S localhost:8080`),
// the backend must send Access-Control-Allow-Origin (and handle OPTIONS
// preflight) or every request below will fail in the browser console with a
// CORS error, not a 401/404. Easiest fix for local dev: serve these HTML files
// with `php -S localhost:8080 -t public` too, or add CORS headers server-side.

const API_BASE_URL = 'http://192.168.18.10:8080/api';

const TOKEN_KEY = 'sa_accessToken';
const REFRESH_KEY = 'sa_refreshToken';
const USER_KEY = 'sa_user';

// ---------- session/storage helpers ----------

export function getAccessToken() {
    return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken() {
    return localStorage.getItem(REFRESH_KEY);
}

export function getCurrentUser() {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
}

export function isLoggedIn() {
    return !!getAccessToken() && !!getCurrentUser();
}

function setSession(data) {
    localStorage.setItem(TOKEN_KEY, data.accessToken);
    localStorage.setItem(REFRESH_KEY, data.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}

export function updateStoredUser(patch) {
    const user = getCurrentUser();
    if (!user) return;
    localStorage.setItem(USER_KEY, JSON.stringify({ ...user, ...patch }));
}

export function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
}

// ---------- error type ----------

export class ApiError extends Error {
    constructor(message, status, errors) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.errors = errors || null; // field -> message, from 422 validation responses
    }
}

// ---------- core request ----------

async function request(path, { method = 'GET', body, isForm = false, auth = true, _retry = true } = {}) {
    const headers = {};
    if (!isForm) headers['Content-Type'] = 'application/json';
    if (auth) {
        const token = getAccessToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    let res;
    try {
        res = await fetch(`${API_BASE_URL}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
        });
    } catch (networkErr) {
        throw new ApiError('Could not reach the server. Is the backend running at ' + API_BASE_URL + '?', 0);
    }

    // Access token expired mid-session: try one silent refresh, then retry.
    if (res.status === 401 && auth && _retry && getRefreshToken()) {
        const refreshed = await tryRefresh();
        if (refreshed) {
            return request(path, { method, body, isForm, auth, _retry: false });
        }
        logout();
        if (!location.pathname.endsWith('login.html')) {
            window.location.href = 'login.html';
        }
        throw new ApiError('Session expired. Please sign in again.', 401);
    }

    let payload = null;
    try {
        payload = await res.json();
    } catch {
        // non-JSON response (e.g. a 500 HTML error page)
    }

    if (!res.ok || !payload || payload.success === false) {
        const message = (payload && payload.message) || `Request failed (${res.status})`;
        throw new ApiError(message, res.status, payload ? payload.errors : null);
    }

    return payload.data;
}

async function tryRefresh() {
    try {
        const res = await fetch(`${API_BASE_URL}/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: getRefreshToken() }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload || !payload.success) return false;
        localStorage.setItem(TOKEN_KEY, payload.data.accessToken);
        localStorage.setItem(REFRESH_KEY, payload.data.refreshToken);
        return true;
    } catch {
        return false;
    }
}

// ---------- 1. Authentication ----------

export async function signup({ name, email, phone, password }) {
    const data = await request('/signup', { method: 'POST', auth: false, body: { name, email, phone, password } });
    setSession(data);
    return data.user;
}

export async function login(email, password) {
    const data = await request('/login', { method: 'POST', auth: false, body: { email, password } });
    setSession(data);
    return data.user;
}

// ---------- 2. Profile ----------

export const getProfile = () => request('/profile');
export const updateProfile = (fields) => request('/profile', { method: 'PATCH', body: fields });

// ---------- 3. Categories ----------

export const getCategories = () => request('/categories');

// ---------- 4. Tickets ----------

export function getTickets(params = {}) {
    const cleaned = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const qs = new URLSearchParams(cleaned).toString();
    return request(`/tickets${qs ? `?${qs}` : ''}`);
}

export const getRecentTickets = (limit = 4) => request(`/tickets/recent?limit=${limit}`);
export const getTicket = (id) => request(`/tickets/${id}`);

export function createTicket(fields, file) {
    if (file) {
        const form = new FormData();
        Object.entries(fields).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') form.append(k, v);
        });
        form.append('attachment', file);
        return request('/tickets', { method: 'POST', body: form, isForm: true });
    }
    return request('/tickets', { method: 'POST', body: fields });
}

export const updateTicketStatus = (id, status, note) =>
    request(`/tickets/${id}/status`, { method: 'PATCH', body: note !== undefined ? { status, note } : { status } });

export const assignTicket = (id, technicianId) =>
    request(`/tickets/${id}/assign`, { method: 'POST', body: { technicianId } });

export const acceptTicket = (id) => request(`/tickets/${id}/accept`, { method: 'POST' });

export const reviewTicket = (id, rating, comment) =>
    request(`/tickets/${id}/review`, { method: 'POST', body: comment !== undefined ? { rating, comment } : { rating } });

// ---------- 5. Alerts ----------

export const getAlerts = (page = 1, perPage = 20) => request(`/alerts?page=${page}&per_page=${perPage}`);
export const markAlertRead = (id) => request(`/alerts/${id}/read`, { method: 'PATCH' });

// Long-poll: the request just stays open server-side for up to `timeoutSeconds`
// and returns the moment something changes (or with an empty list once it times
// out). See the backend's RUNNING.md for why this is a long-poll and not a
// WebSocket — same reasoning and the same endpoint the Android app uses.
export const pollAlerts = (since, timeoutSeconds = 25) =>
    request(`/alerts/poll?since=${encodeURIComponent(since)}&timeout=${timeoutSeconds}`);

// ---------- 6. Admin ----------

export const getUsers = (type) => request(`/admin/users${type ? `?type=${type}` : ''}`);
export const createTechnician = (fields) => request('/admin/technicians', { method: 'POST', body: fields });
export const deleteTechnician = (id) => request(`/admin/technicians/${id}`, { method: 'DELETE' });
export const createAdminAlert = (fields) => request('/admin/alerts', { method: 'POST', body: fields });
export const getDashboard = () => request('/admin/dashboard');

// ---------- small shared UI helpers ----------

export function statusSlug(status) {
    return String(status || '').toLowerCase().replace('_', '-'); // OPEN -> open, IN_PROGRESS -> in-progress
}

export function prioritySlug(priority) {
    return String(priority || '').toLowerCase(); // HIGH -> high
}

export function timeAgo(isoString) {
    if (!isoString) return '';
    const then = new Date(isoString).getTime();
    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    const units = [
        ['year', 31536000], ['month', 2592000], ['day', 86400],
        ['hour', 3600], ['minute', 60],
    ];
    for (const [name, secs] of units) {
        const val = Math.floor(diffSec / secs);
        if (val >= 1) return `${val} ${name}${val > 1 ? 's' : ''} ago`;
    }
    return 'just now';
}

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
