/**
 * Graph Explorer — card-highlight cycle tests (Phase 4)
 *
 * Separate from graph-explorer.test.js because the cycle path needs a
 * far richer Cytoscape mock (nodes/edges with addClass/removeClass/data).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('cytoscape', () => ({ default: vi.fn() }));
vi.mock('../js/ui/kg-context-menu.js', () => ({ openContextMenu: vi.fn(async () => null) }));
vi.mock('../js/ui/kg-merge-primary-picker.js', () => ({ pickMergePrimary: vi.fn(async () => null) }));

import { GraphExplorer } from '../js/ui/graph-explorer.js';

// ---------- Cytoscape mock that supports the cycle's operations ----------

/**
 * Build a minimal-but-functional `cy` mock.
 *   nodes: [{ id, sourceId?, targetId?, source?, target? }, ...]
 *   edges: same shape, distinguished by sourceId/targetId presence
 */
function makeCyMock({ nodes, edges }) {
    const makeElem = (data) => {
        const classes = new Set();
        return {
            data: (key) => data[key],
            addClass: vi.fn(function (cls) { classes.add(cls); return this; }),
            removeClass: vi.fn(function (cls) { classes.delete(cls); return this; }),
            hasClass: (cls) => classes.has(cls),
            _classes: classes
        };
    };
    const nodeElems = nodes.map((n) => makeElem(n));
    const edgeElems = edges.map((e) => makeElem(e));
    const all = [...nodeElems, ...edgeElems];

    const collection = (items) => ({
        forEach: (fn) => items.forEach(fn),
        [Symbol.iterator]: () => items[Symbol.iterator](),
        removeClass(cls) { for (const it of items) it.removeClass(cls); return this; },
        addClass(cls)    { for (const it of items) it.addClass(cls); return this; }
    });

    return {
        nodes: () => collection(nodeElems),
        edges: () => collection(edgeElems),
        elements: () => collection(all),
        getElementById: (id) => all.find((e) => e.data('id') === id) ?? {
            addClass: vi.fn(), removeClass: vi.fn()
        },
        on: vi.fn(),
        destroy: vi.fn(),
        _nodeElems: nodeElems,
        _edgeElems: edgeElems
    };
}

// ---------- Card / explorer helpers ----------

const makeCard = (overrides = {}) => ({
    id: `fc_${Math.random().toString(36).slice(2, 9)}`,
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    srsBox: 0,
    nextReviewAt: 0,
    ...overrides
});

const mountExplorer = ({ flashcards = [], getFlashcardsImpl } = {}) => {
    document.body.innerHTML =
        '<div id="graph-explorer" class="graph-explorer hidden"></div>';
    const container = document.getElementById('graph-explorer');
    const getFlashcards = vi.fn(getFlashcardsImpl ?? (async () => flashcards));
    const ge = new GraphExplorer({
        container,
        getBook: () => ({ id: 'b1' }),
        getFlashcards
    });
    return { ge, container, getFlashcards };
};

const installCyMock = (ge, opts) => {
    const cy = makeCyMock(opts);
    ge._cy = cy;
    // Force the container to appear "open" so isOpen() returns true.
    ge._container.classList.remove('hidden');
    return cy;
};

beforeEach(() => { document.body.innerHTML = ''; });

// ---------- isOpen / invalidateFlashcardCache ----------

describe('GraphExplorer — isOpen / invalidateFlashcardCache', () => {
    it('isOpen() returns true after open()-style state and false when hidden', () => {
        const { ge, container } = mountExplorer();
        expect(ge.isOpen()).toBe(false);
        container.classList.remove('hidden');
        expect(ge.isOpen()).toBe(true);
    });

    it('invalidateFlashcardCache() forces a re-fetch on next cycle', async () => {
        const { ge, getFlashcards } = mountExplorer({ flashcards: [] });
        installCyMock(ge, { nodes: [], edges: [] });
        await ge._advanceCardHighlightMode(); // off → any → fetch
        expect(getFlashcards).toHaveBeenCalledTimes(1);
        await ge._advanceCardHighlightMode(); // any → failing → cached
        expect(getFlashcards).toHaveBeenCalledTimes(1);
        ge.invalidateFlashcardCache();
        await ge._advanceCardHighlightMode(); // failing → learning → re-fetch
        expect(getFlashcards).toHaveBeenCalledTimes(2);
    });
});

// ---------- cycle order + label ----------

