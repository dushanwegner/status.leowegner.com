document.addEventListener('DOMContentLoaded', function() {
    // Sync body color cycle animation to a consistent offset
    const colorCycleDuration = 60000;
    const now = Date.now();
    const colorOffset = -(now % colorCycleDuration);
    document.body.style.animationDelay = `${colorOffset}ms`;

    // Sync theme-color meta tag with the CSS color cycle
    syncThemeColor(colorCycleDuration, now);

    // Fetch updown.io status and render mini status page
    fetchStatus();
});

const MAX_STATUS_DAYS = 90;
const BAR_WIDTH_PX = 20; // minimum width per bar

// Cached API data so we can re-render on resize without re-fetching
let cachedChecks = null;
let cachedDowntimes = null;
let initialRenderDone = false;

async function fetchStatus() {
    const section = document.getElementById('status-section');
    if (!section || typeof UPDOWN_API_KEY === 'undefined') return;

    // Show loading placeholder
    section.innerHTML = `<div class="status-loading">
        <div class="status-loading-line"></div>
        <div class="status-loading-line"></div>
        <div class="status-loading-line"></div>
        <div class="status-loading-line"></div>
    </div>`;

    try {
        // Fetch checks list
        const response = await fetch(`https://updown.io/api/checks?api-key=${UPDOWN_API_KEY}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        cachedChecks = await response.json();

        // Fetch downtimes for each check in parallel
        const downtimePromises = cachedChecks.map(check =>
            fetch(`https://updown.io/api/checks/${check.token}/downtimes?api-key=${UPDOWN_API_KEY}`)
                .then(r => r.ok ? r.json() : [])
                .catch(() => [])
        );
        cachedDowntimes = await Promise.all(downtimePromises);

        // Filter services based on INCLUDE_SERVICES / EXCLUDE_SERVICES from config
        applyServiceFilter();

        renderStatus();

        // Re-render on resize so bar count adapts
        window.addEventListener('resize', debounce(renderStatus, 200));

    } catch (err) {
        console.error('Failed to fetch updown.io status:', err);
        section.innerHTML = '<div class="status-header status-warn">Status unavailable</div>';
    }
}

/**
 * Determine how many days of bars to show based on container width.
 * Each bar needs ~22px (20px bar + 2px gap). Minimum 7 days.
 */
function getVisibleDays() {
    const section = document.getElementById('status-section');
    if (!section) return MAX_STATUS_DAYS;
    const width = section.clientWidth;
    const days = Math.floor(width / (BAR_WIDTH_PX + 2));
    return Math.max(7, Math.min(days, MAX_STATUS_DAYS));
}

function renderStatus() {
    const section = document.getElementById('status-section');
    if (!section || !cachedChecks) return;

    const visibleDays = getVisibleDays();
    const allUp = cachedChecks.every(c => !c.down);
    const single = cachedChecks.length === 1;
    const headerText = allUp
        ? (single ? 'System operational' : 'All systems operational')
        : (single ? 'System has issues' : 'Some systems have issues');
    const headerClass = allUp ? 'status-ok' : 'status-warn';

    let html = '<div class="status-content">';
    html += `<div class="status-header ${headerClass}">${headerText}</div>`;
    html += '<div class="status-checks">';

    for (let i = 0; i < cachedChecks.length; i++) {
        const check = cachedChecks[i];
        const downtimes = cachedDowntimes[i];
        const isUp = !check.down;
        const dotClass = isUp ? 'dot-up' : 'dot-down';
        const uptime = check.uptime != null ? `${check.uptime}%` : '—';

        // Build the day-by-day uptime bar (pass created_at so pre-monitoring days show as no-data)
        const barHtml = buildUptimeBar(downtimes, check.down, visibleDays, check.created_at);

        html += `
            <div class="status-check">
                <div class="status-check-header">
                    <span class="status-dot ${dotClass}"></span>
                    <span class="status-name">${check.alias}</span>
                    <span class="status-detail">${uptime}</span>
                </div>
                ${barHtml}
            </div>`;
    }

    html += '</div>';

    // Bar legend
    html += `<div class="status-legend">
        <span>${visibleDays} days ago</span>
        <span>Today</span>
    </div>`;
    html += '</div>'; // close .status-content

    section.innerHTML = html;

    // Trigger zoom-in animation on first render only
    const content = section.querySelector('.status-content');
    if (content) {
        if (initialRenderDone) {
            content.classList.add('status-visible');
        } else {
            requestAnimationFrame(() => {
                content.classList.add('status-visible');
            });
            initialRenderDone = true;
        }
    }
}

