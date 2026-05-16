/**
 * KG Domain Modal
 * Small one-shot modal that asks the user for the per-book domain string
 * the first time they build the knowledge graph for a book. The string
 * focuses Tier-1 (prompt) and Tier-2 (anchor) extraction.
 *
 * Exports a single `promptForDomain(book)` Promise: resolves to the trimmed
 * domain on confirm, or null on cancel.
 */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * @param {{ title?: string }} book
 * @returns {Promise<string|null>}
 */
export function promptForDomain(book) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active kg-domain-modal-overlay';
        overlay.innerHTML = `
            <div class="modal kg-domain-modal">
                <div class="modal-header">
                    <h2>Knowledge Graph Domain</h2>
                </div>
                <div class="modal-content">
                    <p>What domain best describes <em>${escapeHtml(book?.title || 'this book')}</em>? This focuses extraction on the topics you care about — meta-text, citations, and incidental nouns are filtered out.</p>
                    <input type="text" id="kg-domain-input" class="form-input"
                           placeholder="e.g. Molecular Cell Biology"
                           autocomplete="off" spellcheck="false">
                    <p class="form-hint">You can refine this later in your book's settings.</p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" data-action="ok">Start Extraction</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#kg-domain-input');
        const okBtn = overlay.querySelector('[data-action="ok"]');
        const cancelBtn = overlay.querySelector('[data-action="cancel"]');

        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            overlay.remove();
            resolve(value);
        };
        const submit = () => {
            const v = input.value.trim();
            if (!v) {
                input.classList.add('error');
                input.focus();
                return;
            }
            finish(v);
        };

        okBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', () => finish(null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            } else if (e.key === 'Escape') {
                finish(null);
            }
        });
        // Click outside the modal cancels.
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(null);
        });

        // Defer focus so the browser has appended the node first.
        setTimeout(() => input.focus(), 0);
    });
}
