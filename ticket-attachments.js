import { escapeHtml, fetchTicketAttachment, resolveTicketAttachmentUrl, uploadProfileAvatar } from './api.js';

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
       .ticket-attachment img {
    display: block;
    visibility: hidden;
    width: 100%;
    height: 100%;
    max-height: 420px;
    object-fit: cover;
}
        .ticket-attachment.detail img { object-fit: contain; }
        .ticket-attachment[data-image-state="loaded"] img {
    visibility: visible;
}
        .ticket-attachment .attachment-message { padding: 4px; font-size: 10px; line-height: 1.2; text-align: center; }
        .ticket-attachment.detail .attachment-message { font-size: 12px; }
        .ticket-attachment[data-image-state="loaded"] .attachment-message { display: none; }
        .ticket-image-viewer { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center;
            padding: 24px; background: rgba(0,0,0,.92); cursor: zoom-out; }
        .ticket-image-viewer img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: default; }
        .ticket-image-viewer button { position: absolute; top: 16px; right: 20px; border: 0; background: transparent; color: #fff;
            font-size: 30px; cursor: pointer; }
        .profile-picture-control { position: relative; width: 112px; height: 112px; flex: 0 0 112px; }
        .profile-picture-view { width: 100%; height: 100%; padding: 0; border: 2px solid var(--border-color, #26334d); border-radius: 50%;
            background: var(--bg-input, #1c273f); color: var(--text-muted, #8b9bb5); overflow: hidden; cursor: pointer; }
        .profile-picture-view:disabled { cursor: default; }
        .profile-picture-view img { width: 100%; height: 100%; object-fit: cover; }
        .profile-picture-view img[hidden] { display: none; }
        .profile-picture-initials { font-size: 28px; font-weight: 600; }
        .profile-picture-upload { position: absolute; right: -4px; bottom: -4px; display: grid; place-items: center; width: 36px; height: 36px;
            border: 2px solid var(--bg-card, #151e30); border-radius: 50%; background: var(--accent-blue, #3b82f6); color: #fff; cursor: pointer; }
        .profile-picture-status { margin-top: 8px; color: var(--text-muted, #8b9bb5); font-size: 12px; }
        .profile-picture-status.error { color: var(--accent-red, #ef4444); }
        @media (max-width: 640px) { .ticket-attachment.thumbnail { width: 56px; height: 44px; } }
    `;
    document.head.appendChild(style);
}

export function renderTicketAttachment(attachmentUrl, size = 'thumbnail', thumbnailUrl = null) {
    const sourceUrl = size === 'thumbnail' && typeof thumbnailUrl === 'string' && thumbnailUrl.trim()
        ? thumbnailUrl
        : attachmentUrl;
    if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) return '';
    const label = size === 'detail' ? 'View ticket attachment full screen' : 'Open ticket attachment';
    return `<button type="button" class="ticket-attachment ${size === 'detail' ? 'detail' : 'thumbnail'}" data-ticket-attachment="${escapeHtml(sourceUrl)}" data-full-image="${escapeHtml(attachmentUrl || sourceUrl)}" data-image-state="loading" aria-label="${label}">
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
    image.loading = 'eager';
image.src = resolvedUrl;
}

function observeAttachments(root) {
    const buttons = [];
    if (root instanceof Element && root.matches('[data-ticket-attachment]')) buttons.push(root);
    if (root.querySelectorAll) buttons.push(...root.querySelectorAll('[data-ticket-attachment]'));
    for (const button of buttons) {
    hydrate(button);
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

export function renderProfilePicture(profile = {}) {
    const initials = String(profile.name || 'User').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    const thumbnailUrl = profile.avatarThumbnailUrl || profile.avatarUrl || '';
    return `<div class="profile-picture-control">
        <button type="button" class="profile-picture-view" data-profile-picture="${escapeHtml(thumbnailUrl)}" data-full-image="${escapeHtml(profile.avatarUrl || thumbnailUrl)}" aria-label="View profile picture">
            <span class="profile-picture-initials">${escapeHtml(initials || 'U')}</span>
            <img alt="Profile picture" hidden>
        </button>
        <label class="profile-picture-upload" title="Upload profile picture">
            <i class="fas fa-camera" aria-hidden="true"></i>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-profile-upload hidden>
        </label>
        <p class="profile-picture-status" aria-live="polite"></p>
    </div>`;
}

export function hydrateProfilePicture(root = document) {
    const container = root instanceof Element && root.matches('.profile-picture-control')
        ? root
        : root.querySelector?.('.profile-picture-control');
    if (!container || container.dataset.profileHydrated) return;
    container.dataset.profileHydrated = 'true';

    const view = container.querySelector('[data-profile-picture]');
    const imageUrl = view.dataset.profilePicture;
    const image = view.querySelector('img');
    const initials = view.querySelector('.profile-picture-initials');
    if (imageUrl) {
        getImage(imageUrl).then(src => {
            image.src = src;
            image.hidden = false;
            initials.hidden = true;
            view.disabled = false;
        }).catch(() => { view.disabled = true; });
    } else {
        view.disabled = true;
    }

    const input = container.querySelector('[data-profile-upload]');
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const status = container.querySelector('.profile-picture-status');
        const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!validTypes.includes(file.type) || file.size > 5 * 1024 * 1024) {
            status.className = 'profile-picture-status error';
            status.textContent = 'Choose a JPEG, PNG, WEBP, or GIF image up to 5 MB.';
            input.value = '';
            return;
        }
        const previewUrl = URL.createObjectURL(file);
        const savedImageUrl = image.src;
        const savedImageVisible = !image.hidden;
        image.src = previewUrl;
        image.hidden = false;
        initials.hidden = true;
        view.disabled = false;
        input.disabled = true;
        status.className = 'profile-picture-status';
        status.textContent = 'Uploading...';
        try {
            const profile = await uploadProfileAvatar(file);
            view.dataset.profilePicture = profile.avatarThumbnailUrl || profile.avatarUrl || '';
            view.dataset.fullImage = profile.avatarUrl || profile.avatarThumbnailUrl || '';
            status.textContent = 'Profile picture saved.';
            const displayUrl = profile.avatarThumbnailUrl || profile.avatarUrl;
            if (displayUrl) {
                imageCache.delete(displayUrl);
                const objectUrl = await getImage(displayUrl);
                image.src = objectUrl;
            }
        } catch (error) {
            image.src = savedImageUrl;
            image.hidden = !savedImageVisible;
            initials.hidden = savedImageVisible;
            view.disabled = !savedImageVisible;
            status.className = 'profile-picture-status error';
            status.textContent = error.message || 'Could not save profile picture.';
        } finally {
            URL.revokeObjectURL(previewUrl);
            input.disabled = false;
            input.value = '';
        }
    });
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
            if (node instanceof Element) {
                observeAttachments(node);
                hydrateProfilePicture(node);
            }
        }));
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-ticket-attachment]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.dataset.imageState === 'loaded') {
            const fullUrl = resolveTicketAttachmentUrl(button.dataset.fullImage || button.dataset.ticketAttachment);
            if (!fullUrl) return;
            getImage(fullUrl).then(openViewer).catch(() => openViewer(button.querySelector('img').src));
        }
    });
    document.addEventListener('click', event => {
        const picture = event.target.closest('[data-profile-picture]');
        if (!picture || picture.disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        getImage(picture.dataset.fullImage || picture.dataset.profilePicture)
            .then(openViewer)
            .catch(() => openViewer(picture.querySelector('img').src));
    });
    hydrateProfilePicture(document);
}