/**
 * Build a row of small bars for the last numDays days.
 * Green = no downtime, red = downtime >= 10min, yellow = downtime < 10min.
 * Semi-transparent = day before monitoring started (based on created_at).
 */
function buildUptimeBar(downtimes, isCurrentlyDown, numDays, createdAt) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Date the check was created (start of that day)
    const created = createdAt ? new Date(createdAt) : null;
    if (created) created.setHours(0, 0, 0, 0);

    // Pre-compute downtime seconds per day
    const dayDowntime = new Array(numDays).fill(0);

    for (const dt of downtimes) {
        const start = new Date(dt.started_at);
        const end = dt.ended_at ? new Date(dt.ended_at) : new Date();

        for (let d = 0; d < numDays; d++) {
            const dayStart = new Date(today);
            dayStart.setDate(dayStart.getDate() - (numDays - 1 - d));
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);

            // Overlap between downtime window and this day
            const overlapStart = Math.max(start.getTime(), dayStart.getTime());
            const overlapEnd = Math.min(end.getTime(), dayEnd.getTime());
            if (overlapStart < overlapEnd) {
                dayDowntime[d] += (overlapEnd - overlapStart) / 1000;
            }
        }
    }

    let bars = '<div class="uptime-bar">';
    for (let d = 0; d < numDays; d++) {
        const dayDate = new Date(today);
        dayDate.setDate(dayDate.getDate() - (numDays - 1 - d));
        const dateStr = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        // Day is before the check was created = no monitoring data
        if (created && dayDate < created) {
            bars += `<div class="uptime-bar-day bar-nodata" title="${dateStr}: No data"></div>`;
            continue;
        }

        const seconds = dayDowntime[d];
        let barClass = 'bar-up';
        let tooltip = 'No downtime';

        if (seconds > 0) {
            if (seconds >= 600) {
                barClass = 'bar-down';
                tooltip = `${Math.round(seconds / 60)}min downtime`;
            } else {
                barClass = 'bar-partial';
                tooltip = `${Math.round(seconds / 60)}min downtime`;
            }
        }

        // Override for today if currently down
        if (d === numDays - 1 && isCurrentlyDown) {
            barClass = 'bar-down';
            tooltip = 'Currently down';
        }

        bars += `<div class="uptime-bar-day ${barClass}" title="${dateStr}: ${tooltip}"></div>`;
    }
    bars += '</div>';

    return bars;
}

/**
 * Filter cachedChecks/cachedDowntimes based on config.
 * INCLUDE_SERVICES (allowlist) takes priority over EXCLUDE_SERVICES (blocklist).
 */
function applyServiceFilter() {
    if (!cachedChecks || !cachedDowntimes) return;

    let filterFn;
    if (typeof INCLUDE_SERVICES !== 'undefined' && INCLUDE_SERVICES.length) {
        filterFn = check => INCLUDE_SERVICES.includes(check.alias);
    } else if (typeof EXCLUDE_SERVICES !== 'undefined' && EXCLUDE_SERVICES.length) {
        filterFn = check => !EXCLUDE_SERVICES.includes(check.alias);
    } else {
        return;
    }

    const keep = [];
    cachedChecks = cachedChecks.filter((check, i) => {
        if (filterFn(check)) { keep.push(i); return true; }
        return false;
    });
    cachedDowntimes = keep.map(i => cachedDowntimes[i]);
}

function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

/**
 * Sync the theme-color meta tag with the CSS colorCycle animation.
 * Computes the current hue from elapsed time and converts hsl(h, 70%, 20%) to hex.
 */
function syncThemeColor(cycleDuration, startTime) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    function update() {
        const elapsed = (Date.now() - startTime) % cycleDuration;
        const hue = (elapsed / cycleDuration) * 360;
        meta.setAttribute('content', hslToHex(hue, 70, 20));
    }

    // Update immediately, then every 2 seconds (no need for 60fps on a meta tag)
    update();
    setInterval(update, 2000);
}

/** Convert HSL values to a hex color string. */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}
