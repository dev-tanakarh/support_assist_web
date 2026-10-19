// ticket-modal.js — one shared "ticket details" popup, reused by admin.html,
// technician.html and user.html so all three stay visually/behaviourally
// consistent. Each page supplies its own `renderFooter` (assign UI / accept
// button / resolve button / nothing) since that's the only part that differs
// per role.


import {
    getTicket,
    getTicketMessages,
    postTicketMessage,
    getCurrentUser,
    getAccessToken,
    statusSlug,
    prioritySlug,
    escapeHtml,
    timeAgo
} from './api.js';
import {
    renderTicketAttachment,
    watchTicketAttachments
} from './ticket-attachments.js';

let root = null;


const TICKET_WS_URL = 'ws://192.168.18.10:8081';

let ticketSocket = null;
let ticketSocketAuthenticated = false;
let activeTicketId = null;
let activeTicketBody = null;

function sendSocketCommand(command) {
    if (
        ticketSocket &&
        ticketSocket.readyState === WebSocket.OPEN &&
        ticketSocketAuthenticated
    ) {
        ticketSocket.send(JSON.stringify(command));
        return true;
    }

    return false;
}

function connectTicketSocket() {
    if (
        ticketSocket &&
        (ticketSocket.readyState === WebSocket.OPEN ||
         ticketSocket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    const token = getAccessToken();
    if (!token) return;

    const socket = new WebSocket(TICKET_WS_URL);
    ticketSocket = socket;
    ticketSocketAuthenticated = false;

    socket.addEventListener('open', () => {
        if (ticketSocket !== socket) return;

        socket.send(JSON.stringify({
            type: 'auth',
            token: token.replace(/^Bearer\s+/i, '')
        }));
    });

    socket.addEventListener('message', event => {
        if (ticketSocket !== socket) return;

        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        if (data.type === 'authenticated') {
            ticketSocketAuthenticated = true;

            if (activeTicketId) {
                sendSocketCommand({
                    type: 'subscribe',
                    ticketId: activeTicketId
                });
            }

            return;
        }

        if (
            data.type === 'ticket.message.created' &&
            String(data.ticketId) === String(activeTicketId) &&
            activeTicketBody
        ) {
            refreshTicketMessages(activeTicketId, activeTicketBody);
        }
    });

    socket.addEventListener('close', () => {
        if (ticketSocket === socket) {
            ticketSocket = null;
            ticketSocketAuthenticated = false;
        }
    });

    socket.addEventListener('error', () => {
        console.error('SupportAssist ticket WebSocket connection failed.');
    });
}

function activateTicketSubscription(ticketId, body) {
    if (activeTicketId && activeTicketId !== ticketId) {
        sendSocketCommand({
            type: 'unsubscribe',
            ticketId: activeTicketId
        });
    }

    activeTicketId = String(ticketId);
    activeTicketBody = body;

    connectTicketSocket();

    // If the socket is already authenticated, subscribe immediately.
    sendSocketCommand({
        type: 'subscribe',
        ticketId: activeTicketId
    });
}

function deactivateTicketSubscription() {
    if (activeTicketId) {
        sendSocketCommand({
            type: 'unsubscribe',
            ticketId: activeTicketId
        });
    }

    activeTicketId = null;
    activeTicketBody = null;
}


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
        .tm-conversation { border-top: 1px solid var(--border-color, #26334d); padding-top: 14px; margin-top: 14px; }
        .tm-messages { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; padding: 4px 2px; }
        .tm-message { align-self: flex-start; width: fit-content; max-width: 85%; border: 1px solid var(--border-color, #26334d); border-radius: 12px 12px 12px 3px; padding: 10px 12px; background: var(--bg-input, #1c273f); }
        .tm-message.sent { align-self: flex-end; border-color: rgba(59,130,246,.45); border-radius: 12px 12px 3px 12px; background: rgba(59,130,246,.18); }
        .tm-message.internal { border-style: dashed; background: rgba(245,158,11,.08); }
        .tm-message-meta { color: var(--text-muted, #8b9bb5); font-size: 11px; margin-bottom: 5px; display:flex; gap:8px; flex-wrap:wrap; }
        .tm-message-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.5; }
        .tm-composer { margin-top: 12px; display: grid; gap: 8px; }
        .tm-composer textarea { width:100%; min-height:76px; resize:vertical; box-sizing:border-box; padding:10px; border-radius:8px; color:inherit; background:var(--bg-input,#1c273f); border:1px solid var(--border-color,#26334d); font:inherit; }
        .tm-composer button { justify-self:end; padding:9px 14px; border:0; border-radius:8px; background:var(--accent-blue,#3b82f6); color:white; cursor:pointer; }
        .tm-composer button:disabled { opacity:.6; cursor:wait; }
        @media (max-width: 600px) { .tm-message { max-width: 96%; } }
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
    deactivateTicketSubscription();
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

        ${renderTicketAttachment(t.attachmentUrl, 'detail')}

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
        <section class="tm-conversation" aria-label="Ticket conversation"><h4>Conversation</h4><div class="tm-messages">Loading messages...</div><form class="tm-composer"><textarea name="message" maxlength="10000" placeholder="Write a reply…" required></textarea><label class="tm-internal-toggle" hidden><input type="checkbox" name="isInternal"> Internal note (visible to support staff only)</label><button type="submit">Send reply</button><div class="tm-msg" aria-live="polite"></div></form></section>
    `;
}


async function refreshTicketMessages(ticketId, body) {
    const list = body.querySelector('.tm-messages');
    if (!list) return;

    try {
        const messages = await getTicketMessages(ticketId);

        // Ignore results if the user has switched to another ticket.
        if (
            activeTicketBody !== body ||
            String(activeTicketId) !== String(ticketId) ||
            !list.isConnected
        ) {
            return;
        }

        const currentUserId = getCurrentUser()?.id;
        list.innerHTML = messages.length
            ? messages.map(message => {
                const authorId = message.author?.id;
                const isSent = currentUserId != null && authorId != null && String(authorId) === String(currentUserId);
                return `
                <article class="tm-message ${isSent ? 'sent' : ''} ${message.isInternal ? 'internal' : ''}">
                    <div class="tm-message-meta">
                        <strong>${escapeHtml(message.author?.name || 'User')}</strong>
                        <span>${escapeHtml(message.author?.userType || '')}</span>
                        <time>${fmt(message.createdAt)}</time>
                        ${message.isInternal ? '<strong>Internal note</strong>' : ''}
                    </div>
                    <div class="tm-message-body">${escapeHtml(message.body)}</div>
                </article>`;
            }).join('')
            : '<p class="tm-muted">No replies yet. Start the conversation below.</p>';

        // Keep the newest message visible.
        list.lastElementChild?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest'
        });
    } catch (error) {
        console.error('Could not refresh ticket messages:', error);
    }
}


async function loadConversation(ticketId, body) {
    const list = body.querySelector('.tm-messages');
    let form = body.querySelector('.tm-composer');
    const freshForm = form.cloneNode(true);
    form.replaceWith(freshForm);
    form = freshForm;
    const internalToggle = form.querySelector('.tm-internal-toggle');
    const currentUser = getCurrentUser();
    internalToggle.hidden = !['ADMIN', 'TECHNICIAN'].includes(currentUser?.userType);
    await refreshTicketMessages(ticketId, body);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const textarea = form.elements.message;
        const button = form.querySelector('button[type="submit"]');
        const status = form.querySelector('.tm-msg');
        const value = textarea.value.trim();
        if (!value || button.disabled) return;
        button.disabled = true;
        status.className = 'tm-msg';
        status.textContent = 'Sending…';
        try {
            await postTicketMessage(ticketId, value, Boolean(form.elements.isInternal?.checked));
            textarea.value = '';
            if (form.elements.isInternal) form.elements.isInternal.checked = false;
            status.className = 'tm-msg ok';
            status.textContent = 'Message sent.';
            await refreshTicketMessages(ticketId, body);
        } catch (error) {
            status.className = 'tm-msg err';
            status.textContent = error.message || 'Could not send message.';
        } finally {
            button.disabled = false;
        }
    });
}

/**
 * Open the modal for a given ticket id.
 * @param {string} ticketId
 * @param {(footerEl: HTMLElement, ticket: object, reopen: () => void) => void} [renderFooter]
 *   Called after the ticket loads, so the caller can put role-specific action
 *   buttons in the footer. `reopen()` re-fetches and re-renders in place
 *   (call it after an action succeeds, e.g. after assigning a technician).
 */
export async function openTicketModal(ticketId, renderFooter, fallbackTicket = null) {
    watchTicketAttachments();
    const el = ensureRoot();
    el.classList.add('open');
    const body = el.querySelector('.tm-body');
    const footer = el.querySelector('.tm-footer');
    body.innerHTML = '<p>Loading ticket...</p>';
    footer.innerHTML = '';

    try {
        let ticket;
        try {
            ticket = await getTicket(ticketId);
        } catch (err) {
            if (!fallbackTicket) throw err;
            ticket = fallbackTicket;
        }
        body.innerHTML = renderBody(ticket);
        activateTicketSubscription(ticketId, body);
        if (renderFooter) {
            renderFooter(footer, ticket, () => openTicketModal(ticketId, renderFooter));
        }
        await loadConversation(ticketId, body);
    } catch (err) {
        body.innerHTML = `<p class="tm-error">${escapeHtml(err.message)}</p>`;
    }
}