describe('GraphExplorer — cycle state machine', () => {
    it('advances off → any → failing → learning → mastered → off', async () => {
        const { ge } = mountExplorer({ flashcards: [] });
        installCyMock(ge, { nodes: [], edges: [] });
        expect(ge._cardHighlightMode).toBe('off');
        await ge._advanceCardHighlightMode(); expect(ge._cardHighlightMode).toBe('any');
        await ge._advanceCardHighlightMode(); expect(ge._cardHighlightMode).toBe('failing');
        await ge._advanceCardHighlightMode(); expect(ge._cardHighlightMode).toBe('learning');
        await ge._advanceCardHighlightMode(); expect(ge._cardHighlightMode).toBe('mastered');
        await ge._advanceCardHighlightMode(); expect(ge._cardHighlightMode).toBe('off');
    });

    it('the button label updates to reflect the current mode', async () => {
        const { ge, container } = mountExplorer({ flashcards: [] });
        installCyMock(ge, { nodes: [], edges: [] });
        const label = container.querySelector('.graph-card-highlight-label');
        expect(label.textContent).toBe('Highlight cards'); // off
        await ge._advanceCardHighlightMode(); expect(label.textContent).toBe('All cards');
        await ge._advanceCardHighlightMode(); expect(label.textContent).toBe('Failing');
        await ge._advanceCardHighlightMode(); expect(label.textContent).toBe('Learning');
        await ge._advanceCardHighlightMode(); expect(label.textContent).toBe('Mastered');
        await ge._advanceCardHighlightMode(); expect(label.textContent).toBe('Highlight cards');
    });
});

// ---------- 'any' mode ----------

describe("GraphExplorer — 'any' mode", () => {
    it('adds .kg-card-has to nodes covered by at least one card; fades the rest', async () => {
        const flashcards = [
            makeCard({ id: 'c1', targetNodeIds: ['nA'] }),
            makeCard({ id: 'c2', targetNodeIds: ['nB'], srsBox: 3 })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'nA' }, { id: 'nB' }, { id: 'nC' }],
            edges: []
        });
        await ge._advanceCardHighlightMode(); // off → any
        expect(cy._nodeElems[0].hasClass('kg-card-has')).toBe(true);   // nA
        expect(cy._nodeElems[1].hasClass('kg-card-has')).toBe(true);   // nB
        expect(cy._nodeElems[2].hasClass('kg-card-has')).toBe(false);  // nC
        expect(cy._nodeElems[2].hasClass('kg-faded')).toBe(true);
    });
});

// ---------- band modes ----------

describe('GraphExplorer — band modes', () => {
    it("'failing' adds .kg-card-failing only to nodes with a srsBox-0 card", async () => {
        const flashcards = [
            makeCard({ id: 'c-failing', targetNodeIds: ['nA'], srsBox: 0 }),
            makeCard({ id: 'c-mastered', targetNodeIds: ['nB'], srsBox: 4 }),
            makeCard({ id: 'c-learning', targetNodeIds: ['nC'], srsBox: 1 })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'nA' }, { id: 'nB' }, { id: 'nC' }],
            edges: []
        });
        // cycle: off → any → failing
        await ge._advanceCardHighlightMode();
        await ge._advanceCardHighlightMode();
        expect(cy._nodeElems[0].hasClass('kg-card-failing')).toBe(true);   // nA
        expect(cy._nodeElems[1].hasClass('kg-card-failing')).toBe(false);  // nB faded
        expect(cy._nodeElems[1].hasClass('kg-faded')).toBe(true);
        expect(cy._nodeElems[2].hasClass('kg-card-failing')).toBe(false);  // nC faded
        expect(cy._nodeElems[2].hasClass('kg-faded')).toBe(true);
    });

    it("'mastered' adds .kg-card-mastered only to nodes with srsBox>=3", async () => {
        const flashcards = [
            makeCard({ id: 'a', targetNodeIds: ['nA'], srsBox: 0 }),
            makeCard({ id: 'b', targetNodeIds: ['nB'], srsBox: 4 })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, { nodes: [{ id: 'nA' }, { id: 'nB' }], edges: [] });
        // off → any → failing → learning → mastered
        for (let i = 0; i < 4; i++) await ge._advanceCardHighlightMode();
        expect(cy._nodeElems[1].hasClass('kg-card-mastered')).toBe(true);
        expect(cy._nodeElems[0].hasClass('kg-card-mastered')).toBe(false);
        expect(cy._nodeElems[0].hasClass('kg-faded')).toBe(true);
    });
});

// ---------- bottleneck visual ----------

