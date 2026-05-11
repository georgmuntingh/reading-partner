import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy factory for cytoscape's default export so we can assert lazy loading
// and the elements payload without actually rendering anything.
const cytoscapeFactory = vi.fn(() => ({
    on: vi.fn(),
    destroy: vi.fn()
}));

vi.mock('cytoscape', () => ({ default: cytoscapeFactory }));

import { GraphExplorer } from '../js/ui/graph-explorer.js';
import { storage } from '../js/services/storage.js';

beforeEach(async () => {
    cytoscapeFactory.mockClear();
    cytoscapeFactory.mockImplementation(() => ({ on: vi.fn(), destroy: vi.fn() }));
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

    it('chapter slider defaults to the reader\'s current chapter and exposes an "All" sentinel', async () => {
        await seedBookGraph();
        const container = document.getElementById('graph-explorer');
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1', chapters: [{}, {}, {}] }),  // 3 chapters
            getCurrentChapterIndex: () => 1                          // reader on Ch 2
        });
        await ge.open();
        const slider = container.querySelector('#kg-chapter');
        const label = container.querySelector('#kg-chapter-value');
        expect(slider.disabled).toBe(false);
        expect(slider.min).toBe('0');
        expect(slider.max).toBe('3');         // 3 chapters + 1 "All" slot
        expect(slider.value).toBe('1');       // current chapter
        expect(label.textContent).toBe('Ch 2');

        // Last position is the "All chapters" sentinel.
        slider.value = '3';
        slider.dispatchEvent(new Event('input'));
        expect(label.textContent).toBe('All');
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
        expect(label.textContent).toBe('All');
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
        expect(label.textContent).toBe('0.15');
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
});
