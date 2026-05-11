/**
 * KG Context Preview Modal
 * Opens when the user clicks a context link in the graph explorer's node
 * details panel. Instead of immediately jumping to the source text, it
 * shows the target sentence with a window of surrounding sentences from
 * the same chapter, with the target highlighted.
 *
 * The user can still navigate to the reader via the "Open in reader"
 * button at the bottom of the modal.
 */

const NEIGHBOURHOOD_RADIUS = 2;   // sentences on each side of the target

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * @param {Object} opts
 * @param {string} opts.entityName - Canonical name of the KG node the link came from
 * @param {string} [opts.chapterTitle] - Display title for the chapter
 * @param {number} opts.chapterIndex - 0-based chapter index
 * @param {number} opts.sentenceIndex - 0-based sentence index inside the chapter
 * @param {(chapterIndex: number) => Promise<string[]>} [opts.loadSentences]
 *   Resolves to the chapter's sentence array. If omitted or it rejects, the
 *   modal still opens but shows a friendly fallback.
 * @param {(chapterIndex: number, sentenceIndex: number) => void} [opts.onJumpToSentence]
 *   Wired to the "Open in reader" button. Omit to hide that action.
 * @returns {Promise<void>} resolves when the modal closes
 */
export function openContextPreview(opts) {
    const {
        entityName,
        chapterTitle,
        chapterIndex,
        sentenceIndex,
        loadSentences,
        onJumpToSentence
    } = opts;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active kg-context-preview-overlay';
        const headerSubtitle = chapterTitle
            ? `${escapeHtml(chapterTitle)} · sentence ${sentenceIndex + 1}`
            : `Chapter ${chapterIndex + 1} · sentence ${sentenceIndex + 1}`;
        overlay.innerHTML = `
            <div class="modal kg-context-preview-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${escapeHtml(entityName)}</h2>
                    <button type="button" class="btn-icon modal-close-btn" aria-label="Close preview" data-action="close">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="modal-content">
                    <p class="kg-context-preview-subtitle">${headerSubtitle}</p>
                    <div class="kg-context-preview-body" id="kg-context-preview-body">
                        <p class="kg-context-preview-loading">Loading neighbourhood…</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="close">Close</button>
                    ${onJumpToSentence ? '<button type="button" class="btn btn-primary" data-action="jump">Open in reader</button>' : ''}
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            overlay.remove();
            resolve();
        };

        overlay.querySelectorAll('[data-action="close"]').forEach((b) =>
            b.addEventListener('click', finish)
        );
        const jumpBtn = overlay.querySelector('[data-action="jump"]');
        jumpBtn?.addEventListener('click', () => {
            finish();
            onJumpToSentence?.(chapterIndex, sentenceIndex);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish();
        });
        document.addEventListener('keydown', function onKey(e) {
            if (settled) {
                document.removeEventListener('keydown', onKey);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                finish();
            }
        });

        // Async-fetch the chapter sentences and render the neighbourhood.
        const body = overlay.querySelector('#kg-context-preview-body');
        const renderFallback = (msg) => {
            body.innerHTML = `<p class="kg-context-preview-error">${escapeHtml(msg)}</p>`;
        };

        if (typeof loadSentences !== 'function') {
            renderFallback('No chapter loader available — open the reader to view the surrounding text.');
            return;
        }

        Promise.resolve()
            .then(() => loadSentences(chapterIndex))
            .then((sentences) => {
                if (settled) return;
                if (!Array.isArray(sentences) || sentences.length === 0) {
                    renderFallback('The chapter has no loadable sentences.');
                    return;
                }
                const start = Math.max(0, sentenceIndex - NEIGHBOURHOOD_RADIUS);
                const end = Math.min(sentences.length, sentenceIndex + NEIGHBOURHOOD_RADIUS + 1);
                const rendered = [];
                for (let i = start; i < end; i++) {
                    const isTarget = i === sentenceIndex;
                    rendered.push(
                        `<p class="kg-context-preview-sentence${isTarget ? ' is-target' : ''}">`
                        + `<span class="kg-context-preview-num">${i + 1}.</span> `
                        + escapeHtml(sentences[i] ?? '')
                        + '</p>'
                    );
                }
                if (sentenceIndex < 0 || sentenceIndex >= sentences.length) {
                    rendered.push(
                        '<p class="kg-context-preview-error">'
                        + `Sentence ${sentenceIndex + 1} is no longer in this chapter.`
                        + '</p>'
                    );
                }
                body.innerHTML = rendered.join('');
            })
            .catch((err) => {
                if (settled) return;
                renderFallback(`Could not load chapter: ${err?.message ?? String(err)}`);
            });
    });
}
