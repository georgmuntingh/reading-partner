/**
 * Graph Explorer UI Component
 * Full-screen overlay rendering the per-book knowledge graph with cytoscape.
 *
 * Cytoscape is loaded lazily on first open() so it does not enter the
 * initial bundle — Vite splits the dynamic import into its own chunk.
 *
 * Click handlers:
 *   - tap a node     → show the side panel with type / bloom / aliases / contexts
 *   - tap a context  → open the neighbourhood-preview modal (with an
 *                       "Open in reader" action that delegates to onJumpToSentence)
 *   - tap background → hide the side panel
 */

import { storage } from '../services/storage.js';
import { openContextPreview } from './kg-context-preview-modal.js';
import { openContextMenu } from './kg-context-menu.js';
import { confirmAction } from './confirm-modal.js';
import { mergeNodeMetadata, redirectAndDedupeEdges } from '../services/kg-merge.js';
import { pickMergePrimary } from './kg-merge-primary-picker.js';

// Bloom level → color (Remember = warm green, Create = warm red).
const BLOOM_COLOR = {
    Remember: '#4a8e53',
    Understand: '#6aa83b',
    Apply: '#c4a72a',
    Analyze: '#d97a25',
    Evaluate: '#c95229',
    Create: '#c43c2c'
};

const NODE_TYPE_SHAPE = {
    PERSON: 'ellipse',
    PLACE: 'round-rectangle',
    OBJECT: 'diamond',
    EVENT: 'hexagon',
    CONCEPT: 'octagon',
    OTHER: 'ellipse'
};

