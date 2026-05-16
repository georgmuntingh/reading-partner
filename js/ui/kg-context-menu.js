/**
 * Floating context menu for the knowledge-graph explorer.
 * Anchored at (x, y) in client coordinates with edge-of-viewport clamping.
 * Resolves with the picked item's `id`, or null on outside-click / Escape /
 * scroll.
 */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * @param {Object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {{ id: string, label: string, danger?: boolean }[]} opts.items
 * @returns {Promise<string|null>}
 */
export function openContextMenu({ x, y, items }) {
    return new Promise((resolve) => {
        const menu = document.createElement('div');
        menu.className = 'kg-context-menu';
        menu.setAttribute('role', 'menu');
        menu.innerHTML = items.map((it) => `
            <button type="button" role="menuitem"
                    class="kg-context-menu-item${it.danger ? ' is-danger' : ''}"
                    data-id="${escapeHtml(it.id)}">
                ${escapeHtml(it.label)}
            </button>
        `).join('');
        document.body.appendChild(menu);

        // Edge-of-viewport clamping. Measure after attach so width/height are
        // real; then nudge so the menu stays fully on-screen.
        const margin = 4;
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = Math.min(Math.max(margin, x), vw - rect.width - margin);
        const top = Math.min(Math.max(margin, y), vh - rect.height - margin);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        let settled = false;
        const cleanup = () => {
            if (settled) return;
            settled = true;
            menu.remove();
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('mousedown', onOutside, true);
            document.removeEventListener('touchstart', onOutside, true);
            window.removeEventListener('scroll', dismissNull, true);
            window.removeEventListener('resize', dismissNull);
            window.removeEventListener('blur', dismissNull);
        };
        const dismissNull = () => { if (!settled) { cleanup(); resolve(null); } };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); dismissNull(); }
        };
        const onOutside = (e) => {
            if (!menu.contains(e.target)) dismissNull();
        };

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-id]');
            if (!btn) return;
            const id = btn.dataset.id;
            cleanup();
            resolve(id);
        });

        // Defer subscribing so the same event that opened the menu does not
        // immediately dismiss it.
        setTimeout(() => {
            if (settled) return;
            document.addEventListener('keydown', onKey, true);
            document.addEventListener('mousedown', onOutside, true);
            document.addEventListener('touchstart', onOutside, true);
            window.addEventListener('scroll', dismissNull, true);
            window.addEventListener('resize', dismissNull);
            window.addEventListener('blur', dismissNull);
        }, 0);
    });
}
