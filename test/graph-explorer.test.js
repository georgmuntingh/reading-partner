import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy factory for cytoscape's default export so we can assert lazy loading
// and the elements payload without actually rendering anything.
const cytoscapeFactory = vi.fn(() => ({
    on: vi.fn(),
    destroy: vi.fn()
}));

vi.mock('cytoscape', () => ({ default: cytoscapeFactory }));

// Mock the floating menu + touch picker so tests can assert on the items
// list directly and resolve the user's pick programmatically.
const contextMenuSpy = vi.fn(async () => null);
vi.mock('../js/ui/kg-context-menu.js', () => ({
    openContextMenu: (...args) => contextMenuSpy(...args)
}));
const primaryPickerSpy = vi.fn(async () => null);
vi.mock('../js/ui/kg-merge-primary-picker.js', () => ({
    pickMergePrimary: (...args) => primaryPickerSpy(...args)
}));

import { GraphExplorer } from '../js/ui/graph-explorer.js';
import { storage } from '../js/services/storage.js';

beforeEach(async () => {
    cytoscapeFactory.mockClear();
    cytoscapeFactory.mockImplementation(() => ({ on: vi.fn(), destroy: vi.fn() }));
    contextMenuSpy.mockClear();
    contextMenuSpy.mockResolvedValue(null);
    primaryPickerSpy.mockClear();
    primaryPickerSpy.mockResolvedValue(null);
    document.body.innerHTML =
        '<div id="graph-explorer" class="graph-explorer hidden"></div>';
    await storage.init();
});

const seedBookGraph = async () => {
    await storage.saveKGNode({
        id: 'n1', bookId: 'b1', canonicalName: 'Arthur',
        aliases: ['the king'],
        type: 'PERSON', bloom: 'Remember', embedding: new Float32Array(1),
        contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
        firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
    });
    await storage.saveKGNode({
        id: 'n2', bookId: 'b1', canonicalName: 'sword',
        aliases: [],
        type: 'OBJECT', bloom: 'Remember', embedding: new Float32Array(1),
        contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
        firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
    });
    await storage.saveKGEdge({
        id: 'e1', bookId: 'b1', sourceId: 'n1', targetId: 'n2', relation: 'drew',
        contexts: [{ chapterIndex: 0, sentenceIndices: [3] }], createdAt: 0
    });
};