describe('GraphExplorer — bottleneck visual (enhancement #1)', () => {
    it('failing + high-degree node gets .kg-card-bottleneck; low-degree failing does not', async () => {
        // Hub node 'H' with degree 5 (4 outgoing + 1 incoming); 'L' has degree 1.
        const flashcards = [
            makeCard({ id: 'h-fc', targetNodeIds: ['H'], srsBox: 0 }),
            makeCard({ id: 'l-fc', targetNodeIds: ['L'], srsBox: 0 })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [
                { id: 'H' }, { id: 'L' },
                { id: 'X' }, { id: 'Y' }, { id: 'Z' }, { id: 'W' }, { id: 'V' }
            ],
            edges: [
                { id: 'e1', source: 'H', target: 'X' },
                { id: 'e2', source: 'H', target: 'Y' },
                { id: 'e3', source: 'H', target: 'Z' },
                { id: 'e4', source: 'H', target: 'W' },
                { id: 'e5', source: 'V', target: 'H' },
                { id: 'e6', source: 'L', target: 'X' }
            ]
        });
        // off → any → failing
        await ge._advanceCardHighlightMode();
        await ge._advanceCardHighlightMode();
        const H = cy._nodeElems[0];
        const L = cy._nodeElems[1];
        expect(H.hasClass('kg-card-bottleneck')).toBe(true);
        expect(L.hasClass('kg-card-bottleneck')).toBe(false);
        // Both still get the base failing class.
        expect(H.hasClass('kg-card-failing')).toBe(true);
        expect(L.hasClass('kg-card-failing')).toBe(true);
    });

    it('bottleneck class is NOT applied in learning / mastered modes', async () => {
        const flashcards = [makeCard({ id: 'h', targetNodeIds: ['H'], srsBox: 1 })];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'H' }, { id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
            edges: [
                { id: 'e1', source: 'H', target: 'A' },
                { id: 'e2', source: 'H', target: 'B' },
                { id: 'e3', source: 'H', target: 'C' },
                { id: 'e4', source: 'H', target: 'D' },
                { id: 'e5', source: 'H', target: 'E' }
            ]
        });
        // cycle to learning
        await ge._advanceCardHighlightMode();
        await ge._advanceCardHighlightMode();
        await ge._advanceCardHighlightMode();
        expect(cy._nodeElems[0].hasClass('kg-card-bottleneck')).toBe(false);
        expect(cy._nodeElems[0].hasClass('kg-card-learning')).toBe(true);
    });
});

// ---------- edge highlighting (multi-card mapping) ----------

describe('GraphExplorer — edge highlighting', () => {
    it("'any' mode highlights edges covered by at least one card", async () => {
        const flashcards = [
            makeCard({ id: 'c1', cognitiveLevel: 2, targetEdgeIds: ['e1'] })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'A' }, { id: 'B' }],
            edges: [
                { id: 'e1', source: 'A', target: 'B' },
                { id: 'e2', source: 'A', target: 'B' }
            ]
        });
        await ge._advanceCardHighlightMode();
        expect(cy._edgeElems[0].hasClass('kg-card-has')).toBe(true);
        expect(cy._edgeElems[1].hasClass('kg-card-has')).toBe(false);
    });

    it('multi-card edge mapping: one edge in two cards still highlights it', async () => {
        const flashcards = [
            makeCard({ id: 'c1', cognitiveLevel: 2, targetEdgeIds: ['e1'], srsBox: 3 }),
            makeCard({ id: 'c2', cognitiveLevel: 2, targetEdgeIds: ['e1'], srsBox: 0 })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'A' }, { id: 'B' }],
            edges: [{ id: 'e1', source: 'A', target: 'B' }]
        });
        // cycle to mastered
        await ge._advanceCardHighlightMode(); // any
        await ge._advanceCardHighlightMode(); // failing → e1 matches (the srsBox=0 card)
        expect(cy._edgeElems[0].hasClass('kg-card-failing')).toBe(true);
    });

    it('multi-edge card: a single card listing two edge ids highlights both', async () => {
        const flashcards = [
            makeCard({ id: 'multi', cognitiveLevel: 2, targetEdgeIds: ['e1', 'e2'] })
        ];
        const { ge } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
            edges: [
                { id: 'e1', source: 'A', target: 'B' },
                { id: 'e2', source: 'B', target: 'C' }
            ]
        });
        await ge._advanceCardHighlightMode();
        expect(cy._edgeElems[0].hasClass('kg-card-has')).toBe(true);
        expect(cy._edgeElems[1].hasClass('kg-card-has')).toBe(true);
    });
});

// ---------- clear / reset ----------

