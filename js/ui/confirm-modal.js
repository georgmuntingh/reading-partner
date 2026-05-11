/**
 * Generic Confirmation Modal
 * Asks the user to confirm a destructive action. Returns a Promise that
 * resolves to true (confirmed) or false (cancelled / dismissed).
 */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message - Plain text body. HTML is escaped.
 * @param {string} [opts.confirmLabel='Confirm']
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {boolean} [opts.danger=false] - Render the confirm button as a
 *   destructive action.
 * @returns {Promise<boolean>}
 */
export function confirmAction({
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false
}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active confirm-modal-overlay';
        overlay.innerHTML = `
            <div class="modal confirm-modal" role="alertdialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${escapeHtml(title)}</h2>
                </div>
                <div class="modal-content">
                    <p>${escapeHtml(message)}</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>
                    <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
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

        overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => finish(true));
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(false);
        });
        document.addEventListener('keydown', function onKey(e) {
            if (settled) {
                document.removeEventListener('keydown', onKey);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            }
        });

        // Default focus to the cancel button so a stray Enter doesn't
        // execute a destructive default.
        setTimeout(() => overlay.querySelector('[data-action="cancel"]').focus(), 0);
    });
}
