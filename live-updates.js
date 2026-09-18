// live-updates.js — long-polls GET /api/alerts/poll and calls back whenever
// something changes, instead of each page only ever loading data once at
// page load. Same endpoint and contract the Android app's AlertPoller uses;
// see the backend's RUNNING.md for the full explanation of why this is a
// long-poll rather than a WebSocket (this is a PHP-FPM backend, not Node —
// see the earlier discussion about Socket.io needing a persistent process).
//
// The callback doesn't receive the alert contents — every page already has
// its own "reload whatever's currently on screen" function (refreshCurrentTab
// in technician.html/admin.html; the equivalent added to user.html below).
// Treating "an alert fired" as just a signal to resync, rather than trying
// to patch the DOM from the alert payload directly, keeps this generic
// across three pages with three different data shapes on screen.
//
// Pauses while the tab is hidden (Page Visibility API) — an unattended
// background tab has no reason to hold a long-poll connection open, and the
// backend's RUNNING.md already flags that every open poll ties up a
// PHP-FPM worker; no sense doing that for a tab nobody's looking at.

import { pollAlerts } from './api.js';

const TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5000; // backoff so a dead network doesn't spin-loop

let running = false;

export function startLiveUpdates(onChange) {
    if (running) return;
    running = true;
    let since = new Date().toISOString();

    (async function loop() {
        while (running) {
            if (document.hidden) {
                await waitUntilVisible();
                if (!running) break;
                // Don't ask for everything that happened while backgrounded —
                // just resume live from now. The page will already show
                // stale data for a moment after tab switch; that's fine,
                // this only needs to catch up going forward.
                since = new Date().toISOString();
            }

            try {
                const result = await pollAlerts(since, TIMEOUT_SECONDS);
                if (!running) break;
                since = result.serverTime; // always the server's clock, never the browser's
                if (result.alerts && result.alerts.length > 0) {
                    onChange();
                }
                // Empty result is normal — the server just hit its timeout
                // with nothing new. Loop straight back around.
            } catch (err) {
                if (!running) break;
                await sleep(RETRY_DELAY_MS);
            }
        }
    })();
}

export function stopLiveUpdates() {
    running = false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntilVisible() {
    return new Promise((resolve) => {
        function onVisibilityChange() {
            if (!document.hidden) {
                document.removeEventListener('visibilitychange', onVisibilityChange);
                resolve();
            }
        }
        document.addEventListener('visibilitychange', onVisibilityChange);
    });
}