describe('GraphExplorer — clearHighlights resets cycle to off', () => {
    it('strips all kg-card-* classes and resets _cardHighlightMode', async () => {
        const flashcards = [makeCard({ id: 'c', targetNodeIds: ['A'], srsBox: 0 })];
        const { ge, container } = mountExplorer({ flashcards });
        const cy = installCyMock(ge, {
            nodes: [{ id: 'A' }, { id: 'B' }],
            edges: []
        });
        await ge._advanceCardHighlightMode(); // any
        expect(cy._nodeElems[0].hasClass('kg-card-has')).toBe(true);
        ge.clearHighlights();
        expect(cy._nodeElems[0].hasClass('kg-card-has')).toBe(false);
        expect(cy._nodeElems[1].hasClass('kg-faded')).toBe(false);
        expect(ge._cardHighlightMode).toBe('off');
        const label = container.querySelector('.graph-card-highlight-label');
        expect(label.textContent).toBe('Highlight cards');
    });
});

// ---------- Phase 5: Node-detail Flashcards section ----------

describe('GraphExplorer — node-detail Flashcards section (Phase 5)', () => {
    const setupPanelTest = (flashcards) => {
        document.body.innerHTML =
            '<div id="graph-explorer" class="graph-explorer hidden"></div>';
        const container = document.getElementById('graph-explorer');
        const getFlashcards = vi.fn(async () => flashcards);
        const onOpenCardOverview = vi.fn();
        const onReviewConcept = vi.fn();
        const ge = new GraphExplorer({
            container,
            getBook: () => ({ id: 'b1' }),
            getFlashcards,
            onOpenCardOverview,
            onReviewConcept
        });
        // The constructor already builds #kg-side-panel as part of the shell.
        const panel = container.querySelector('#kg-side-panel');
        return { ge, container, getFlashcards, onOpenCardOverview, onReviewConcept, panel };
    };

    const sampleNode = (id = 'n1') => ({
        id,
        canonicalName: 'Arthur',
        type: 'PERSON',
        bloom: 'Remember',
        aliases: [],
        contexts: []
    });

    it('renders an empty state and hides the Review button when no cards target the node', async () => {
        const { ge, panel } = setupPanelTest([]);
        ge._showNodeDetails(sampleNode());
        // Allow the async _renderFlashcardsSection to resolve.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(panel.querySelector('.kg-flashcard-list').textContent).toMatch(/No flashcards/);
        expect(panel.querySelector('.kg-review-concept-btn').hidden).toBe(true);
    });

    it('renders one item per card targeting the node, and reveals the Review button', async () => {
        const flashcards = [
            makeCard({ id: 'a', targetNodeIds: ['n1'], cognitiveLevel: 1, srsBox: 0, question: 'Q1' }),
            makeCard({ id: 'b', targetNodeIds: ['n1'], cognitiveLevel: 2, srsBox: 3, question: 'Q2' }),
            makeCard({ id: 'c', targetNodeIds: ['n2'], question: 'unrelated' })
        ];
        const { ge, panel } = setupPanelTest(flashcards);
        ge._showNodeDetails(sampleNode('n1'));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        const items = panel.querySelectorAll('.kg-flashcard-item');
        expect(items).toHaveLength(2);
        expect(Array.from(items).map((i) => i.dataset.fcId).sort()).toEqual(['a', 'b']);
        expect(panel.querySelector('.kg-review-concept-btn').hidden).toBe(false);
    });

    it('clicking a flashcard item fires onOpenCardOverview with its id', async () => {
        const flashcards = [makeCard({ id: 'target', targetNodeIds: ['n1'] })];
        const { ge, panel, onOpenCardOverview } = setupPanelTest(flashcards);
        ge._showNodeDetails(sampleNode('n1'));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        panel.querySelector('.kg-flashcard-item').click();
        expect(onOpenCardOverview).toHaveBeenCalledWith('target');
    });

    it('clicking Review this concept fires onReviewConcept with the cards targeting that node only', async () => {
        const flashcards = [
            makeCard({ id: 'a', targetNodeIds: ['n1'] }),
            makeCard({ id: 'b', targetNodeIds: ['n1'] }),
            makeCard({ id: 'c', targetNodeIds: ['n2'] })
        ];
        const { ge, panel, onReviewConcept } = setupPanelTest(flashcards);
        ge._showNodeDetails(sampleNode('n1'));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        panel.querySelector('.kg-review-concept-btn').click();
        const cardsFired = onReviewConcept.mock.calls[0][0];
        expect(cardsFired.map((c) => c.id).sort()).toEqual(['a', 'b']);
    });

    it('uses the cached deck if it has been populated by the cycle button', async () => {
        const flashcards = [makeCard({ id: 'cached', targetNodeIds: ['n1'] })];
        const { ge, getFlashcards, panel } = setupPanelTest(flashcards);
        ge._flashcardsCache = flashcards;  // simulate cycle button pre-fetch
        ge._showNodeDetails(sampleNode('n1'));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(getFlashcards).not.toHaveBeenCalled();
        expect(panel.querySelector('.kg-flashcard-item').dataset.fcId).toBe('cached');
    });
});
