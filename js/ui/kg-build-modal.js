/**
 * KG Build Modal
 * Configures a knowledge-graph build before it runs: chapter range,
 * chunk size/overlap overrides, and whether to re-extract chapters that
 * have already been processed.
 *
 * Exports `promptForKGBuild(opts)` which returns a Promise resolving to
 *   { fromChapter, toChapter, chunkSize, chunkOverlap, force }
 * with 1-based chapter numbers, or null on cancel.
 */

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {Object} opts
 * @param {number} opts.totalChapters         - total chapters in the book (>=1)
 * @param {number} opts.currentChapterIndex   - 0-based index of the current chapter
 * @param {number} [opts.defaultChunkSize]    - default chunk size (sentences)
 * @param {number} [opts.defaultChunkOverlap] - default chunk overlap (sentences)
 * @returns {Promise<{fromChapter:number,toChapter:number,chunkSize:number,chunkOverlap:number,force:boolean}|null>}
 */
export function promptForKGBuild({
    totalChapters,
    currentChapterIndex,
    defaultChunkSize = 6,
    defaultChunkOverlap = 2
} = {}) {
    return new Promise((resolve) => {
        const total = Math.max(1, Number(totalChapters) || 1);
        const current1 = clamp((Number(currentChapterIndex) || 0) + 1, 1, total);

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active kg-build-modal-overlay';
        overlay.innerHTML = `
            <div class="modal kg-build-modal">
                <div class="modal-header">
                    <h2>Build Knowledge Graph</h2>
                </div>
                <div class="modal-content">
                    <p class="form-hint">Extract nodes and edges for a range of chapters. Defaults to the current chapter only.</p>

                    <div class="kg-build-row">
                        <label for="kg-build-from">From chapter</label>
                        <input type="range" id="kg-build-from" min="1" max="${total}" step="1" value="${current1}">
                        <input type="number" id="kg-build-from-value" class="kg-build-value" min="1" max="${total}" step="1" value="${current1}">
                    </div>

                    <div class="kg-build-row">
                        <label for="kg-build-to">To chapter</label>
                        <input type="range" id="kg-build-to" min="1" max="${total}" step="1" value="${current1}">
                        <input type="number" id="kg-build-to-value" class="kg-build-value" min="1" max="${total}" step="1" value="${current1}">
                    </div>

                    <div class="kg-build-row">
                        <label for="kg-build-chunk-size">Chunk size (sentences)</label>
                        <input type="number" id="kg-build-chunk-size" class="kg-build-value" min="1" max="50" step="1" value="${defaultChunkSize}">
                    </div>

                    <div class="kg-build-row">
                        <label for="kg-build-chunk-overlap">Chunk overlap (sentences)</label>
                        <input type="number" id="kg-build-chunk-overlap" class="kg-build-value" min="0" max="49" step="1" value="${defaultChunkOverlap}">
                    </div>

                    <label class="kg-build-check">
                        <input type="checkbox" id="kg-build-force">
                        <span>Re-extract chapters that have already been processed</span>
                    </label>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
                    <button type="button" class="btn btn-primary" data-action="ok">Start</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const fromSlider = overlay.querySelector('#kg-build-from');
        const toSlider = overlay.querySelector('#kg-build-to');
        const fromValue = overlay.querySelector('#kg-build-from-value');
        const toValue = overlay.querySelector('#kg-build-to-value');
        const chunkSizeInput = overlay.querySelector('#kg-build-chunk-size');
        const chunkOverlapInput = overlay.querySelector('#kg-build-chunk-overlap');
        const forceCheckbox = overlay.querySelector('#kg-build-force');
        const okBtn = overlay.querySelector('[data-action="ok"]');
        const cancelBtn = overlay.querySelector('[data-action="cancel"]');

        // Keep slider and numeric input in sync, and auto-clamp the other
        // thumb so From never exceeds To.
        const setFrom = (raw) => {
            const v = clamp(Math.round(Number(raw) || 1), 1, total);
            fromSlider.value = String(v);
            fromValue.value = String(v);
            if (Number(toSlider.value) < v) setTo(v);
        };
        const setTo = (raw) => {
            const v = clamp(Math.round(Number(raw) || 1), 1, total);
            toSlider.value = String(v);
            toValue.value = String(v);
            if (Number(fromSlider.value) > v) setFrom(v);
        };
        fromSlider.addEventListener('input', () => setFrom(fromSlider.value));
        toSlider.addEventListener('input', () => setTo(toSlider.value));
        fromValue.addEventListener('input', () => setFrom(fromValue.value));
        toValue.addEventListener('input', () => setTo(toValue.value));

        // Keep chunk overlap < chunk size to prevent zero-progress chunking.
        const clampOverlap = () => {
            const size = Math.max(1, Math.round(Number(chunkSizeInput.value) || 1));
            const maxOverlap = Math.max(0, size - 1);
            chunkOverlapInput.max = String(maxOverlap);
            if (Number(chunkOverlapInput.value) > maxOverlap) {
                chunkOverlapInput.value = String(maxOverlap);
            }
        };
        chunkSizeInput.addEventListener('input', clampOverlap);
        chunkOverlapInput.addEventListener('input', clampOverlap);
        clampOverlap();

        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const submit = () => {
            const fromChapter = clamp(Math.round(Number(fromSlider.value) || 1), 1, total);
            const toChapter = clamp(Math.round(Number(toSlider.value) || 1), fromChapter, total);
            const chunkSize = Math.max(1, Math.round(Number(chunkSizeInput.value) || defaultChunkSize));
            const chunkOverlap = clamp(
                Math.round(Number(chunkOverlapInput.value) || 0),
                0,
                Math.max(0, chunkSize - 1)
            );
            finish({
                fromChapter,
                toChapter,
                chunkSize,
                chunkOverlap,
                force: !!forceCheckbox.checked
            });
        };

        okBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', () => finish(null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(null);
        });
        const onKey = (e) => {
            if (e.key === 'Escape') finish(null);
            else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') submit();
        };
        document.addEventListener('keydown', onKey);

        setTimeout(() => okBtn.focus(), 0);
    });
}
