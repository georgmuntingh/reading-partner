/**
 * Touch fallback for nominating the merge Primary.
 * Shown when the user taps "Merge" in the action bar with ≥2 selected nodes.
 * Resolves with the picked node id, or null on cancel.
 */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * @param {Object} opts
 * @param {{ id: string, name: string }[]} opts.candidates
 * @returns {Promise<string|null>}
 */
export function pickMergePrimary({ candidates }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active confirm-modal-overlay';
        const radios = candidates.map((c, i) => `
            <label class="kg-primary-picker-row">
                <input type="radio" name="kg-primary" value="${escapeHtml(c.id)}"${i === 0 ? ' checked' : ''}>
                <span>${escapeHtml(c.name)}</span>
            </label>
        `).join('');
        overlay.innerHTML = `
            <div class="modal confirm-modal" role="dialog" aria-modal="true">
                <div class="modal-header"><h2>Merge into…</h2></div>
                <div class="modal-content">
                    <p>Pick the node that will survive the merge. All others will be absorbed into it.</p>
                    <div class="kg-primary-picker-list">${radios}</div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" data-action="confirm">Continue</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            overlay.remove();
            resolve(value);
        };

        overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
            const checked = overlay.querySelector('input[name="kg-primary"]:checked');
            finish(checked ? checked.value : null);
        });
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
        document.addEventListener('keydown', function onKey(e) {
            if (settled) { document.removeEventListener('keydown', onKey); return; }
            if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        });
    });
}