describe('GraphExplorer', () => {
    it('does NOT load cytoscape on construction (lazy import)', () => {
        new GraphExplorer({
            container: document.getElementById('graph-explorer'),
            getBook: () => ({ id: 'b1' })
        });
        expect(cytoscapeFactory).not.toHaveBeenCalled();
    });

    it('open() loads cytoscape, removes hidden, and passes nodes+edges as elements', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        expect(cytoscapeFactory).toHaveBeenCalledTimes(1);
        expect(container.classList.contains('hidden')).toBe(false);

        const args = cytoscapeFactory.mock.calls[0][0];
        const nodeElems = args.elements.filter((e) => !e.data.source);
        const edgeElems = args.elements.filter((e) => e.data.source);
        expect(nodeElems).toHaveLength(2);
        expect(nodeElems.map((n) => n.data.label).sort()).toEqual(['Arthur', 'sword']);
        expect(edgeElems).toHaveLength(1);
        expect(edgeElems[0].data.label).toBe('drew');
    });

    it('shows the empty state and skips cytoscape init when the book has no graph', async () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        expect(cytoscapeFactory).not.toHaveBeenCalled();
        const empty = container.querySelector('#graph-empty-state');
        expect(empty.classList.contains('hidden')).toBe(false);
        expect(container.querySelector('.graph-body').classList.contains('hidden')).toBe(true);
    });

    it('side panel renders aliases, bloom, and clickable contexts; click opens the preview modal (does not jump immediately)', async () => {
        await seedBookGraph();
        const onJumpToSentence = vi.fn();
        // The loader now returns a chapter shape ({ html, sentences }) so
        // the preview can use the chapter's full HTML to keep main-view
        // formatting (images, italics, etc.).
        const loadChapter = vi.fn(async () => ({
            sentences: [
                'Sentence one.', 'Sentence two.', 'Sentence three.',
                'Arthur drew the sword.', 'It glowed.'
            ],
            html: '<p class="paragraph">'
                + '<span class="sentence" data-index="0">Sentence one. </span>'
                + '<span class="sentence" data-index="1">Sentence two. </span>'
                + '<span class="sentence" data-index="2">Sentence three. </span>'
                + '<span class="sentence" data-index="3">Arthur drew the sword. </span>'
                + '<span class="sentence" data-index="4">It glowed. </span>'
                + '</p>'
        }));
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{ title: 'The Stone' }] }),
            onJumpToSentence,
            loadChapter
        });
        await ge.open();

        const node = (await storage.getKGNodesForBook('b1')).find((n) => n.canonicalName === 'Arthur');
        ge._showNodeDetails(node);

        const panel = container.querySelector('#kg-side-panel');
        expect(panel.classList.contains('hidden')).toBe(false);
        expect(panel.innerHTML).toContain('the king');
        expect(panel.innerHTML).toContain('Bloom');

        const link = panel.querySelector('a[data-ch="0"][data-sent="3"]');
        expect(link).toBeTruthy();
        link.click();

        // Clicking the context link must NOT jump immediately — it must open
        // the preview modal instead. The graph explorer also stays open.
        expect(onJumpToSentence).not.toHaveBeenCalled();
        expect(container.classList.contains('hidden')).toBe(false);

        // Drain microtasks so the modal's Promise.resolve().then(load).then(paint)
        // chain runs to completion and the body is populated.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const previewModal = document.querySelector('.kg-context-preview-modal');
        expect(previewModal).toBeTruthy();
        expect(previewModal.textContent).toContain('Arthur drew the sword.');
        // Target sentence is rendered with the highlight class.
        const targets = previewModal.querySelectorAll('.kg-context-preview-target');
        expect(targets).toHaveLength(1);
        expect(targets[0].textContent).toContain('Arthur drew the sword.');

        // "Open in reader" is offered as a secondary action and delegates
        // to onJumpToSentence + closes the explorer.
        const jumpBtn = previewModal.querySelector('[data-action="jump"]');
        expect(jumpBtn).toBeTruthy();
        jumpBtn.click();
        expect(onJumpToSentence).toHaveBeenCalledWith(0, 3);
        expect(container.classList.contains('hidden')).toBe(true);
    });

    it('escapes HTML in the side panel to prevent XSS via canonicalName / aliases', async () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        ge._showNodeDetails({
            canonicalName: '<img src=x onerror=alert(1)>',
            aliases: ['<script>bad()</script>'],
            type: 'OTHER',
            bloom: 'Remember',
            contexts: []
        });
        const panel = container.querySelector('#kg-side-panel');
        expect(panel.innerHTML).not.toContain('<img src=x onerror');
        expect(panel.innerHTML).not.toContain('<script>bad()');
        expect(panel.innerHTML).toContain('&lt;img src=x onerror');
    });

    it('close() destroys the cytoscape instance and re-hides the overlay', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        ge.close();
        const cyInst = cytoscapeFactory.mock.results[0].value;
        expect(cyInst.destroy).toHaveBeenCalled();
        expect(container.classList.contains('hidden')).toBe(true);
    });

    it('reopening after close() destroys the previous cytoscape instance and creates a new one', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        ge.close();
        await ge.open();
        expect(cytoscapeFactory).toHaveBeenCalledTimes(2);
    });

    it('chapter slider defaults to the "All chapters" sentinel and exposes per-chapter positions', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{}, {}, {}] }),  // 3 chapters
            getCurrentChapterIndex: () => 1                          // reader on Ch 2 — IGNORED now
        });
        await ge.open();
        const slider = container.querySelector('#kg-chapter');
        const label = container.querySelector('#kg-chapter-value');
        expect(slider.disabled).toBe(false);
        expect(slider.min).toBe('0');
        expect(slider.max).toBe('3');         // 3 chapters + 1 "All" slot
        // Default is the "All chapters" sentinel (max position), not the
        // reader's current chapter — the user explicitly wanted the
        // default view to show every node in the graph regardless of
        // which chapter they're reading.
        expect(slider.value).toBe('3');
        expect(label.value).toBe('All');

        // Per-chapter positions still work.
        slider.value = '1';
        slider.dispatchEvent(new Event('input'));
        expect(label.value).toBe('2');         // 1-based chapter number
    });

    it('falls back to "All" when no current-chapter callback is provided', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{}, {}] })
        });
        await ge.open();
        const slider = container.querySelector('#kg-chapter');
        const label = container.querySelector('#kg-chapter-value');
        expect(slider.value).toBe('2');       // out-of-range = sentinel
        expect(label.value).toBe('All');
    });

    it('attaches each node\'s and edge\'s chapter set to its cy data for filtering', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{}] }),
            getCurrentChapterIndex: () => 0
        });
        await ge.open();
        const args = cytoscapeFactory.mock.calls[0][0];
        const nodeElems = args.elements.filter((e) => !e.data.source);
        const edgeElems = args.elements.filter((e) => e.data.source);
        for (const n of nodeElems) {
            expect(n.data.chapterSet).toBeInstanceOf(Set);
            expect(n.data.chapterSet.has(0)).toBe(true);
        }
        for (const e of edgeElems) {
            expect(e.data.chapterSet).toBeInstanceOf(Set);
            expect(e.data.chapterSet.has(0)).toBe(true);
        }
    });

    it('min relevance slider defaults to 0.15', () => {
        const container = document.getElementById('graph-explorer');
        new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const slider = container.querySelector('#kg-min-relevance');
        const label = container.querySelector('#kg-min-relevance-value');
        expect(slider.value).toBe('0.15');
        expect(label.value).toBe('0.15');
    });

    it('mouse wheel over a slider scrubs it by one step (up = increase, down = decrease)', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        const slider = container.querySelector('#kg-min-degree');
        slider.value = '3';
        slider.dispatchEvent(new Event('input'));   // sync the label

        // Wheel up (deltaY < 0) increases by one step (= 1).
        const evtUp = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
        slider.dispatchEvent(evtUp);
        expect(slider.value).toBe('4');
        expect(evtUp.defaultPrevented).toBe(true);

        // Wheel down decreases.
        slider.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
        expect(slider.value).toBe('3');

        // Clamped at min/max — repeated wheel at the max should NOT overflow.
        slider.value = String(slider.max);
        slider.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        expect(slider.value).toBe(String(slider.max));
    });

    it('collapses adjacent sentence mentions into a single ranged link in the side panel', async () => {
        // Seed a node whose contexts contain three consecutive sentences
        // (0, 1, 2) — these should render as ONE "sentences 1–3" link, not
        // three separate links.
        await storage.saveKGNode({
            id: 'n1', bookId: 'b1', canonicalName: 'Arthur',
            aliases: [], type: 'PERSON', bloom: 'Remember',
            embedding: new Float32Array(1),
            contexts: [{ chapterIndex: 0, sentenceIndices: [0, 1, 2, 7, 8] }],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
        });
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        const node = (await storage.getKGNodesForBook('b1'))[0];
        ge._showNodeDetails(node);

        const panel = container.querySelector('#kg-side-panel');
        const links = panel.querySelectorAll('a[data-ch]');
        // Two groups: {0,1,2} and {7,8}.
        expect(links).toHaveLength(2);
        expect(links[0].textContent.trim()).toContain('sentences 1–3');
        expect(links[1].textContent.trim()).toContain('sentences 8–9');
        // The pivot sentence for the first group is the middle index (1).
        expect(links[0].dataset.sent).toBe('1');
    });

    it('side panel uses node.definition (prefetched) without calling lookupDefinition', async () => {
        await storage.saveKGNode({
            id: 'n1', bookId: 'b1', canonicalName: 'Arthur',
            aliases: [], type: 'PERSON', bloom: 'Remember',
            embedding: new Float32Array(1),
            contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
            firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0,
            // Definition prefetched at creation time:
            definition: { definition: 'King of the Britons.' }
        });
        const lookupDefinition = vi.fn();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            lookupDefinition
        });
        await ge.open();
        const node = (await storage.getKGNodesForBook('b1'))[0];
        ge._showNodeDetails(node);

        const body = container.querySelector('.kg-side-definition-body');
        expect(body.textContent).toContain('King of the Britons.');
        // No fallback fetch since the definition was already on the node.
        expect(lookupDefinition).not.toHaveBeenCalled();
    });

    it('renders an inline definition row via the lookupDefinition callback', async () => {
        await seedBookGraph();
        const lookupDefinition = vi.fn(async (phrase) => ({
            definition: `${phrase} is a legendary king of the Britons.`
        }));
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            lookupDefinition
        });
        await ge.open();
        const node = (await storage.getKGNodesForBook('b1')).find((n) => n.canonicalName === 'Arthur');
        ge._showNodeDetails(node);

        const defRow = container.querySelector('.kg-side-definition');
        expect(defRow).toBeTruthy();
        expect(defRow.textContent).toContain('Loading…');

        // Drain microtasks so the async lookup resolves and paints.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(lookupDefinition).toHaveBeenCalledWith('Arthur');
        expect(defRow.querySelector('.kg-side-definition-body').textContent)
            .toContain('legendary king');

        // Re-opening the same node uses the in-memory cache (no second
        // invocation).
        ge._showNodeDetails(node);
        await new Promise((r) => setTimeout(r, 0));
        expect(lookupDefinition).toHaveBeenCalledTimes(1);
    });

    it('double-tap on a node opens the preview at the first-seen sentence', async () => {
        // Seed a node whose first-seen chapter is 2 and whose earliest
        // sentence index there is 7.
        await storage.saveKGNode({
            id: 'n1', bookId: 'b1', canonicalName: 'Arthur',
            aliases: [], type: 'PERSON', bloom: 'Remember',
            embedding: new Float32Array(1),
            firstSeenChapter: 2,
            contexts: [
                { chapterIndex: 5, sentenceIndices: [3, 12] },
                { chapterIndex: 2, sentenceIndices: [7, 9] }
            ],
            srs: {}, createdAt: 0, updatedAt: 0
        });
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{}, {}, {}, {}, {}, {}] }),
            loadChapter: async () => ({
                sentences: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 'first mention', 's8'],
                html: ''
            })
        });
        await ge.open();
        const node = (await storage.getKGNodesForBook('b1'))[0];
        const loc = ge._firstSeenLocation(node);
        expect(loc).toEqual({ chapterIndex: 2, sentenceIndex: 7 });

        ge._openFirstSeenPreview(node);
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        const modal = document.querySelector('.kg-context-preview-modal');
        expect(modal).toBeTruthy();
        expect(modal.textContent).toContain('first mention');
    });

    it('forwards the user-configured wheel sensitivity to cytoscape', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            getWheelSensitivity: () => 2.5
        });
        await ge.open();
        const args = cytoscapeFactory.mock.calls[0][0];
        expect(args.wheelSensitivity).toBe(2.5);
    });

    it('intercepts anchor clicks inside the context preview so chapter-internal links do not 404', async () => {
        await seedBookGraph();
        const loadChapter = vi.fn(async () => ({
            sentences: ['s0', 's1', 's2', 's3', 's4'],
            html: '<p class="paragraph">'
                + '<span class="sentence" data-index="0">s0</span>'
                + '<span class="sentence" data-index="1">s1</span>'
                + '<span class="sentence" data-index="2">'
                +   'Some text <a href="ch12.xhtml#foo">internal link</a> here.'
                + '</span>'
                + '<span class="sentence" data-index="3">s3</span>'
                + '<span class="sentence" data-index="4">s4</span>'
                + '</p>'
        }));
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{ title: 'C' }] }),
            loadChapter
        });
        await ge.open();
        const node = (await storage.getKGNodesForBook('b1')).find((n) => n.canonicalName === 'Arthur');
        ge._openContextPreview(node, 0, 2);

        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const modal = document.querySelector('.kg-context-preview-modal');
        expect(modal).toBeTruthy();
        const anchor = modal.querySelector('a[href]');
        expect(anchor).toBeTruthy();

        const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
        anchor.dispatchEvent(evt);
        // The modal must intercept the navigation that would otherwise
        // 404 outside the EPUB reader iframe.
        expect(evt.defaultPrevented).toBe(true);
    });

    it('hands chapter-relative anchor clicks in the preview to onInternalLink (instead of dropping them)', async () => {
        await seedBookGraph();
        const onInternalLink = vi.fn();
        const loadChapter = vi.fn(async () => ({
            sentences: ['s0', 's1', 's2', 's3', 's4'],
            html: '<p class="paragraph">'
                + '<span class="sentence" data-index="0">s0</span>'
                + '<span class="sentence" data-index="1">s1</span>'
                + '<span class="sentence" data-index="2">'
                +   'X <a href="ch12.xhtml#frag">link</a>'
                + '</span>'
                + '<span class="sentence" data-index="3">s3</span>'
                + '<span class="sentence" data-index="4">s4</span>'
                + '</p>'
        }));
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{ title: 'C' }] }),
            loadChapter,
            onInternalLink
        });
        await ge.open();
        const node = (await storage.getKGNodesForBook('b1')).find((n) => n.canonicalName === 'Arthur');
        ge._openContextPreview(node, 0, 2);
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const anchor = document.querySelector('.kg-context-preview-modal a[href]');
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(onInternalLink).toHaveBeenCalledWith('ch12.xhtml#frag');
        // The modal also closes itself + the explorer so the user lands
        // on the reader at the resolved location.
        expect(document.querySelector('.kg-context-preview-modal')).toBeNull();
        expect(container.classList.contains('hidden')).toBe(true);
    });

    it('passes selection-mode flags (additive selection, panning on, no box-select) to cytoscape', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        const args = cytoscapeFactory.mock.calls[0][0];
        expect(args.selectionType).toBe('additive');
        expect(args.boxSelectionEnabled).toBe(false);
        expect(args.userPanningEnabled).toBe(true);
    });

    it('right-click on a single node opens a context menu with only Delete', async () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const primaryStub = {
            id: () => 'n1',
            data: (k) => k === 'raw' ? { canonicalName: 'Arthur' } : undefined
        };
        ge._cy = {
            nodes: (sel) => sel === ':selected' ? { length: 1 } : { length: 0 }
        };
        await ge._openContextMenu({ x: 100, y: 200 }, primaryStub);
        expect(contextMenuSpy).toHaveBeenCalledTimes(1);
        const { items } = contextMenuSpy.mock.calls[0][0];
        expect(items.map((i) => i.id)).toEqual(['delete']);
    });

    it('right-click with ≥2 selected adds a "Merge into <name>" item ahead of Delete', async () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const primaryStub = {
            id: () => 'n1',
            data: (k) => k === 'raw' ? { canonicalName: 'Arthur' } : undefined
        };
        ge._cy = {
            nodes: (sel) => sel === ':selected' ? { length: 3 } : { length: 0 }
        };
        await ge._openContextMenu({ x: 1, y: 2 }, primaryStub);
        const { items } = contextMenuSpy.mock.calls[0][0];
        expect(items.map((i) => i.id)).toEqual(['merge', 'delete']);
        expect(items[0].label).toBe('Merge into Arthur');
    });

    it('background tap clears the selection and exits selection-mode', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        // Capture handlers registered on cytoscape so we can fire them.
        const handlers = {};
        cytoscapeFactory.mockImplementationOnce(() => {
            const cy = {
                on: (events, ...rest) => {
                    const fn = rest[rest.length - 1];
                    const selector = rest.length === 2 ? rest[0] : null;
                    for (const ev of events.split(/\s+/)) {
                        handlers[`${ev}|${selector ?? ''}`] = fn;
                    }
                },
                destroy: vi.fn(),
                elements: () => ({ unselect: vi.fn() })
            };
            return cy;
        });
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        await ge.open();
        const elementsUnselect = vi.fn();
        ge._cy.elements = () => ({ unselect: elementsUnselect });
        ge._selectionMode = true;
        container.classList.add('is-selection-mode');
        // Fire the background tap.
        const tapHandler = handlers['tap|'];
        expect(tapHandler).toBeTruthy();
        tapHandler({ target: ge._cy });
        expect(elementsUnselect).toHaveBeenCalled();
        expect(ge._selectionMode).toBe(false);
        expect(container.classList.contains('is-selection-mode')).toBe(false);
    });

    it('_mergeSelected confirms, calls applyMergeTransaction with the merged-node shape, and removes secondaries', async () => {
        await storage.saveKGEdge({
            id: 'e1', bookId: 'b1', sourceId: 'n_s', targetId: 'n_x',
            relation: 'rel', contexts: [], createdAt: 0
        });
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });

        const primaryRecord = {
            id: 'n_p', bookId: 'b1', canonicalName: 'Mitochondrion',
            aliases: ['ATP'], type: 'CONCEPT', bloom: 'Remember',
            embedding: new Float32Array(1), relevanceScore: 0.9,
            definition: 'powerhouse', mergeCount: 1, firstSeenChapter: 0,
            srs: {}, contexts: [{ chapterIndex: 0, sentenceIndices: [1] }],
            createdAt: 0, updatedAt: 0
        };
        const secondaryRecord = {
            id: 'n_s', bookId: 'b1', canonicalName: 'mitochondria',
            aliases: [], type: 'CONCEPT', bloom: 'Remember',
            embedding: new Float32Array(1), relevanceScore: 0.1,
            mergeCount: 1, firstSeenChapter: 0, srs: {},
            contexts: [{ chapterIndex: 1, sentenceIndices: [7] }],
            createdAt: 0, updatedAt: 0
        };

        const primaryNode = {
            id: () => 'n_p',
            data: (k) => k === 'raw' ? primaryRecord : undefined,
        };
        primaryNode.data = function(arg) {
            if (typeof arg === 'string') return arg === 'raw' ? primaryRecord : undefined;
            return undefined;   // setter form is a no-op in the stub
        };
        const secondaryNode = {
            id: () => 'n_s',
            data: (k) => k === 'raw' ? secondaryRecord : undefined
        };
        const selectedColl = {
            length: 2,
            map: (f) => [primaryNode, secondaryNode].map(f),
            difference: () => ({
                length: 1,
                map: (f) => [secondaryNode].map(f)
            })
        };
        ge._cy = {
            nodes: () => selectedColl,
            batch: (fn) => fn(),
            remove: vi.fn(),
            getElementById: () => ({ empty: () => true }),
            add: vi.fn(),
            elements: () => ({ unselect: () => {} })
        };
        ge._applyDetailFilter = () => {};

        const applySpy = vi.spyOn(storage, 'applyMergeTransaction')
            .mockResolvedValue();

        const p = ge._mergeSelected(primaryNode);
        await new Promise((r) => setTimeout(r, 0));
        document.querySelector('.confirm-modal [data-action="confirm"]').click();
        await p;

        expect(applySpy).toHaveBeenCalledTimes(1);
        const payload = applySpy.mock.calls[0][0];
        expect(payload.deletedNodeIds).toEqual(['n_s']);
        expect(payload.updatedNode.id).toBe('n_p');
        // mergeNodeMetadata folded the secondary's canonicalName into aliases.
        expect(payload.updatedNode.aliases).toEqual(['ATP', 'mitochondria']);
        // Contexts merged by chapter.
        expect(payload.updatedNode.contexts).toEqual([
            { chapterIndex: 0, sentenceIndices: [1] },
            { chapterIndex: 1, sentenceIndices: [7] }
        ]);
        // e1 (sourceId 'n_s') was redirected to 'n_p'.
        expect(payload.savedEdges).toHaveLength(1);
        expect(payload.savedEdges[0].sourceId).toBe('n_p');
        applySpy.mockRestore();
    });

    it('_deleteSelected confirms, calls applyDeleteTransaction with the right ids, and removes from cy', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });

        // Stub a minimal cytoscape API supporting selection + removal.
        const selectedNodeIds = ['n1', 'n2'];
        const removeSpy = vi.fn();
        const connectedEdges = {
            map: (f) => ['e1'].map((id) => f({ id: () => id }))
        };
        const selectedColl = {
            length: selectedNodeIds.length,
            map: (f) => selectedNodeIds.map((id) => f({
                id: () => id,
                data: (k) => k === 'raw' ? { canonicalName: id } : undefined
            })),
            connectedEdges: () => connectedEdges,
            union: function() { return this; },
            difference: function() { return this; },
            [0]: { data: () => ({ canonicalName: 'n1' }) }
        };
        ge._cy = {
            nodes: () => selectedColl,
            remove: removeSpy,
            elements: () => ({ unselect: () => {} }),
            batch: (fn) => fn()
        };
        // Skip the post-delete re-filter — exercising it requires the much
        // richer cytoscape mock from the min-connections test below.
        ge._applyDetailFilter = () => {};

        // Auto-confirm the destructive dialog.
        const applySpy = vi.spyOn(storage, 'applyDeleteTransaction')
            .mockResolvedValue();

        const p = ge._deleteSelected();
        // Wait for the confirm modal to mount, then click Delete.
        await new Promise((r) => setTimeout(r, 0));
        const confirmBtn = document.querySelector('.confirm-modal [data-action="confirm"]');
        expect(confirmBtn).toBeTruthy();
        confirmBtn.click();
        await p;

        expect(applySpy).toHaveBeenCalledWith({
            deletedNodeIds: ['n1', 'n2'],
            deletedEdgeIds: ['e1']
        });
        expect(removeSpy).toHaveBeenCalled();
        applySpy.mockRestore();
    });

    it('beginLiveBuild fades existing elements and handleLiveNode adds a new node with the highlight class', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });

        const addedFaded = new Set();
        const removedFaded = new Set();
        const elementsCollection = {
            addClass: (c) => { if (c === 'kg-faded') addedFaded.add('all'); },
            removeClass: () => {}
        };
        const addSpy = vi.fn();
        const nodeStub = {
            id: () => 'n_existing',
            position: () => ({ x: 100, y: 100 })
        };
        const nodesByClass = (sel) => sel === '.kg-faded'
            ? Object.assign([nodeStub], { length: 1 })
            : Object.assign([nodeStub], { length: 1 });
        ge._cy = {
            elements: () => elementsCollection,
            nodes: nodesByClass,
            add: addSpy,
            getElementById: () => ({ empty: () => true })
        };
        await ge.beginLiveBuild();
        expect(addedFaded.has('all')).toBe(true);
        expect(container.querySelector('.graph-clear-highlights-btn')
            .classList.contains('hidden')).toBe(false);

        ge.handleLiveNode({
            id: 'n_new', canonicalName: 'Excalibur', type: 'OBJECT',
            bloom: 'Apply', relevanceScore: 0.7,
            contexts: [{ chapterIndex: 0, sentenceIndices: [4] }]
        });
        expect(addSpy).toHaveBeenCalledTimes(1);
        const payload = addSpy.mock.calls[0][0];
        expect(payload.group).toBe('nodes');
        expect(payload.classes).toBe('kg-newly-added');
        expect(payload.data.id).toBe('n_new');
        // Position is the chosen anchor + small jitter.
        expect(payload.position.x).toBeGreaterThan(70);
        expect(payload.position.x).toBeLessThan(130);
    });

    it('handleLiveEdge snaps a newly-added unanchored node to its connected neighbour\'s position', () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const positions = { src: { x: 0, y: 0 }, tgt: { x: 500, y: 300 } };
        const newNode = {
            empty: () => false,
            hasClass: (c) => c === 'kg-newly-added',
            id: () => 'src',
            position: (p) => p === undefined ? positions.src : (positions.src = p)
        };
        const existingNode = {
            empty: () => false,
            hasClass: () => false,    // existing (not newly-added)
            id: () => 'tgt',
            position: () => positions.tgt
        };
        const addSpy = vi.fn();
        ge._cy = {
            getElementById: (id) => id === 'src' ? newNode : id === 'tgt' ? existingNode : { empty: () => true },
            add: addSpy
        };
        ge._anchoredLiveNodes = new Set();
        ge.handleLiveEdge({
            id: 'e1', sourceId: 'src', targetId: 'tgt', relation: 'r', contexts: []
        });
        // src should have been snapped to near tgt's position (jitter ±15).
        expect(positions.src.x).toBeGreaterThan(485);
        expect(positions.src.x).toBeLessThan(515);
        expect(positions.src.y).toBeGreaterThan(285);
        expect(positions.src.y).toBeLessThan(315);
        // Snapping is one-shot per node — re-firing on the same node is a no-op.
        expect(ge._anchoredLiveNodes.has('src')).toBe(true);
    });

    it('handleBatchComplete runs a cose pass on the newly-added subgraph with existing nodes locked', () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const lockSpy = vi.fn();
        const unlockSpy = vi.fn();
        const layoutSpy = vi.fn(() => ({ run: vi.fn() }));
        const newSubgraph = {
            length: 3,
            layout: layoutSpy
        };
        const newNodes = {
            length: 2,
            union: () => newSubgraph,
            connectedEdges: () => ({})
        };
        const otherNodes = {
            length: 5,
            lock: lockSpy,
            unlock: unlockSpy
        };
        ge._cy = {
            nodes: (sel) => {
                if (sel === '.kg-newly-added') return newNodes;
                // .nodes() with no arg → all nodes; .difference(newNodes) → others
                return { difference: () => otherNodes };
            }
        };
        ge.handleBatchComplete();
        expect(lockSpy).toHaveBeenCalled();
        expect(unlockSpy).toHaveBeenCalled();
        expect(layoutSpy).toHaveBeenCalledTimes(1);
        const opts = layoutSpy.mock.calls[0][0];
        expect(opts.name).toBe('cose');
        expect(opts.randomize).toBe(false);
        expect(opts.fit).toBe(false);
    });

    it('close() snapshots positions to the per-book cache; re-opening uses preset layout', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' })
        });
        // First open() — cytoscape gets cose because cache is empty.
        await ge.open();
        const firstLayout = cytoscapeFactory.mock.calls[0][0].layout;
        expect(firstLayout.name).toBe('cose');

        // Stub cy.nodes() so close() can populate the cache.
        ge._cy.nodes = () => ({
            forEach: (f) => {
                f({ id: () => 'n1', position: () => ({ x: 100, y: 200 }) });
                f({ id: () => 'n2', position: () => ({ x: 300, y: 400 }) });
            }
        });
        ge.close();

        await ge.open();
        // Second open() — every element in the payload has a cached
        // position, so layout flips to preset.
        const secondLayout = cytoscapeFactory.mock.calls[1][0].layout;
        expect(secondLayout.name).toBe('preset');
        // And the cached coordinates are stamped onto the element payload.
        const els = cytoscapeFactory.mock.calls[1][0].elements;
        const n1 = els.find((e) => e.data.id === 'n1');
        expect(n1.position).toEqual({ x: 100, y: 200 });
    });

    it('relayout() clears the per-book cache and runs cose with randomize:true', () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' })
        });
        // Seed the cache so we can prove relayout() drops it.
        ge._positionCache.set('b1', new Map([['n1', { x: 5, y: 5 }]]));
        const runSpy = vi.fn();
        ge._cy = {
            layout: vi.fn(() => ({ run: runSpy, on: () => {} })),
            nodes: () => ({ forEach: () => {} })
        };
        ge.relayout();
        expect(ge._cy.layout).toHaveBeenCalledTimes(1);
        const opts = ge._cy.layout.mock.calls[0][0];
        expect(opts.name).toBe('cose');
        expect(opts.randomize).toBe(true);
        expect(runSpy).toHaveBeenCalled();
        expect(ge._positionCache.has('b1')).toBe(false);
    });

    it('text search highlights nodes whose canonicalName or aliases contain the query (case-insensitive)', async () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            getSearchSettings: () => ({ mode: 'text', threshold: 0.5 })
        });
        const classed = new Map();   // id → Set<class>
        const makeNode = (id, raw) => ({
            id: () => id,
            data: () => raw,
            addClass: (c) => {
                if (!classed.has(id)) classed.set(id, new Set());
                classed.get(id).add(c);
            },
            removeClass: (c) => classed.get(id)?.delete(c)
        });
        const nodes = [
            makeNode('n1', { canonicalName: 'Arthur', aliases: ['the king'] }),
            makeNode('n2', { canonicalName: 'sword', aliases: [] }),
            makeNode('n3', { canonicalName: 'Excalibur', aliases: ['the sword'] })
        ];
        const collection = {
            forEach: (f) => nodes.forEach(f),
            removeClass: () => {}
        };
        ge._cy = {
            nodes: () => collection,
            batch: (fn) => fn()
        };

        await ge._runSearch('king');
        // Only n1 has 'king' in its aliases.
        expect(classed.get('n1')?.has('kg-match')).toBe(true);
        expect(classed.get('n2')?.has('kg-match')).toBeFalsy();
        expect(classed.get('n3')?.has('kg-match')).toBeFalsy();
        expect(container.querySelector('#kg-search-status').textContent).toBe('1 match');

        await ge._runSearch('SWORD');
        // Case-insensitive: both n2 (canonical name) and n3 (alias).
        expect(classed.get('n2')?.has('kg-match')).toBe(true);
        expect(classed.get('n3')?.has('kg-match')).toBe(true);
        expect(classed.get('n1')?.has('kg-match')).toBe(false);
        expect(container.querySelector('#kg-search-status').textContent).toBe('2 matches');
    });

    it('empty query clears matches and the status row', async () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            getSearchSettings: () => ({ mode: 'text', threshold: 0.5 })
        });
        const removeSpy = vi.fn();
        ge._cy = {
            nodes: () => ({ removeClass: removeSpy }),
            batch: (fn) => fn()
        };
        container.querySelector('#kg-search-status').textContent = '5 matches';
        await ge._runSearch('   ');
        expect(removeSpy).toHaveBeenCalledWith('kg-match');
        expect(container.querySelector('#kg-search-status').textContent).toBe('');
    });

    it('semantic search embeds the query and highlights nodes above the threshold', async () => {
        const { embeddingProvider } = await import('../js/services/embedding-provider.js');
        // Query embedding aligned with [1,0]; n1 also [1,0] → cos=1; n2 [0,1] → cos=0.
        const queryVec = Float32Array.from([1, 0]);
        const embedSpy = vi.spyOn(embeddingProvider, 'embed')
            .mockResolvedValue([queryVec]);
        vi.spyOn(embeddingProvider, 'isReady').mockReturnValue(true);

        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            getSearchSettings: () => ({ mode: 'semantic', threshold: 0.5 })
        });
        const classed = new Map();
        const makeNode = (id, embedding) => ({
            id: () => id,
            data: () => ({ embedding }),
            addClass: (c) => {
                if (!classed.has(id)) classed.set(id, new Set());
                classed.get(id).add(c);
            },
            removeClass: (c) => classed.get(id)?.delete(c)
        });
        const nodes = [
            makeNode('n1', Float32Array.from([1, 0])),     // cosine 1.0
            makeNode('n2', Float32Array.from([0, 1])),     // cosine 0.0
            makeNode('n3', null)                            // legacy, no embedding
        ];
        ge._cy = {
            nodes: () => ({
                forEach: (f) => nodes.forEach(f),
                removeClass: () => {}
            }),
            batch: (fn) => fn()
        };

        await ge._runSearch('king');
        expect(embedSpy).toHaveBeenCalledWith(['king']);
        // Only n1 passes the 0.5 threshold.
        expect(classed.get('n1')?.has('kg-match')).toBe(true);
        expect(classed.get('n2')?.has('kg-match')).toBeFalsy();
        // Legacy node without an embedding is silently skipped, never matched.
        expect(classed.get('n3')?.has('kg-match')).toBeFalsy();
        expect(container.querySelector('#kg-search-status').textContent).toBe('1 match');
        embedSpy.mockRestore();
    });

    it('semantic search caches query embeddings so re-typing the same query is free', async () => {
        const { embeddingProvider } = await import('../js/services/embedding-provider.js');
        const embedSpy = vi.spyOn(embeddingProvider, 'embed')
            .mockResolvedValue([Float32Array.from([1, 0])]);
        vi.spyOn(embeddingProvider, 'isReady').mockReturnValue(true);

        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            getSearchSettings: () => ({ mode: 'semantic', threshold: 0.5 })
        });
        ge._cy = {
            nodes: () => ({ forEach: () => {}, removeClass: () => {} }),
            batch: (fn) => fn()
        };
        await ge._runSearch('king');
        await ge._runSearch('king');
        // Cache hit on the second call.
        expect(embedSpy).toHaveBeenCalledTimes(1);
        embedSpy.mockRestore();
    });

    it('handleLiveEdge skips when an endpoint is missing in the canvas', () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const addSpy = vi.fn();
        ge._cy = {
            getElementById: (id) => id === 'present'
                ? { empty: () => false }
                : { empty: () => true },
            add: addSpy
        };
        ge.handleLiveEdge({
            id: 'e_dangling', sourceId: 'present', targetId: 'missing',
            relation: 'r', contexts: []
        });
        expect(addSpy).not.toHaveBeenCalled();
    });

    it('clearHighlights strips both classes from every element and re-runs the filter', () => {
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        const removed = [];
        ge._cy = {
            elements: () => ({
                removeClass: (c) => {
                    removed.push(c);
                    return { removeClass: (c2) => removed.push(c2) };
                }
            })
        };
        const filterSpy = vi.fn();
        ge._applyDetailFilter = filterSpy;
        ge._highlightingActive = true;
        ge.clearHighlights();
        expect(removed).toEqual(['kg-faded', 'kg-newly-added']);
        expect(filterSpy).toHaveBeenCalled();
        expect(container.querySelector('.graph-clear-highlights-btn')
            .classList.contains('hidden')).toBe(true);
    });

    it('min-connections threshold keeps anchors AND their neighbours (not only the anchors)', async () => {
        // Build a tiny graph: A is connected to B, C, D, E (degree 4);
        // F is connected to G only (degree 1, F not an anchor under
        // minDeg=4); B/C/D/E each have degree 1.
        const seed = async () => {
            const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
            for (const name of nodes) {
                await storage.saveKGNode({
                    id: `n_${name}`, bookId: 'b1', canonicalName: name, aliases: [],
                    type: 'OTHER', bloom: 'Remember', embedding: new Float32Array(1),
                    contexts: [{ chapterIndex: 0, sentenceIndices: [0] }],
                    firstSeenChapter: 0, srs: {}, createdAt: 0, updatedAt: 0
                });
            }
            const edges = [
                ['A', 'B'], ['A', 'C'], ['A', 'D'], ['A', 'E'], ['F', 'G']
            ];
            for (const [s, t] of edges) {
                await storage.saveKGEdge({
                    id: `e_${s}_${t}`, bookId: 'b1', sourceId: `n_${s}`, targetId: `n_${t}`,
                    relation: 'r', contexts: [{ chapterIndex: 0, sentenceIndices: [0] }], createdAt: 0
                });
            }
        };
        await seed();

        // Use a real cytoscape mock with degree + neighborhood + hidden
        // class semantics. The default factory mock only stubs `on/destroy`,
        // so spin one up locally with the methods we need.
        const hidden = new Map();   // id -> bool
        const nodes = new Map();    // id -> {edges...}
        const edges = [];
        const makeNodeApi = (id) => {
            const n = {
                id: () => id,
                data: (k) => k === 'relevanceScore' ? null
                    : k === 'chapterSet' ? new Set([0]) : undefined,
                degree: () => edges.filter(
                    (e) => e.source === id || e.target === id
                ).length,
                hasClass: (c) => c === 'kg-hidden' && hidden.get(id) === true,
                toggleClass: (c, on) => { if (c === 'kg-hidden') hidden.set(id, !!on); },
                addClass: (c) => { if (c === 'kg-hidden') hidden.set(id, true); },
                removeClass: (c) => { if (c === 'kg-hidden') hidden.set(id, false); },
                neighborhood: () => makeCollection(neighbourIds(id)),
                openNeighborhood: () => makeCollection(neighbourIds(id))
            };
            nodes.set(id, n);
            return n;
        };
        const neighbourIds = (id) => edges
            .filter((e) => e.source === id || e.target === id)
            .map((e) => e.source === id ? e.target : e.source);
        const makeCollection = (ids) => {
            const arr = Array.from(new Set(ids)).map((id) => nodes.get(id));
            const coll = {
                length: arr.length,
                forEach: (f) => arr.forEach(f),
                filter: (pred) => makeCollection(arr.filter(pred).map((n) => n.id())),
                map: (f) => arr.map(f),
                union: (other) => makeCollection([...arr.map((n) => n.id()), ...other.map((n) => n.id())]),
                difference: (other) => {
                    const drop = new Set(other.map((n) => n.id()));
                    return makeCollection(arr.filter((n) => !drop.has(n.id())).map((n) => n.id()));
                },
                addClass: (c) => arr.forEach((n) => n.addClass(c)),
                removeClass: (c) => arr.forEach((n) => n.removeClass(c)),
                connectedEdges: () => ({ removeClass: () => {}, addClass: () => {}, forEach: () => {} }),
                openNeighborhood: () => {
                    const ids = [].concat(...arr.map((n) => neighbourIds(n.id())));
                    return makeCollection(ids);
                }
            };
            return coll;
        };
        ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach((id) => makeNodeApi(`n_${id}`));
        edges.push(
            { source: 'n_A', target: 'n_B' }, { source: 'n_A', target: 'n_C' },
            { source: 'n_A', target: 'n_D' }, { source: 'n_A', target: 'n_E' },
            { source: 'n_F', target: 'n_G' }
        );
        const cyMock = {
            batch: (fn) => fn(),
            nodes: () => makeCollection(Array.from(nodes.keys())),
            edges: () => ({ removeClass: () => {}, addClass: () => {}, forEach: () => {} }),
            on: vi.fn(), destroy: vi.fn()
        };

        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({ container, getBook: () => ({ id: 'b1' }) });
        ge._cy = cyMock;
        ge._chapterCount = 0;            // disable chapter gate
        // Manually set slider values for the filter pass.
        container.innerHTML = `<input id="kg-min-degree" value="4">
                               <input id="kg-min-relevance" value="0">
                               <input id="kg-chapter" value="0">`;
        ge._applyDetailFilter();

        // A passes (degree=4); B/C/D/E pulled in as neighbours of A even
        // though their own degree is 1.
        for (const id of ['n_A', 'n_B', 'n_C', 'n_D', 'n_E']) {
            expect(hidden.get(id)).toBe(false);
        }
        // F has degree 1 and no anchor neighbour — hidden. G likewise.
        expect(hidden.get('n_F')).toBe(true);
        expect(hidden.get('n_G')).toBe(true);
    });
});