export class GraphExplorer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - The #graph-explorer overlay element
     * @param {() => Object} options.getBook - Returns the current book ({ id, ... })
     * @param {() => number} [options.getCurrentChapterIndex] - Returns the
     *   reader's current chapter index. Used as the default position for the
     *   chapter filter slider. Optional — falls back to "All chapters".
     * @param {(chapterIndex: number) => Promise<{ html?: string, sentences?: string[] }>} [options.loadChapter]
     *   Async loader used by the context preview modal to render the
     *   neighbourhood of a clicked sentence with the chapter's full HTML
     *   formatting (images, italics, etc.). Optional — the modal still
     *   opens without it but shows a fallback message.
     * @param {(text: string, context: string, chapterIndex: number, sentenceIndex: number) => void} [options.onLookup]
     *   Invoked when the user selects text inside the preview modal and
     *   taps the "look up" toolbar button. Optional — without it, the
     *   selection toolbar is suppressed.
     * @param {(phrase: string) => Promise<{ definition?: string, translation?: string } | null>} [options.lookupDefinition]
     *   Returns a short definition for a phrase (used to populate the
     *   "Definition" row in the node-details sidebar). Optional.
     * @param {() => number} [options.getWheelSensitivity] - Returns the
     *   user-configured cytoscape wheelSensitivity (mouse-wheel zoom
     *   speed). Read once per `open()`. Defaults to 1.0.
     * @param {(href: string) => void} [options.onInternalLink] - Invoked
     *   when the user clicks an EPUB-internal `<a>` link inside the
     *   context preview modal. The app wires this to its existing
     *   `_handleInternalLink` so chapter-relative hrefs land at the
     *   correct sentence in the reader.
     * @param {(chapterIndex: number, sentenceIndex: number) => void} [options.onJumpToSentence]
     */
    constructor({ container, getBook, getCurrentChapterIndex, loadChapter, onLookup, lookupDefinition, getWheelSensitivity, onInternalLink, onJumpToSentence }) {
        this._container = container;
        this._getBook = getBook;
        this._getCurrentChapterIndex = typeof getCurrentChapterIndex === 'function'
            ? getCurrentChapterIndex
            : () => null;
        this._loadChapter = typeof loadChapter === 'function' ? loadChapter : null;
        this._onLookup = typeof onLookup === 'function' ? onLookup : null;
        this._lookupDefinition = typeof lookupDefinition === 'function' ? lookupDefinition : null;
        this._getWheelSensitivity = typeof getWheelSensitivity === 'function'
            ? getWheelSensitivity
            : () => 1.0;
        this._wheelSensitivity = 1.0;
        this._onInternalLink = typeof onInternalLink === 'function' ? onInternalLink : null;
        // Cache `phrase → definition` so repeatedly clicking the same node
        // doesn't re-hit the LLM. Scoped to the explorer instance.
        this._definitionCache = new Map();
        this._onJumpToSentence = onJumpToSentence;
        this._cy = null;
        this._cytoscape = null;        // Lazy-loaded module
        // Total chapters in the currently-open book. Recomputed on each open().
        this._chapterCount = 0;
        // Per-book in-memory position cache: bookId → Map<nodeId, {x, y}>.
        // Populated on close()/relayout(); consumed on _initCytoscape() so
        // re-opening the explorer preserves the previous layout instead of
        // re-running cose and shuffling everything. Cleared per-book by
        // the Re-layout button. Survives only within the current session
        // (no IndexedDB persistence — by design, a reload starts fresh).
        this._positionCache = new Map();
        // Nodes added via handleLiveNode that haven't been snapped to a
        // connected neighbour yet. Tracked per build so handleLiveEdge can
        // anchor each newly-added node to its first incident edge's other
        // endpoint, producing tight clusters instead of long radial arrows.
        this._anchoredLiveNodes = new Set();
        this._render();
    }

    _render() {
        this._container.innerHTML = `
            <div class="graph-explorer-header">
                <h2>Knowledge Graph</h2>
                <div class="graph-filter-toolbar">
                    <label>
                        <span class="kg-toolbar-name">Chapter</span>
                        <input type="range" id="kg-chapter" min="0" max="0" step="1" value="0" disabled>
                        <input type="text" class="kg-toolbar-value" id="kg-chapter-value" value="All" aria-label="Chapter (type a chapter number or 'All')" autocomplete="off" inputmode="numeric">
                    </label>
                    <label>
                        <span class="kg-toolbar-name">Min connections</span>
                        <input type="range" id="kg-min-degree" min="1" max="10" step="1" value="1">
                        <input type="text" class="kg-toolbar-value" id="kg-min-degree-value" value="1" aria-label="Minimum connections" autocomplete="off" inputmode="numeric">
                    </label>
                    <label>
                        <span class="kg-toolbar-name">Min relevance</span>
                        <input type="range" id="kg-min-relevance" min="0" max="1" step="0.05" value="0.15">
                        <input type="text" class="kg-toolbar-value" id="kg-min-relevance-value" value="0.15" aria-label="Minimum relevance" autocomplete="off" inputmode="decimal">
                    </label>
                </div>
                <button type="button" class="btn btn-secondary graph-relayout-btn" aria-label="Re-layout graph" title="Re-run the force-directed layout from scratch">
                    Re-layout
                </button>
                <button type="button" class="btn btn-secondary graph-clear-highlights-btn hidden" aria-label="Clear highlights">
                    Clear highlights
                </button>
                <button class="btn-icon graph-close-btn" aria-label="Close">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div class="graph-body">
                <div id="cy-canvas" class="cy-canvas"></div>
                <aside id="kg-side-panel" class="kg-side-panel hidden"></aside>
            </div>
            <div id="kg-action-bar" class="kg-action-bar hidden">
                <span class="kg-action-bar-count">0 selected</span>
                <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
                <button type="button" class="btn btn-secondary" data-action="merge" hidden>Merge</button>
                <button type="button" class="btn btn-danger" data-action="delete">Delete</button>
            </div>
            <div id="graph-empty-state" class="graph-empty-state hidden">
                <p>No knowledge graph yet. Open a chapter and click "Build graph" in the reader controls to extract entities and relations.</p>
            </div>
        `;
        this._container.querySelector('.graph-close-btn').addEventListener('click', () => this.close());
        this._container.querySelector('.graph-clear-highlights-btn').addEventListener('click', () => this.clearHighlights());
        this._container.querySelector('.graph-relayout-btn').addEventListener('click', () => this.relayout());

        const degSlider = this._container.querySelector('#kg-min-degree');
        const relSlider = this._container.querySelector('#kg-min-relevance');
        const chSlider = this._container.querySelector('#kg-chapter');
        const degValue = this._container.querySelector('#kg-min-degree-value');
        const relValue = this._container.querySelector('#kg-min-relevance-value');
        const chValue = this._container.querySelector('#kg-chapter-value');

        // Slider → text input. Each text input mirrors its slider as the
        // slider moves so the user always sees the current value.
        degSlider.addEventListener('input', () => {
            degValue.value = degSlider.value;
            this._applyDetailFilter();
        });
        relSlider.addEventListener('input', () => {
            relValue.value = parseFloat(relSlider.value).toFixed(2);
            this._applyDetailFilter();
        });
        chSlider.addEventListener('input', () => {
            chValue.value = this._chapterSliderLabel(chSlider.value);
            this._applyDetailFilter();
        });

        // Text input → slider. Users can click a value and type directly.
        // Committed on Enter or blur; out-of-range values are clamped to
        // the slider's [min, max].
        const commitNumeric = (input, slider, formatter) => {
            const raw = parseFloat(input.value);
            const min = parseFloat(slider.min);
            const max = parseFloat(slider.max);
            const clamped = Number.isFinite(raw)
                ? Math.min(max, Math.max(min, raw))
                : parseFloat(slider.value);
            slider.value = String(clamped);
            input.value = formatter(clamped);
            this._applyDetailFilter();
        };
        const commitInteger = (input, slider) => commitNumeric(input, slider,
            (v) => String(Math.round(v)));
        const commitDecimal = (input, slider) => commitNumeric(input, slider,
            (v) => v.toFixed(2));

        // Wire commit-on-Enter and commit-on-blur for the numeric inputs.
        const wireTextInput = (input, commit) => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
            });
            input.addEventListener('blur', commit);
            // Select on focus so the user can replace easily.
            input.addEventListener('focus', () => input.select());
        };
        wireTextInput(degValue, () => commitInteger(degValue, degSlider));
        wireTextInput(relValue, () => commitDecimal(relValue, relSlider));

        // Chapter input: accepts "All" (or empty) → max, or a 1-based
        // chapter number that maps to slider value (chapterNumber - 1).
        wireTextInput(chValue, () => {
            const max = parseInt(chSlider.max, 10);
            const txt = String(chValue.value).trim().toLowerCase();
            let next;
            if (!txt || txt === 'all') {
                next = max;
            } else {
                const n = parseInt(txt, 10);
                if (!Number.isFinite(n)) {
                    next = parseInt(chSlider.value, 10);
                } else {
                    next = Math.min(max, Math.max(0, n - 1));
                }
            }
            chSlider.value = String(next);
            chValue.value = this._chapterSliderLabel(next);
            this._applyDetailFilter();
        });

        // Mouse-wheel scrubbing — wheel events that originate over a slider
        // adjust its value by `step` and synthesise an `input` event so the
        // existing label + filter logic above runs unchanged. preventDefault
        // is necessary (with passive:false) so the wheel does not scroll the
        // header underneath the slider.
        for (const slider of [degSlider, relSlider, chSlider]) {
            slider.addEventListener('wheel', (e) => {
                if (slider.disabled) return;
                e.preventDefault();
                const step = parseFloat(slider.step) || 1;
                const min = parseFloat(slider.min);
                const max = parseFloat(slider.max);
                const cur = parseFloat(slider.value);
                // Wheel up (deltaY < 0) → increase, matching the "scroll
                // forward to reveal more" mental model.
                const dir = e.deltaY < 0 ? 1 : -1;
                const next = Math.min(max, Math.max(min, cur + dir * step));
                if (next !== cur) {
                    slider.value = String(next);
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, { passive: false });
        }

        // Touch action bar (selection-mode only). Desktop uses the right-
        // click context menu instead.
        const bar = this._container.querySelector('#kg-action-bar');
        bar.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            this._exitSelectionMode();
        });
        bar.querySelector('[data-action="delete"]').addEventListener('click', () => {
            this._deleteSelected();
        });
        bar.querySelector('[data-action="merge"]').addEventListener('click', async () => {
            const selected = this._cy ? this._cy.nodes(':selected') : null;
            if (!selected || selected.length < 2) return;
            const candidates = selected.map((n) => ({
                id: n.id(),
                name: n.data('raw')?.canonicalName || n.id()
            }));
            const primaryId = await pickMergePrimary({ candidates });
            if (!primaryId) return;
            const primary = this._cy.getElementById(primaryId);
            if (!primary || primary.empty()) return;
            this._mergeSelected(primary);
        });
    }

    /**
     * The chapter slider has chapterCount + 1 positions: 0..chapterCount-1
     * select a single chapter, and the final position (chapterCount) is the
     * "All chapters" sentinel that disables the chapter gate.
     */
    _chapterSliderLabel(rawValue) {
        const v = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(v) || v >= this._chapterCount) return 'All';
        // The label doubles as the value displayed in the editable text
        // input, so we keep it minimal — a bare 1-based chapter number —
        // and let the input also accept that form when the user types.
        return String(v + 1);
    }

    /**
     * Reconfigure the chapter slider's range and default position based on
     * the currently-open book. Called from open() — the book may not be
     * available at construction time.
     */
    _configureChapterSlider(book) {
        const chSlider = this._container.querySelector('#kg-chapter');
        const chValue = this._container.querySelector('#kg-chapter-value');
        const count = Array.isArray(book?.chapters) ? book.chapters.length : 0;
        this._chapterCount = count;

        if (count <= 0) {
            chSlider.min = '0';
            chSlider.max = '0';
            chSlider.value = '0';
            chSlider.disabled = true;
            chValue.value = 'All';
            chValue.disabled = true;
            return;
        }

        chSlider.disabled = false;
        chValue.disabled = false;
        chSlider.min = '0';
        chSlider.max = String(count);    // last slot = "All"
        // Default to the "All chapters" sentinel so users see the whole
        // graph by default — the live-build flow especially needs this,
        // since pinning to the reader's current chapter would hide
        // pre-existing nodes from other chapters during a build.
        const defaultPos = count;
        chSlider.value = String(defaultPos);
        chValue.value = this._chapterSliderLabel(defaultPos);
    }

    /**
     * Open the overlay, load nodes/edges from storage, and render.
     */
    async open() {
        this._container.classList.remove('hidden');

        // Refresh settings-derived knobs at open time so changes to the
        // wheel-sensitivity slider take effect on next open without
        // requiring a page reload.
        const ws = Number(this._getWheelSensitivity());
        this._wheelSensitivity = Number.isFinite(ws) && ws > 0 ? ws : 1.0;

        if (!this._cytoscape) {
            const mod = await import('cytoscape');
            this._cytoscape = mod.default ?? mod;
        }
        const cytoscape = this._cytoscape;

        const book = this._getBook();
        if (!book?.id) {
            this._showEmptyState('Open a book to view its knowledge graph.');
            return;
        }

        // Reconfigure the chapter slider for this book and seed it with the
        // reader's current chapter as the default position.
        this._configureChapterSlider(book);

        const [nodes, edges] = await Promise.all([
            storage.getKGNodesForBook(book.id),
            storage.getKGEdgesForBook(book.id)
        ]);

        if (nodes.length === 0) {
            this._showEmptyState();
            return;
        }
        this._hideEmptyState();

        const elements = [
            ...nodes.map((n) => ({
                data: {
                    id: n.id,
                    label: n.canonicalName,
                    type: n.type,
                    bloom: n.bloom,
                    // Legacy nodes lack a relevanceScore — coerce to null
                    // so the filter can recognise them and exempt them.
                    relevanceScore: typeof n.relevanceScore === 'number' ? n.relevanceScore : null,
                    chapterSet: this._chaptersOf(n),
                    raw: n
                }
            })),
            ...edges.map((e) => ({
                data: {
                    id: e.id,
                    source: e.sourceId,
                    target: e.targetId,
                    label: e.relation,
                    chapterSet: this._chaptersOf(e),
                    raw: e
                }
            }))
        ];

        this._initCytoscape(elements);
    }

    /**
     * Set up the cytoscape instance with the supplied elements payload
     * (may be empty). Tears down any prior instance, applies the full
     * stylesheet, runs the cose layout, and wires every node / background
     * tap / right-click handler the explorer needs. Called from open()
     * with a storage-derived element list, and from _bootstrapEmptyCytoscape
     * during live builds against a previously-empty graph.
     */
    _initCytoscape(elements) {
        const cytoscape = this._cytoscape;
        if (this._cy) {
            this._cy.destroy();
            this._cy = null;
        }

        // Apply any cached positions to the element payload so we can use
        // the cheap `preset` layout when every node already has a known
        // position. Falls back to cose when even one node is missing,
        // which naturally covers the first-build case and any case where
        // a node was added since the cache was captured.
        const bookId = this._getBook()?.id;
        const cache = bookId ? this._positionCache.get(bookId) : null;
        let allPositioned = elements.length > 0 && !!cache;
        if (cache) {
            for (const el of elements) {
                if (el.data?.source) continue;   // edges don't carry positions
                const pos = cache.get(el.data.id);
                if (pos) el.position = { x: pos.x, y: pos.y };
                else allPositioned = false;
            }
        }
        const layout = allPositioned
            ? { name: 'preset' }
            : { name: 'cose', animate: false, padding: 30 };

        this._cy = cytoscape({
            container: this._container.querySelector('#cy-canvas'),
            elements,
            style: [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(label)',
                        'font-size': 12,
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'color': '#fff',
                        'text-outline-width': 2,
                        'text-outline-color': '#222',
                        'background-color': (ele) => BLOOM_COLOR[ele.data('bloom')] || '#888',
                        'shape': (ele) => NODE_TYPE_SHAPE[ele.data('type')] || 'ellipse',
                        'width': 'mapData(degree, 0, 20, 30, 70)',
                        'height': 'mapData(degree, 0, 20, 30, 70)'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'label': 'data(label)',
                        'font-size': 9,
                        'curve-style': 'bezier',
                        'target-arrow-shape': 'triangle',
                        'line-color': '#888',
                        'target-arrow-color': '#888',
                        'color': '#444',
                        'text-rotation': 'autorotate',
                        'text-margin-y': -8
                    }
                },
                {
                    selector: ':selected',
                    style: {
                        'background-color': '#fa3',
                        'line-color': '#fa3',
                        'target-arrow-color': '#fa3',
                        // Multi-select is a primary action surface now —
                        // make selected nodes obviously distinct from the
                        // crowd, not just slightly orange.
                        'border-width': 3,
                        'border-color': '#c45a00'
                    }
                },
                {
                    selector: '.kg-hidden',
                    style: { display: 'none' }
                },
                // Live-build classes: pre-existing nodes/edges fade so the
                // newly-arriving ones pop. Both classes survive until the
                // user clicks "Clear highlights".
                {
                    selector: '.kg-faded',
                    style: { 'opacity': 0.22 }
                },
                {
                    selector: 'node.kg-newly-added',
                    style: {
                        'border-width': 4,
                        'border-color': '#ffd24a',
                        'border-opacity': 1,
                        'overlay-color': '#ffd24a',
                        'overlay-opacity': 0.25,
                        'overlay-padding': 6
                    }
                },
                {
                    selector: 'edge.kg-newly-added',
                    style: {
                        'line-color': '#ffd24a',
                        'target-arrow-color': '#ffd24a',
                        'width': 3
                    }
                }
            ],
            layout,
            minZoom: 0.2,
            maxZoom: 3,
            // Pulled from settings so users can tune zoom speed to their
            // hardware (mice vs. trackpads vary wildly). 1.0 is cytoscape's
            // documented default and notably snappier than our earlier 0.3.
            wheelSensitivity: this._wheelSensitivity,
            // Per design: ctrl/cmd-click toggles selection; no box-select
            // drag. Panning explicitly stays on so a future cytoscape default
            // flip cannot turn the canvas into a giant box-select region.
            selectionType: 'additive',
            boxSelectionEnabled: false,
            userPanningEnabled: true
        });

        // Single tap → side panel; double tap opens the preview modal at the
        // node's first-seen sentence. Long press on touch enters selection
        // mode so the user can multi-select and act via the bottom action
        // bar (mirroring the desktop ctrl-click + right-click flow).
        const LONG_PRESS_MS = 500;
        let lastTapAt = 0;
        let lastTapId = null;
        let longPressTimer = null;
        let longPressFired = false;
        const cancelLongPress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };
        this._cy.on('tap', 'node', (evt) => {
            // Suppress the tap that always trails a long-press release.
            if (longPressFired) {
                longPressFired = false;
                return;
            }
            const now = Date.now();
            const node = evt.target.data('raw');
            const id = evt.target.id();
            // Selection mode (touch): taps toggle the selection rather than
            // opening the side panel.
            if (this._selectionMode) {
                evt.target.selected()
                    ? evt.target.unselect()
                    : evt.target.select();
                this._refreshActionBar();
                return;
            }
            // Double-tap detection: same node, second tap within 350 ms.
            if (lastTapId === id && now - lastTapAt < 350) {
                cancelLongPress();
                lastTapAt = 0; lastTapId = null;
                this._openFirstSeenPreview(node);
                return;
            }
            lastTapAt = now;
            lastTapId = id;
            this._showNodeDetails(node);
        });
        // Long press on touch enters selection mode.
        this._cy.on('tapstart', 'node', (evt) => {
            cancelLongPress();
            longPressFired = false;
            const targetNode = evt.target;
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                longPressFired = true;
                targetNode.select();
                this._enterSelectionMode();
            }, LONG_PRESS_MS);
        });
        this._cy.on('tapend tapdrag', 'node', cancelLongPress);

        // Right-click → context menu. Right-clicking an unselected node first
        // sets the selection to just that node (file-manager convention).
        this._cy.on('cxttap', 'node', (evt) => {
            const node = evt.target;
            if (!node.selected()) {
                this._cy.elements().unselect();
                node.select();
            }
            // The renderedPosition is canvas-relative; the cytoscape
            // container is `position: absolute` inside graph-body, which is
            // itself inside the fixed-position graph-explorer overlay — so
            // renderedPosition converted to client coordinates via the
            // container's bounding rect is the correct anchor for a
            // `position: fixed` menu.
            const containerRect = this._container
                .querySelector('#cy-canvas').getBoundingClientRect();
            const rp = evt.renderedPosition || evt.position || { x: 0, y: 0 };
            this._openContextMenu({
                x: containerRect.left + rp.x,
                y: containerRect.top + rp.y
            }, node);
        });

        this._cy.on('tap', (evt) => {
            if (evt.target === this._cy) {
                this._hideSide();
                // Plain background tap clears the selection (per design).
                // In selection mode this also exits selection mode.
                this._cy.elements().unselect();
                if (this._selectionMode) this._exitSelectionMode();
            }
        });

        // Apply the initial detail filter so the default UI state (min
        // relevance 0.15, min degree 1) takes effect on first render.
        this._applyDetailFilter();
    }

    _enterSelectionMode() {
        if (this._selectionMode) {
            this._refreshActionBar();
            return;
        }
        this._selectionMode = true;
        this._container.classList.add('is-selection-mode');
        this._container.querySelector('#kg-action-bar').classList.remove('hidden');
        this._hideSide();
        this._refreshActionBar();
    }

    _exitSelectionMode() {
        this._selectionMode = false;
        this._container.classList.remove('is-selection-mode');
        this._container.querySelector('#kg-action-bar').classList.add('hidden');
        if (this._cy) this._cy.elements().unselect();
    }

    _refreshActionBar() {
        const bar = this._container.querySelector('#kg-action-bar');
        if (!bar || !this._cy) return;
        const count = this._cy.nodes(':selected').length;
        bar.querySelector('.kg-action-bar-count').textContent =
            `${count} selected`;
        bar.querySelector('[data-action="delete"]').disabled = count === 0;
        bar.querySelector('[data-action="merge"]').hidden = count < 2;
    }

    /**
     * Desktop right-click handler — builds the menu items and dispatches to
     * the appropriate handler. `primaryNode` is the cytoscape node element
     * the user right-clicked on (the Primary for a Merge action).
     */
    async _openContextMenu({ x, y }, primaryNode) {
        const selected = this._cy.nodes(':selected');
        const items = [{ id: 'delete', label: 'Delete', danger: true }];
        if (selected.length >= 2) {
            const name = primaryNode.data('raw')?.canonicalName
                || primaryNode.id();
            items.unshift({ id: 'merge', label: `Merge into ${name}` });
        }
        const picked = await openContextMenu({ x, y, items });
        if (picked === 'delete') this._deleteSelected();
        else if (picked === 'merge') this._mergeSelected(primaryNode);
    }

    /**
     * Delete every selected node. Cascades to incident edges (an edge whose
     * source/target points at a deleted node is meaningless), wrapped in a
     * single atomic transaction so a partial failure leaves the graph
     * unchanged on disk.
     */
    async _deleteSelected() {
        if (!this._cy) return;
        const selectedNodes = this._cy.nodes(':selected');
        const count = selectedNodes.length;
        if (count === 0) return;
        const nodeIds = selectedNodes.map((n) => n.id());
        const edgeIds = selectedNodes.connectedEdges().map((e) => e.id());

        const ok = await confirmAction({
            title: count === 1 ? 'Delete node?' : `Delete ${count} nodes?`,
            message: count === 1
                ? `"${selectedNodes[0].data('raw')?.canonicalName}" and its ${edgeIds.length} connection(s) will be removed.`
                : `${count} nodes and ${edgeIds.length} incident connection(s) will be removed.`,
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;

        await storage.applyDeleteTransaction({
            deletedNodeIds: nodeIds,
            deletedEdgeIds: edgeIds
        });
        this._cy.remove(selectedNodes.union(selectedNodes.connectedEdges()));
        this._exitSelectionMode();
        this._applyDetailFilter();
    }

    /**
     * Merge every other selected node into the right-clicked `primaryNode`.
     * Pure metadata merge is delegated to kg-merge.js; persistence is a
     * single atomic transaction over both KG stores.
     */
    async _mergeSelected(primaryNode) {
        if (!this._cy) return;
        const selected = this._cy.nodes(':selected');
        if (selected.length < 2) return;
        const primaryRecord = primaryNode.data('raw');
        const secondaryNodes = selected.difference(primaryNode);
        const secondaryRecords = secondaryNodes.map((n) => n.data('raw')).filter(Boolean);
        if (secondaryRecords.length === 0) return;

        const ok = await confirmAction({
            title: `Merge ${secondaryRecords.length} node(s) into "${primaryRecord.canonicalName}"?`,
            message: 'Aliases and contexts will be folded into the survivor. Connections will be redirected; duplicates will be deduplicated.',
            confirmLabel: 'Merge',
            danger: true
        });
        if (!ok) return;

        const book = this._getBook();
        const allEdges = book?.id
            ? await storage.getKGEdgesForBook(book.id)
            : [];
        const secondaryIdSet = new Set(secondaryRecords.map((s) => s.id));
        const updatedNode = mergeNodeMetadata(primaryRecord, secondaryRecords);
        const { saves: savedEdges, deletes: deletedEdgeIds } =
            redirectAndDedupeEdges(allEdges, primaryRecord.id, secondaryIdSet);

        await storage.applyMergeTransaction({
            updatedNode,
            deletedNodeIds: secondaryRecords.map((s) => s.id),
            savedEdges,
            deletedEdgeIds
        });

        // Update cytoscape in-place to preserve node positions. Cytoscape's
        // edge `source`/`target` are immutable once an edge is added, so
        // any edge whose endpoint changed must be removed + re-added rather
        // than data-patched.
        this._cy.batch(() => {
            // 1. Drop every Secondary node (and cytoscape cascades their
            //    incident edges automatically) plus any explicitly deleted
            //    edges still hanging on the Primary.
            this._cy.remove(secondaryNodes);
            for (const id of deletedEdgeIds) {
                const e = this._cy.getElementById(id);
                if (e && !e.empty()) this._cy.remove(e);
            }

            // 2. Refresh the surviving Primary's data (label / aliases /
            //    contexts / chapterSet). Node `data` is freely mutable.
            const chapterSet = new Set();
            for (const c of updatedNode.contexts || []) {
                if (Number.isInteger(c.chapterIndex)) chapterSet.add(c.chapterIndex);
            }
            primaryNode.data({
                label: updatedNode.canonicalName,
                raw: updatedNode,
                chapterSet
            });

            // 3. Re-render the saved edges. For each, if the cy edge with
            //    that id still exists, only the contexts changed — patch
            //    data in place. Otherwise the endpoints changed (or the edge
            //    was absorbed under a different id pair) — remove the old
            //    representation if any and re-add fresh.
            for (const edge of savedEdges) {
                const chSet = new Set();
                for (const c of edge.contexts || []) {
                    if (Number.isInteger(c.chapterIndex)) chSet.add(c.chapterIndex);
                }
                const existing = this._cy.getElementById(edge.id);
                const endpointsMatch = !existing.empty()
                    && existing.data('source') === edge.sourceId
                    && existing.data('target') === edge.targetId;
                if (endpointsMatch) {
                    existing.data({
                        raw: edge,
                        label: edge.relation,
                        chapterSet: chSet
                    });
                } else {
                    if (!existing.empty()) this._cy.remove(existing);
                    this._cy.add({
                        group: 'edges',
                        data: {
                            id: edge.id,
                            source: edge.sourceId,
                            target: edge.targetId,
                            label: edge.relation,
                            chapterSet: chSet,
                            raw: edge
                        }
                    });
                }
            }
        });

        this._exitSelectionMode();
        this._applyDetailFilter();
    }

    _openFirstSeenPreview(node) {
        const loc = this._firstSeenLocation(node);
        if (!loc) return;
        this._openContextPreview(node, loc.chapterIndex, loc.sentenceIndex);
    }

    /**
     * Fetch a short definition for the node's canonical name via the
     * supplied lookup callback and render it inline in the side panel.
     * Cached per-explorer-instance so the LLM isn't hit twice for the same
     * concept. The DOM lookup uses `data-token` so a stale fetch landing
     * after the user clicked a different node never overwrites the active
     * panel.
     */
    async _populateDefinition(node, panel) {
        // Held by-reference rather than re-resolved through a data-attribute
        // because the canonicalName may contain markup-sensitive characters
        // that survive `innerHTML` round-tripping (browsers normalise
        // `&lt;` back to `<` in attribute values when reading innerHTML).
        const target = panel.querySelector('.kg-side-definition .kg-side-definition-body');
        if (!target) return;

        // Fast path: new nodes carry their definition on the record itself
        // (prefetched at extraction time by KGController). Render and stop.
        if (node.definition) {
            this._renderDefinition(target, node.definition);
            return;
        }

        // Tag this fetch with the node being shown so a stale resolver that
        // lands after the user clicked a different node never overwrites
        // the active panel.
        this._activeDefinitionToken = node.canonicalName;
        const token = node.canonicalName;
        const isStillActive = () =>
            this._activeDefinitionToken === token && panel.contains(target);

        if (!this._lookupDefinition) {
            target.textContent = 'Lookup unavailable.';
            return;
        }

        const cached = this._definitionCache.get(token);
        if (cached !== undefined) {
            this._renderDefinition(target, cached);
            return;
        }
        try {
            const result = await this._lookupDefinition(token);
            this._definitionCache.set(token, result);
            if (!isStillActive()) return;
            this._renderDefinition(target, result);
        } catch (err) {
            if (isStillActive()) {
                target.textContent = `Lookup failed: ${err?.message ?? String(err)}`;
            }
        }
    }

    _renderDefinition(targetEl, result) {
        if (!result) {
            targetEl.textContent = 'No definition available.';
            return;
        }
        // Accept both shapes:
        //   - plain string (new — produced by the extraction LLM call)
        //   - `{ definition, translation, ... }` object from lookupService
        let text;
        if (typeof result === 'string') {
            text = result.trim();
        } else {
            const def = String(result.definition || '').trim();
            const trans = String(result.translation || '').trim();
            text = def || trans;
        }
        targetEl.textContent = text || 'No definition available.';
    }

    /**
     * Hide nodes whose degree or relevance score falls below the toolbar
     * thresholds, then hide every edge incident to a hidden node. Uses
     * Cytoscape's native selectors (no per-edge iteration) so this stays
     * snappy on dense graphs.
     */
    _applyDetailFilter() {
        if (!this._cy || typeof this._cy.batch !== 'function') return;
        const degEl = this._container.querySelector('#kg-min-degree');
        const relEl = this._container.querySelector('#kg-min-relevance');
        const chEl = this._container.querySelector('#kg-chapter');
        const minDeg = Number.parseInt(degEl?.value ?? '1', 10) || 1;
        const minRel = Number.parseFloat(relEl?.value ?? '0') || 0;

        const chRaw = Number.parseInt(chEl?.value ?? '0', 10);
        // Chapter slider's last position is the "All chapters" sentinel —
        // when active the chapter gate is a no-op.
        const chapterAll = !chEl || !this._chapterCount || chRaw >= this._chapterCount;
        const chapterIndex = chRaw;

        // Relevance + chapter are "universal" gates that apply to every
        // visible node. The min-degree gate is different: it identifies
        // ANCHOR nodes (well-connected enough to be of interest), and
        // anchors pull in their direct neighbours so the user can see the
        // full neighbourhood of each well-connected node — even neighbours
        // that don't individually meet the degree threshold.
        const passesUniversal = (n) => {
            // Live-build exemption: newly-arrived nodes are always visible
            // during a build so the user can see them appear regardless of
            // the current min-degree / min-relevance threshold. The
            // exemption clears when the user clicks "Clear highlights".
            if (typeof n.hasClass === 'function' && n.hasClass('kg-newly-added')) return true;
            const score = n.data('relevanceScore');
            const passesRel = score == null || score >= minRel;
            const chSet = n.data('chapterSet');
            const passesCh = chapterAll || !chSet || chSet.has(chapterIndex);
            return passesRel && passesCh;
        };

        this._cy.batch(() => {
            const allNodes = this._cy.nodes();
            // Anchors must pass universal gates AND have ≥ minDeg edges.
            // Degree is structural (computed on the full graph), so the
            // anchor set stays stable as chapter/relevance change.
            const anchors = allNodes.filter((n) =>
                passesUniversal(n) && n.degree() >= minDeg
            );
            // Visible = anchors ∪ (anchors' neighbours that also pass
            // the universal gates). Neighbours below the degree threshold
            // are intentionally kept so anchors are shown together with
            // ALL their connections — the user's expectation.
            let visible = anchors;
            if (anchors.length > 0) {
                visible = anchors.union(
                    anchors.openNeighborhood('node').filter(passesUniversal)
                );
            }
            allNodes.removeClass('kg-hidden');
            allNodes.difference(visible).addClass('kg-hidden');

            // Edge pass: hide edges whose endpoints are hidden. Use the
            // native selector to avoid per-edge iteration on dense graphs.
            this._cy.edges().removeClass('kg-hidden');
            this._cy.nodes('.kg-hidden').connectedEdges().addClass('kg-hidden');
            // Additionally hide edges that don't themselves appear in the
            // selected chapter — both endpoints can be visible (because
            // they appear in *other* chapters too) yet the relation only
            // exists in a different chapter.
            if (!chapterAll) {
                this._cy.edges().forEach((e) => {
                    const chSet = e.data('chapterSet');
                    if (chSet && !chSet.has(chapterIndex)) e.addClass('kg-hidden');
                });
            }
        });
    }

    _showEmptyState(msg) {
        const empty = this._container.querySelector('#graph-empty-state');
        if (msg) empty.querySelector('p').textContent = msg;
        empty.classList.remove('hidden');
        this._container.querySelector('.graph-body').classList.add('hidden');
    }

    _hideEmptyState() {
        this._container.querySelector('#graph-empty-state').classList.add('hidden');
        this._container.querySelector('.graph-body').classList.remove('hidden');
    }

    /**
     * Group a sorted list of sentence indices into runs of "close" mentions
     * so the side panel can render one link per run instead of N links to
     * overlapping previews. Two indices are in the same run when their gap
     * is ≤ `maxGap`. The default of 2 matches the preview modal's
     * neighbourhood radius — within that distance, the ±2 windows overlap
     * and the second link is just visual noise.
     *
     * @param {number[]} indices
     * @param {number} [maxGap=2]
     * @returns {{ start: number, end: number, pivot: number }[]}
     *   `pivot` is the sentence we link to (the middle of the run so the
     *   preview window covers as much of the run as possible).
     */
    _groupAdjacentSentences(indices, maxGap = 2) {
        const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);
        const groups = [];
        let cur = null;
        for (const si of sorted) {
            if (cur && si - cur.end <= maxGap) {
                cur.end = si;
            } else {
                if (cur) cur.pivot = Math.floor((cur.start + cur.end) / 2);
                cur = { start: si, end: si };
                groups.push(cur);
            }
        }
        if (cur) cur.pivot = Math.floor((cur.start + cur.end) / 2);
        return groups;
    }

    _showNodeDetails(node) {
        const panel = this._container.querySelector('#kg-side-panel');
        const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
        const aliasLine = node.aliases?.length
            ? node.aliases.map(escape).join(', ')
            : '—';
        // Build a flat list of items, but first collapse runs of nearby
        // sentence mentions within each chapter to a single representative
        // link. Three consecutive sentences that all mention the concept
        // would otherwise produce three identical-looking previews.
        const contextItems = (node.contexts || []).flatMap((c) => {
            const groups = this._groupAdjacentSentences(c.sentenceIndices || []);
            return groups.slice(0, 5).map((g) => ({
                chapterIndex: c.chapterIndex,
                sentenceIndex: g.pivot,
                start: g.start,
                end: g.end
            }));
        });
        const formatItem = (c) => {
            if (c.start === c.end) {
                return `Chapter ${c.chapterIndex + 1}, sentence ${c.start + 1}`;
            }
            return `Chapter ${c.chapterIndex + 1}, sentences ${c.start + 1}–${c.end + 1}`;
        };
        panel.innerHTML = `
            <h3>${escape(node.canonicalName)}</h3>
            <p><strong>Type:</strong> ${escape(node.type)}</p>
            <p><strong>Bloom level:</strong> ${escape(node.bloom)}</p>
            <p><strong>Aliases:</strong> ${aliasLine}</p>
            <p class="kg-side-definition">
                <strong>Definition:</strong>
                <span class="kg-side-definition-body">Loading…</span>
            </p>
            <h4>Context</h4>
            <ul class="kg-context-list">
                ${contextItems.length === 0
                    ? '<li>No context recorded.</li>'
                    : contextItems.map((c) => `
                        <li><a href="#" data-ch="${c.chapterIndex}" data-sent="${c.sentenceIndex}">
                            ${escape(formatItem(c))}
                        </a></li>
                    `).join('')}
            </ul>
        `;
        panel.classList.remove('hidden');

        for (const link of panel.querySelectorAll('a[data-ch]')) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const ch = Number.parseInt(link.dataset.ch, 10);
                const sent = Number.parseInt(link.dataset.sent, 10);
                this._openContextPreview(node, ch, sent);
            });
        }

        this._populateDefinition(node, panel);
    }

    _openContextPreview(node, chapterIndex, sentenceIndex) {
        const book = this._getBook();
        const chapter = book?.chapters?.[chapterIndex];
        openContextPreview({
            entityName: node.canonicalName,
            chapterTitle: chapter?.title,
            chapterIndex,
            sentenceIndex,
            loadChapter: this._loadChapter,
            onLookup: this._onLookup,
            // The reader-jump action stays available from inside the modal so
            // the user can opt into the existing behaviour rather than losing
            // it entirely.
            onJumpToSentence: this._onJumpToSentence
                ? (ch, sent) => {
                    this._onJumpToSentence(ch, sent);
                    this.close();
                }
                : null,
            onInternalLink: this._onInternalLink
                ? (href) => {
                    this._onInternalLink(href);
                    this.close();
                }
                : null
        });
    }

    /**
     * Resolve the (chapterIndex, sentenceIndex) that first introduced this
     * concept into the graph. Used by the double-tap / long-press handlers
     * to open the preview at the canonical first mention.
     *
     * `firstSeenChapter` is set at creation. Inside that chapter's context
     * the smallest sentenceIndex is the canonical first mention. If
     * firstSeenChapter is missing (legacy node) we fall back to the
     * lexicographically-first (chapterIndex, sentenceIndex) pair.
     *
     * @returns {{ chapterIndex: number, sentenceIndex: number } | null}
     */
    _firstSeenLocation(node) {
        if (!node) return null;
        const contexts = Array.isArray(node.contexts) ? node.contexts : [];
        if (contexts.length === 0) return null;

        const fc = Number.isInteger(node.firstSeenChapter) ? node.firstSeenChapter : null;
        const ctx = (fc !== null && contexts.find((c) => c.chapterIndex === fc))
            || contexts.slice().sort((a, b) => a.chapterIndex - b.chapterIndex)[0];
        if (!ctx) return null;

        const sentences = Array.isArray(ctx.sentenceIndices) ? ctx.sentenceIndices : [];
        if (sentences.length === 0) return null;
        const minSentence = Math.min(...sentences);
        return { chapterIndex: ctx.chapterIndex, sentenceIndex: minSentence };
    }

    _hideSide() {
        this._container.querySelector('#kg-side-panel').classList.add('hidden');
    }

    /**
     * Snapshot the current node + edge set and visually fade every one of
     * them so that nodes/edges added during the upcoming build via
     * {@link handleLiveNode} and {@link handleLiveEdge} stand out.
     *
     * Idempotent — called at the start of every build, even one that opens
     * a fresh explorer instance. If the book has zero nodes yet (empty
     * graph for chapter 1's first build) we bootstrap an empty cytoscape
     * so handleLiveNode has somewhere to add to.
     */
    async beginLiveBuild() {
        // Make sure the overlay is visible — the app auto-opens the
        // explorer on build, but beginLiveBuild() is also safe to call
        // when the user already had it open.
        this._container.classList.remove('hidden');
        if (!this._cy) {
            // open() showed the empty state and skipped cytoscape init.
            // Bootstrap an empty cytoscape so the live additions have a
            // canvas to land on, and hide the empty state.
            await this._bootstrapEmptyCytoscape();
        }
        if (!this._cy) return;
        this._cy.elements().addClass('kg-faded');
        this._highlightingActive = true;
        this._showClearHighlightsButton(true);
        // Reset the per-build anchor tracker. Without this, two live
        // builds in a row would leave stale ids and skip snapping.
        this._anchoredLiveNodes = new Set();
    }

    /**
     * Lazy-bootstrap a zero-element cytoscape instance. Used when the user
     * triggers a build on a book that has no graph yet — open() takes the
     * empty-state branch and skips cytoscape; live additions still need
     * somewhere to render.
     */
    async _bootstrapEmptyCytoscape() {
        if (this._cy) return;
        if (!this._cytoscape) {
            const mod = await import('cytoscape');
            this._cytoscape = mod.default ?? mod;
        }
        const book = this._getBook();
        if (book) this._configureChapterSlider(book);
        this._hideEmptyState();
        this._initCytoscape([]);
    }

    /**
     * Called by the KG controller for every freshly-resolved node. Adds it
     * to cytoscape with the `.kg-newly-added` class, placed near a
     * connected existing neighbour if any, otherwise near a random
     * non-faded anchor or the viewport centre.
     *
     * Silently no-ops if the explorer isn't open (controller fires the
     * callback regardless; the explorer just ignores them).
     */
    handleLiveNode(node) {
        if (!this._cy || !node?.id) return;
        // If a node with this id is already in cy (re-resolve after a
        // merge, racy duplicate, etc.) just upgrade its data + class.
        const existing = this._cy.getElementById(node.id);
        if (!existing.empty()) {
            existing.data({
                raw: node,
                label: node.canonicalName,
                relevanceScore: typeof node.relevanceScore === 'number'
                    ? node.relevanceScore : null,
                chapterSet: this._chaptersOf(node)
            });
            existing.removeClass('kg-faded').addClass('kg-newly-added');
            return;
        }
        const position = this._pickLivePosition();
        this._cy.add({
            group: 'nodes',
            data: {
                id: node.id,
                label: node.canonicalName,
                type: node.type,
                bloom: node.bloom,
                relevanceScore: typeof node.relevanceScore === 'number'
                    ? node.relevanceScore : null,
                chapterSet: this._chaptersOf(node),
                raw: node
            },
            position,
            classes: 'kg-newly-added'
        });
        this._highlightingActive = true;
        this._showClearHighlightsButton(true);
    }

    /**
     * Called by the KG controller for every freshly-resolved edge. Adds it
     * with the `.kg-newly-added` class so it pulses out against the faded
     * background. If either endpoint isn't in cy yet (extremely rare race
     * — the controller resolves entities before relations within a chunk),
     * the edge is dropped; it will appear correctly on the next open().
     */
    handleLiveEdge(edge) {
        if (!this._cy || !edge?.id) return;
        const existing = this._cy.getElementById(edge.id);
        if (!existing.empty()) {
            existing.data({
                raw: edge,
                label: edge.relation,
                chapterSet: this._chaptersOf(edge)
            });
            existing.removeClass('kg-faded').addClass('kg-newly-added');
            return;
        }
        const src = this._cy.getElementById(edge.sourceId);
        const tgt = this._cy.getElementById(edge.targetId);
        if (src.empty() || tgt.empty()) return;

        // Snap a newly-added endpoint to its first connected neighbour so
        // we don't end up with very long arrows from a node parked at a
        // random faded anchor's position. Each newly-added node is
        // anchored on its first incident edge only — subsequent edges
        // don't re-snap it, leaving the batch-settle layout to refine.
        const snapTo = (movingNode, anchorNode) => {
            if (!movingNode.hasClass('kg-newly-added')) return false;
            if (this._anchoredLiveNodes.has(movingNode.id())) return false;
            const ap = anchorNode.position();
            const jitter = () => (Math.random() - 0.5) * 30;
            movingNode.position({ x: ap.x + jitter(), y: ap.y + jitter() });
            this._anchoredLiveNodes.add(movingNode.id());
            return true;
        };
        // Try snapping source first; only snap target if we didn't move
        // source (a single edge can only justify one snap to avoid the
        // both-endpoints-newly-added case collapsing to a single point).
        if (!snapTo(src, tgt)) snapTo(tgt, src);

        this._cy.add({
            group: 'edges',
            data: {
                id: edge.id,
                source: edge.sourceId,
                target: edge.targetId,
                label: edge.relation,
                chapterSet: this._chaptersOf(edge),
                raw: edge
            },
            classes: 'kg-newly-added'
        });
        this._highlightingActive = true;
        this._showClearHighlightsButton(true);
    }

    /**
     * Called by the KG controller at the end of every chunk-batch (one
     * full LLM round-trip's worth of nodes/edges). Runs a small cose
     * pass restricted to the newly-added subgraph so positions settle
     * naturally between batches — existing nodes are locked, so the
     * user's mental map of the rest of the graph doesn't shift.
     */
    handleBatchComplete() {
        if (!this._cy) return;
        const newNodes = this._cy.nodes('.kg-newly-added');
        if (newNodes.length === 0) return;
        const newSubgraph = newNodes.union(newNodes.connectedEdges());
        if (newSubgraph.length === 0) return;
        const others = this._cy.nodes().difference(newNodes);
        try {
            if (typeof others.lock === 'function') others.lock();
            const layout = newSubgraph.layout({
                name: 'cose',
                animate: false,
                fit: false,
                randomize: false,
                padding: 30
            });
            // cytoscape's layout API is synchronous in our test mocks but
            // real cose runs asynchronously. Don't await — we want the
            // controller to move on to the next batch immediately.
            if (layout && typeof layout.run === 'function') layout.run();
        } finally {
            if (typeof others.unlock === 'function') others.unlock();
        }
    }

    /**
     * Called by the app after buildChapterGraph() resolves (either way:
     * success or error). The fade/highlight classes stay on per design
     * ("Keep until explicitly cleared") so the user can study what just
     * changed; clicking the "Clear highlights" toolbar button removes them.
     */
    endLiveBuild() {
        // Re-run the filter once at the end of the build so any thresholds
        // the user moved during the build (or that were already in effect)
        // re-apply to the now-complete graph. Newly-added items remain
        // exempt while their class lingers.
        this._applyDetailFilter();
    }

    /**
     * Remove `.kg-faded` and `.kg-newly-added` from every element so the
     * graph returns to its normal coloured state. Re-runs the detail
     * filter so anything that was held visible only by the live-build
     * exemption falls back under the user's current thresholds.
     */
    clearHighlights() {
        if (!this._cy) {
            this._highlightingActive = false;
            this._showClearHighlightsButton(false);
            return;
        }
        this._cy.elements().removeClass('kg-faded').removeClass('kg-newly-added');
        this._highlightingActive = false;
        this._showClearHighlightsButton(false);
        this._applyDetailFilter();
    }

    _showClearHighlightsButton(show) {
        const btn = this._container.querySelector('.graph-clear-highlights-btn');
        if (!btn) return;
        btn.classList.toggle('hidden', !show);
    }

    /**
     * User-triggered: run cose from scratch on the whole graph and update
     * the position cache to the new layout. This is the only way to
     * recompute positions now that open() preserves them — without this
     * button, a heavily edited graph would never get a fresh layout.
     */
    relayout() {
        if (!this._cy) return;
        // Drop any cached positions for the current book so the layout
        // truly starts from scratch.
        const bookId = this._getBook()?.id;
        if (bookId) this._positionCache.delete(bookId);
        const layout = this._cy.layout({
            name: 'cose',
            animate: false,
            padding: 30,
            randomize: true
        });
        if (layout && typeof layout.run === 'function') {
            layout.run();
            // After the layout settles, refresh the cache so the next
            // close()/open() preserves the new positions.
            const after = () => this._savePositionsToCache();
            if (typeof layout.on === 'function') layout.on('layoutstop', after);
            else after();
        }
    }

    /**
     * Snapshot every node's current position into the per-book cache so
     * the next open() can use `preset` and skip the cose pass. Called
     * from close() and after a relayout() finishes.
     */
    _savePositionsToCache() {
        if (!this._cy) return;
        const bookId = this._getBook()?.id;
        if (!bookId) return;
        // Defensive: tests use minimal cy mocks that may not have nodes()
        // or position()/id(). Skip silently rather than break the close()
        // path the tests assert on.
        const nodes = typeof this._cy.nodes === 'function' ? this._cy.nodes() : null;
        if (!nodes || typeof nodes.forEach !== 'function') return;
        let bucket = this._positionCache.get(bookId);
        if (!bucket) {
            bucket = new Map();
            this._positionCache.set(bookId, bucket);
        }
        nodes.forEach((n) => {
            if (typeof n?.position !== 'function' || typeof n?.id !== 'function') return;
            const p = n.position();
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                bucket.set(n.id(), { x: p.x, y: p.y });
            }
        });
    }

    /**
     * Pre-compute the unique chapter set of an item's contexts. Mirrors
     * the helper inside open() so live additions land with the same
     * `chapterSet` shape the detail filter expects.
     */
    _chaptersOf(item) {
        const s = new Set();
        for (const c of item?.contexts || []) {
            if (Number.isInteger(c.chapterIndex)) s.add(c.chapterIndex);
        }
        return s;
    }

    /**
     * Choose a position for a node arriving during a live build. Prefers
     * a random non-faded existing node's position (jittered) so the new
     * node lands near the existing graph; falls back to the viewport
     * centre if there are no existing nodes (first-ever build).
     */
    _pickLivePosition() {
        const jitter = () => (Math.random() - 0.5) * 60;
        // Prefer an existing (non-faded) anchor — that's the original
        // graph from before this build started. Among only faded-and-new
        // nodes, fall back to any random node.
        const original = this._cy.nodes('.kg-faded');
        const anchors = original.length > 0 ? original : this._cy.nodes();
        if (anchors.length > 0) {
            const pick = anchors[Math.floor(Math.random() * anchors.length)];
            const pos = pick.position();
            return { x: pos.x + jitter(), y: pos.y + jitter() };
        }
        const extent = this._cy.extent();
        return {
            x: (extent.x1 + extent.x2) / 2 + jitter(),
            y: (extent.y1 + extent.y2) / 2 + jitter()
        };
    }

    /**
     * Close the overlay and free the cytoscape instance.
     */
    close() {
        // Capture positions before tearing down cytoscape so re-opening
        // preserves the layout.
        this._savePositionsToCache();
        this._container.classList.add('hidden');
        if (this._cy) {
            this._cy.destroy();
            this._cy = null;
        }
    }
}
