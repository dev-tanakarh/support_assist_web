import { escapeHtml, fetchTicketAttachment, resolveTicketAttachmentUrl } from './api.js';

const imageCache = new Map();
const pendingImages = new Map();
let intersectionObserver;
let watcherStarted = false;

function injectStyles() {
    if (document.getElementById('ticket-attachment-styles')) return;
    const style = document.createElement('style');
    style.id = 'ticket-attachment-styles';
    style.textContent = `
        .ticket-attachment { display: inline-flex; position: relative; align-items: center; justify-content: center;
            padding: 0; border: 1px solid var(--border-color, #26334d); border-radius: 6px; background: var(--bg-input, #1c273f);
            color: var(--text-muted, #8b9bb5); overflow: hidden; cursor: pointer; vertical-align: middle; }
        .ticket-subject-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .ticket-attachment.thumbnail { width: 72px; height: 52px; }
        .ticket-attachment.detail { display: flex; width: 100%; max-height: 420px; min-height: 130px; margin: 0 0 18px; }
        .ticket-attachment img { display: none; width: 100%; height: 100%; max-height: 420px; object-fit: cover; }
        .ticket-attachment.detail img { object-fit: contain; }
        .ticket-attachment[data-image-state="loaded"] img { display: block; }
        .ticket-attachment .attachment-message { padding: 4px; font-size: 10px; line-height: 1.2; text-align: center; }
        .ticket-attachment.detail .attachment-message { font-size: 12px; }
        .ticket-attachment[data-image-state="loaded"] .attachment-message { display: none; }
        .ticket-image-viewer { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center;
            padding: 24px; background: rgba(0,0,0,.92); cursor: zoom-out; }
        .ticket-image-viewer img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: default; }
        .ticket-image-viewer button { position: absolute; top: 16px; right: 20px; border: 0; background: transparent; color: #fff;
            font-size: 30px; cursor: pointer; }
        @media (max-width: 640px) { .ticket-attachment.thumbnail { width: 56px; height: 44px; } }
    `;
    document.head.appendChild(style);
}

export function renderTicketAttachment(attachmentUrl, size = 'thumbnail') {
    if (typeof attachmentUrl !== 'string' || !attachmentUrl.trim()) return '';
    const label = size === 'detail' ? 'View ticket attachment full screen' : 'Open ticket attachment';
    return `<button type="button" class="ticket-attachment ${size === 'detail' ? 'detail' : 'thumbnail'}" data-ticket-attachment="${escapeHtml(attachmentUrl)}" data-image-state="loading" aria-label="${label}">
        <span class="attachment-message">Loading image...</span><img alt="Ticket attachment" loading="lazy" decoding="async">
    </button>`;
}

function getImage(url) {
    if (imageCache.has(url)) return Promise.resolve(imageCache.get(url));
    if (pendingImages.has(url)) return pendingImages.get(url);
    const pending = fetchTicketAttachment(url).then(objectUrl => {
        imageCache.set(url, objectUrl);
        if (imageCache.size > 80) {
            const oldestUrl = imageCache.keys().next().value;
            URL.revokeObjectURL(imageCache.get(oldestUrl));
            imageCache.delete(oldestUrl);
        }
        return objectUrl;
    }).finally(() => pendingImages.delete(url));
    pendingImages.set(url, pending);
    return pending;
}

async function hydrate(button) {
    if (button.dataset.imageRequested) return;
    button.dataset.imageRequested = 'true';
    const image = button.querySelector('img');
    const resolvedUrl = resolveTicketAttachmentUrl(button.dataset.ticketAttachment);
    if (!resolvedUrl) {
        button.dataset.imageState = 'error';
        button.querySelector('.attachment-message').textContent = 'Image unavailable';
        return;
    }
    image.addEventListener('load', () => { button.dataset.imageState = 'loaded'; }, { once: true });
    image.addEventListener('error', async () => {
        if (button.dataset.authRetry || !button.isConnected) {
            button.dataset.imageState = 'error';
            button.querySelector('.attachment-message').textContent = 'Image unavailable';
            return;
        }
        button.dataset.authRetry = 'true';
        try {
            const objectUrl = await getImage(button.dataset.ticketAttachment);
            if (button.isConnected) image.src = objectUrl;
        } catch {
            if (button.isConnected) {
                button.dataset.imageState = 'error';
                button.querySelector('.attachment-message').textContent = 'Image unavailable';
            }
        }
    });
    image.src = resolvedUrl;
}

function observeAttachments(root) {
    const buttons = [];
    if (root instanceof Element && root.matches('[data-ticket-attachment]')) buttons.push(root);
    if (root.querySelectorAll) buttons.push(...root.querySelectorAll('[data-ticket-attachment]'));
    for (const button of buttons) {
        if (intersectionObserver) intersectionObserver.observe(button);
        else hydrate(button);
    }
}

function openViewer(imageUrl) {
    const viewer = document.createElement('div');
    viewer.className = 'ticket-image-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', 'Ticket attachment');
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close image viewer');
    close.textContent = '\u00d7';
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = 'Ticket attachment enlarged';
    viewer.append(close, image);
    const dismiss = () => viewer.remove();
    close.addEventListener('click', dismiss);
    viewer.addEventListener('click', event => { if (event.target === viewer) dismiss(); });
    function onKeyDown(event) {
        if (event.key === 'Escape') {
            dismiss();
            document.removeEventListener('keydown', onKeyDown);
        }
    }
    close.addEventListener('click', () => document.removeEventListener('keydown', onKeyDown), { once: true });
    viewer.addEventListener('click', event => {
        if (event.target === viewer) document.removeEventListener('keydown', onKeyDown);
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(viewer);
    close.focus();
}

export function watchTicketAttachments() {
    if (watcherStarted) return;
    watcherStarted = true;
    injectStyles();
    if ('IntersectionObserver' in window) {
        intersectionObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                intersectionObserver.unobserve(entry.target);
                hydrate(entry.target);
            }
        }, { rootMargin: '120px' });
    }
    observeAttachments(document);
    new MutationObserver(records => {
        records.forEach(record => record.addedNodes.forEach(node => {
            if (node instanceof Element) observeAttachments(node);
        }));
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-ticket-attachment]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.dataset.imageState === 'loaded') openViewer(button.querySelector('img').src);
    });
}
