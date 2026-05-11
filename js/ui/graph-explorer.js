/**
 * Graph Explorer UI Component
 * Full-screen overlay rendering the per-book knowledge graph with cytoscape.
 *
 * Cytoscape is loaded lazily on first open() so it does not enter the
 * initial bundle — Vite splits the dynamic import into its own chunk.
 *
 * Click handlers:
 *   - tap a node     → show the side panel with type / bloom / aliases / contexts
 *   - tap a context  → close overlay and call onJumpToSentence(chapterIndex, sentenceIndex)
 *   - tap background → hide the side panel
 */

import { storage } from '../services/storage.js';

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
     * @param {(chapterIndex: number, sentenceIndex: number) => void} [options.onJumpToSentence]
     */
    constructor({ container, getBook, getCurrentChapterIndex, onJumpToSentence }) {
        this._container = container;
        this._getBook = getBook;
        this._getCurrentChapterIndex = typeof getCurrentChapterIndex === 'function'
            ? getCurrentChapterIndex
            : () => null;
        this._onJumpToSentence = onJumpToSentence;
        this._cy = null;
        this._cytoscape = null;        // Lazy-loaded module
        // Total chapters in the currently-open book. Recomputed on each open().
        this._chapterCount = 0;
        this._render();
    }

    _render() {
        this._container.innerHTML = `
            <div class="graph-explorer-header">
                <h2>Knowledge Graph</h2>
                <div class="graph-filter-toolbar">
                    <label>
                        Chapter: <span id="kg-chapter-value">All</span>
                        <input type="range" id="kg-chapter" min="0" max="0" step="1" value="0" disabled>
                    </label>
                    <label>
                        Min connections: <span id="kg-min-degree-value">1</span>
                        <input type="range" id="kg-min-degree" min="1" max="10" step="1" value="1">
                    </label>
                    <label>
                        Min relevance: <span id="kg-min-relevance-value">0.25</span>
                        <input type="range" id="kg-min-relevance" min="0" max="1" step="0.05" value="0.25">
                    </label>
                </div>
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
            <div id="graph-empty-state" class="graph-empty-state hidden">
                <p>No knowledge graph yet. Open a chapter and click "Build graph" in the reader controls to extract entities and relations.</p>
            </div>
        `;
        this._container.querySelector('.graph-close-btn').addEventListener('click', () => this.close());

        const degSlider = this._container.querySelector('#kg-min-degree');
        const relSlider = this._container.querySelector('#kg-min-relevance');
        const chSlider = this._container.querySelector('#kg-chapter');
        const degValue = this._container.querySelector('#kg-min-degree-value');
        const relValue = this._container.querySelector('#kg-min-relevance-value');
        const chValue = this._container.querySelector('#kg-chapter-value');
        degSlider.addEventListener('input', () => {
            degValue.textContent = degSlider.value;
            this._applyDetailFilter();
        });
        relSlider.addEventListener('input', () => {
            relValue.textContent = parseFloat(relSlider.value).toFixed(2);
            this._applyDetailFilter();
        });
        chSlider.addEventListener('input', () => {
            chValue.textContent = this._chapterSliderLabel(chSlider.value);
            this._applyDetailFilter();
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
        return `Ch ${v + 1}`;
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
            chValue.textContent = 'All';
            return;
        }

        chSlider.disabled = false;
        chSlider.min = '0';
        chSlider.max = String(count);    // last slot = "All"
        const current = this._getCurrentChapterIndex();
        const defaultPos = (Number.isInteger(current) && current >= 0 && current < count)
            ? current
            : count;                     // fall back to "All"
        chSlider.value = String(defaultPos);
        chValue.textContent = this._chapterSliderLabel(defaultPos);
    }

    /**
     * Open the overlay, load nodes/edges from storage, and render.
     */
    async open() {
        this._container.classList.remove('hidden');

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

        // Pre-compute the unique chapter set for each node and edge so the
        // chapter slider can do an O(1) lookup per element instead of
        // re-scanning `contexts` on every slider tick.
        const chaptersOf = (item) => {
            const s = new Set();
            for (const c of item.contexts || []) {
                if (Number.isInteger(c.chapterIndex)) s.add(c.chapterIndex);
            }
            return s;
        };

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
                    chapterSet: chaptersOf(n),
                    raw: n
                }
            })),
            ...edges.map((e) => ({
                data: {
                    id: e.id,
                    source: e.sourceId,
                    target: e.targetId,
                    label: e.relation,
                    chapterSet: chaptersOf(e),
                    raw: e
                }
            }))
        ];

        // Tear down a previous instance if open() is called twice without close()
        if (this._cy) {
            this._cy.destroy();
            this._cy = null;
        }

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
                        'target-arrow-color': '#fa3'
                    }
                },
                {
                    selector: '.kg-hidden',
                    style: { display: 'none' }
                }
            ],
            layout: { name: 'cose', animate: false, padding: 30 },
            minZoom: 0.2,
            maxZoom: 3,
            wheelSensitivity: 0.3
        });

        this._cy.on('tap', 'node', (evt) => this._showNodeDetails(evt.target.data('raw')));
        this._cy.on('tap', (evt) => {
            if (evt.target === this._cy) this._hideSide();
        });

        // Apply the initial detail filter so the default UI state (min
        // relevance 0.25, min degree 1) takes effect on first render.
        this._applyDetailFilter();
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

        this._cy.batch(() => {
            this._cy.nodes().forEach((n) => {
                const score = n.data('relevanceScore');
                const passesRel = score == null || score >= minRel;
                const chSet = n.data('chapterSet');
                // Legacy nodes without a chapterSet (shouldn't happen for
                // freshly-extracted graphs) bypass the chapter gate.
                const passesCh = chapterAll || !chSet || chSet.has(chapterIndex);
                // Degree is structural (full-graph) — the slider stays
                // stable as the chapter filter changes.
                const passesDeg = n.degree() >= minDeg;
                n.toggleClass('kg-hidden', !(passesDeg && passesRel && passesCh));
            });
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

    _showNodeDetails(node) {
        const panel = this._container.querySelector('#kg-side-panel');
        const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
        const aliasLine = node.aliases?.length
            ? node.aliases.map(escape).join(', ')
            : '—';
        const contextItems = (node.contexts || []).flatMap((c) =>
            (c.sentenceIndices || []).slice(0, 3).map((si) => ({
                chapterIndex: c.chapterIndex,
                sentenceIndex: si
            }))
        );
        panel.innerHTML = `
            <h3>${escape(node.canonicalName)}</h3>
            <p><strong>Type:</strong> ${escape(node.type)}</p>
            <p><strong>Bloom level:</strong> ${escape(node.bloom)}</p>
            <p><strong>Aliases:</strong> ${aliasLine}</p>
            <h4>Context</h4>
            <ul class="kg-context-list">
                ${contextItems.length === 0
                    ? '<li>No context recorded.</li>'
                    : contextItems.map((c) => `
                        <li><a href="#" data-ch="${c.chapterIndex}" data-sent="${c.sentenceIndex}">
                            Chapter ${c.chapterIndex + 1}, sentence ${c.sentenceIndex + 1}
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
                this._onJumpToSentence?.(ch, sent);
                this.close();
            });
        }
    }

    _hideSide() {
        this._container.querySelector('#kg-side-panel').classList.add('hidden');
    }

    /**
     * Close the overlay and free the cytoscape instance.
     */
    close() {
        this._container.classList.add('hidden');
        if (this._cy) {
            this._cy.destroy();
            this._cy = null;
        }
    }
}
