// ticket-modal.js — one shared "ticket details" popup, reused by admin.html,
// technician.html and user.html so all three stay visually/behaviourally
// consistent. Each page supplies its own `renderFooter` (assign UI / accept
// button / resolve button / nothing) since that's the only part that differs
// per role.

import { getTicket, statusSlug, prioritySlug, escapeHtml, timeAgo } from './api.js';

let root = null;

function statusLabel(s) {
    return String(s || '').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function priorityLabel(p) {
    return String(p || '').replace(/\b\w/g, c => c.toUpperCase());
}
function fmt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function injectStyles() {
    if (document.getElementById('tm-styles')) return;
    const style = document.createElement('style');
    style.id = 'tm-styles';
    style.textContent = `
        .tm-backdrop { position: fixed; inset: 0; background: rgba(3,6,14,0.7); display: flex;
            align-items: center; justify-content: center; z-index: 1000; opacity: 0; pointer-events: none;
            transition: opacity 0.15s; padding: 20px; }
        .tm-backdrop.open { opacity: 1; pointer-events: auto; }
        .tm-modal { background: var(--bg-card, #151e30); border: 1px solid var(--border-color, #26334d);
            border-radius: 14px; width: 560px; max-width: 100%; max-height: 85vh; overflow-y: auto;
            box-shadow: 0 20px 50px rgba(0,0,0,0.6); position: relative; }
        .tm-close { position: absolute; top: 14px; right: 14px; background: transparent; border: none;
            color: var(--text-muted, #8b9bb5); font-size: 22px; cursor: pointer; line-height: 1; }
        .tm-close:hover { color: #fff; }
        .tm-body { padding: 28px; color: var(--text-main, #fff); }
        .tm-title { font-size: 18px; font-weight: 600; margin-bottom: 4px; padding-right: 24px; }
        .tm-id { color: var(--text-muted, #8b9bb5); font-size: 12px; margin-bottom: 16px; }
        .tm-badges { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
        .tm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; margin-bottom: 18px; font-size: 13px; }
        .tm-grid .full { grid-column: 1 / -1; }
        .tm-label { color: var(--text-muted, #8b9bb5); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 3px; }
        .tm-value { color: #ddd; }
        .tm-desc { background: var(--bg-input, #1c273f); border-radius: 8px; padding: 14px; font-size: 13px;
            color: #ddd; line-height: 1.5; margin-bottom: 18px; white-space: pre-wrap; }
        .tm-attachment img { max-width: 100%; border-radius: 8px; margin-bottom: 18px; border: 1px solid var(--border-color, #26334d); }
        .tm-history { border-top: 1px solid var(--border-color, #26334d); padding-top: 14px; margin-bottom: 6px; }
        .tm-history h4 { font-size: 12px; color: var(--text-muted, #8b9bb5); text-transform: uppercase; margin-bottom: 10px; }
        .tm-history-row { font-size: 12px; color: #ccc; padding: 6px 0; border-bottom: 1px dashed var(--border-color, #26334d); }
        .tm-history-row:last-child { border-bottom: none; }
        .tm-footer { border-top: 1px solid var(--border-color, #26334d); padding: 18px 28px; display: flex;
            gap: 10px; align-items: center; flex-wrap: wrap; }
        .tm-error { color: var(--accent-red, #ef4444); font-size: 13px; }
        .tm-select { flex: 1; min-width: 160px; padding: 10px; background: var(--bg-input, #1c273f);
            border: 1px solid var(--border-color, #26334d); border-radius: 8px; color: #fff; font-size: 13px; }
        .tm-note { flex: 1 1 100%; padding: 10px; background: var(--bg-input, #1c273f); border: 1px solid var(--border-color, #26334d);
            border-radius: 8px; color: #fff; font-size: 13px; resize: vertical; min-height: 44px; font-family: inherit; }
        .tm-msg { font-size: 12px; margin-top: 8px; flex-basis: 100%; }
        .tm-msg.ok { color: var(--accent-green, #10b981); }
        .tm-msg.err { color: var(--accent-red, #ef4444); }
        .tm-stars { display: flex; gap: 4px; font-size: 20px; cursor: pointer; }
        .tm-stars span { color: #3a4460; }
        .tm-stars span.active { color: #f59e0b; }
    `;
    document.head.appendChild(style);
}

function ensureRoot() {
    if (root) return root;
    injectStyles();
    root = document.createElement('div');
    root.className = 'tm-backdrop';
    root.innerHTML = `
        <div class="tm-modal">
            <button class="tm-close" aria-label="Close">&times;</button>
            <div class="tm-body"><p>Loading...</p></div>
            <div class="tm-footer"></div>
        </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) closeTicketModal(); });
    root.querySelector('.tm-close').addEventListener('click', closeTicketModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTicketModal(); });
    return root;
}

export function closeTicketModal() {
    if (root) root.classList.remove('open');
}

function renderBody(t) {
    const historyRows = (t.statusHistory || []).map(h => `
        <div class="tm-history-row">
            <strong>${escapeHtml(h.oldStatus ? statusLabel(h.oldStatus) + ' → ' : '')}${escapeHtml(statusLabel(h.newStatus))}</strong>
            — ${escapeHtml(h.changedBy || 'system')} · ${fmt(h.changedAt)}
            ${h.note ? `<br><span style="color:var(--text-muted,#8b9bb5)">${escapeHtml(h.note)}</span>` : ''}
        </div>
    `).join('');

    return `
        <div class="tm-title">${escapeHtml(t.subject)}</div>
        <div class="tm-id">#${escapeHtml(t.id)} · created ${escapeHtml(t.timeAgo || fmt(t.createdAt))}</div>
        <div class="tm-badges">
            <span class="status-badge ${statusSlug(t.status)}">${statusLabel(t.status)}</span>
            <span class="priority-badge ${prioritySlug(t.priority)}">${priorityLabel(t.priority)} priority</span>
            ${t.isOverdue ? '<span class="status-badge open" style="background:rgba(239,68,68,0.2); color:#ef4444;">Overdue</span>' : ''}
        </div>

        ${t.attachmentUrl ? `<div class="tm-attachment"><img src="${escapeHtml(t.attachmentUrl)}" alt="Ticket attachment"></div>` : ''}

        <div class="tm-desc">${escapeHtml(t.description)}</div>

        <div class="tm-grid">
            <div><div class="tm-label">Reporter</div><div class="tm-value">${escapeHtml(t.reporter?.name ?? '—')}</div></div>
            <div><div class="tm-label">Technician</div><div class="tm-value">${escapeHtml(t.assignedTechnician?.name ?? 'Unassigned')}</div></div>
            <div><div class="tm-label">Category</div><div class="tm-value">${escapeHtml(t.category?.name ?? '—')}</div></div>
            <div><div class="tm-label">Department</div><div class="tm-value">${escapeHtml(t.department ?? '—')}</div></div>
            <div><div class="tm-label">Room</div><div class="tm-value">${escapeHtml(t.room ?? '—')}</div></div>
            <div><div class="tm-label">Device Type</div><div class="tm-value">${escapeHtml(t.deviceType ?? '—')}</div></div>
            <div><div class="tm-label">Due</div><div class="tm-value">${fmt(t.dueAt)}</div></div>
            <div><div class="tm-label">Resolved</div><div class="tm-value">${fmt(t.resolvedAt)}</div></div>
        </div>

        ${historyRows ? `<div class="tm-history"><h4>History</h4>${historyRows}</div>` : ''}
    `;
}

/**
 * Open the modal for a given ticket id.
 * @param {string} ticketId
 * @param {(footerEl: HTMLElement, ticket: object, reopen: () => void) => void} [renderFooter]
 *   Called after the ticket loads, so the caller can put role-specific action
 *   buttons in the footer. `reopen()` re-fetches and re-renders in place
 *   (call it after an action succeeds, e.g. after assigning a technician).
 */
export async function openTicketModal(ticketId, renderFooter) {
    const el = ensureRoot();
    el.classList.add('open');
    const body = el.querySelector('.tm-body');
    const footer = el.querySelector('.tm-footer');
    body.innerHTML = '<p>Loading ticket...</p>';
    footer.innerHTML = '';

    try {
        const ticket = await getTicket(ticketId);
        body.innerHTML = renderBody(ticket);
        if (renderFooter) {
            renderFooter(footer, ticket, () => openTicketModal(ticketId, renderFooter));
        }
    } catch (err) {
        body.innerHTML = `<p class="tm-error">${escapeHtml(err.message)}</p>`;
    }
}
