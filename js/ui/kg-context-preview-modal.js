/**
 * KG Context Preview Modal
 * Opens when the user clicks a context link in the graph explorer's node
 * details panel (or double-taps a graph node). Shows the target sentence
 * with surrounding sentences from the same chapter, using the chapter's
 * full HTML (with images and inline formatting) so the preview matches
 * the main reader view. The target sentence is rendered bold.
 *
 * Selecting text inside the modal exposes a "look up" floating toolbar
 * via the shared `LookupSelection` helper, identical to the behaviour
 * available in the main reader and quiz overlay.
 */

import { LookupSelection } from './lookup-selection.js';

const NEIGHBOURHOOD_RADIUS = 2;   // sentences on each side of the target

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * Build a DocumentFragment with the formatted neighbourhood of `targetIndex`
 * from the chapter's full HTML. Falls back to a plain-text rendering when
 * the HTML lacks `[data-index]` sentence markers.
 *
 * @param {{ html?: string, sentences?: string[] }} chapter
 * @param {number} targetIndex
 * @returns {DocumentFragment}
 */
function buildNeighbourhoodFragment(chapter, targetIndex) {
    const sentences = Array.isArray(chapter?.sentences) ? chapter.sentences : [];
    const start = Math.max(0, targetIndex - NEIGHBOURHOOD_RADIUS);
    const end = Math.min(
        sentences.length ? sentences.length - 1 : targetIndex + NEIGHBOURHOOD_RADIUS,
        targetIndex + NEIGHBOURHOOD_RADIUS
    );

    if (typeof chapter?.html === 'string' && chapter.html.length > 0) {
        const doc = new DOMParser().parseFromString(chapter.html, 'text/html');
        const startSpan = doc.querySelector(`[data-index="${start}"]`);
        const endSpan = doc.querySelector(`[data-index="${end}"]`);
        if (startSpan && endSpan) {
            // Primary: Range.cloneContents preserves enclosing paragraphs
            // and interstitial nodes (e.g. <img>) between sentences. Some
            // DOM implementations return an empty fragment here, so we
            // detect that and fall through to a span-by-span path.
            try {
                const range = doc.createRange();
                range.setStartBefore(startSpan);
                range.setEndAfter(endSpan);
                const cloned = range.cloneContents();
                if (cloned && (cloned.textContent || '').trim().length > 0) {
                    const t = cloned.querySelector(`[data-index="${targetIndex}"]`);
                    if (t) t.classList.add('kg-context-preview-target');
                    return cloned;
                }
            } catch (_) { /* fall through */ }

            // Fallback: clone each in-range sentence span individually.
            // Loses interstitial nodes but is deterministic.
            const fragment = document.createDocumentFragment();
            const wrap = document.createElement('p');
            wrap.className = 'paragraph';
            for (let i = start; i <= end; i++) {
                const sp = doc.querySelector(`[data-index="${i}"]`);
                if (!sp) continue;
                const clone = sp.cloneNode(true);
                if (i === targetIndex) clone.classList.add('kg-context-preview-target');
                wrap.appendChild(clone);
            }
            fragment.appendChild(wrap);
            return fragment;
        }
    }

    // Fallback: plain-text rendering for parsers without HTML/sentence markers.
    const fragment = document.createDocumentFragment();
    const para = document.createElement('p');
    para.className = 'paragraph';
    for (let i = start; i <= end; i++) {
        if (i < 0 || i >= sentences.length) continue;
        const span = document.createElement('span');
        span.className = 'sentence';
        span.dataset.index = String(i);
        if (i === targetIndex) span.classList.add('kg-context-preview-target');
        span.textContent = sentences[i] + ' ';
        para.appendChild(span);
    }
    fragment.appendChild(para);
    return fragment;
}

/**
 * @param {Object} opts
 * @param {string} opts.entityName
 * @param {string} [opts.chapterTitle]
 * @param {number} opts.chapterIndex
 * @param {number} opts.sentenceIndex
 * @param {(chapterIndex: number) => Promise<{ html?: string, sentences?: string[] }>} [opts.loadChapter]
 * @param {(chapterIndex: number, sentenceIndex: number) => void} [opts.onJumpToSentence]
 * @param {(text: string, context: string, chapterIndex: number, sentenceIndex: number) => void} [opts.onLookup]
 * @returns {Promise<void>}
 */
export function openContextPreview(opts) {
    const {
        entityName,
        chapterTitle,
        chapterIndex,
        sentenceIndex,
        loadChapter,
        onJumpToSentence,
        onLookup
    } = opts;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active kg-context-preview-overlay';
        const headerSubtitle = chapterTitle
            ? escapeHtml(chapterTitle)
            : `Chapter ${chapterIndex + 1}`;
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
                    <div class="kg-context-preview-body reader-text" data-lookup-context id="kg-context-preview-body">
                        <p class="kg-context-preview-loading">Loading…</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="close">Close</button>
                    ${onJumpToSentence ? '<button type="button" class="btn btn-primary" data-action="jump">Open in reader</button>' : ''}
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const body = overlay.querySelector('#kg-context-preview-body');

        // Attach the shared selection-lookup helper to the modal body so
        // users can highlight a word and tap "look up" exactly like in the
        // reader / quiz views.
        const lookup = onLookup
            ? new LookupSelection({
                container: body,
                onLookup: (text, context) => onLookup(text, context, chapterIndex, sentenceIndex)
            })
            : null;

        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            lookup?.destroy();
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

        const renderFallback = (msg) => {
            body.innerHTML = `<p class="kg-context-preview-error">${escapeHtml(msg)}</p>`;
        };

        if (typeof loadChapter !== 'function') {
            renderFallback('No chapter loader available — open the reader to view the surrounding text.');
            return;
        }

        Promise.resolve()
            .then(() => loadChapter(chapterIndex))
            .then((chapter) => {
                if (settled) return;
                if (!chapter || (!chapter.html && !(chapter.sentences || []).length)) {
                    renderFallback('The chapter has no loadable content.');
                    return;
                }
                const fragment = buildNeighbourhoodFragment(chapter, sentenceIndex);
                body.innerHTML = '';
                body.appendChild(fragment);
            })
            .catch((err) => {
                if (settled) return;
                renderFallback(`Could not load chapter: ${err?.message ?? String(err)}`);
            });
    });
}
