import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from '../js/services/storage.js';
import {
    SRSGenerator,
    SRS_SYSTEM_PROMPT,
    buildGroundedNodePrompt,
    buildGroundedEdgePrompt,
    validateCardPayload,
    shuffleOptions
} from '../js/services/srs-generator.js';

const SETTINGS = {
    srsPaddingMode: 'padding',
    srsPaddingSentences: 2,
    srsDistractorCount: 3,
    srsLLMTemperature: 0.4,
    srsEaseDefault: 2.5,
    srsEaseMin: 1.3,
    srsEaseStepFail: 0.2,
    srsFailIntervalMinutes: 10
};

const CHAPTER_0 = [
    'Arthur drew the sword.', 'The stone cracked.', 'A king was made.',
    'Merlin watched silently.', 'Excalibur gleamed.', 'The kingdom rejoiced.',
    'Mordred glared from afar.', 'The future was uncertain.'
];

const makeNode = (id, overrides = {}) => ({
    id,
    bookId: 'b1',
    canonicalName: id,
    aliases: [],
    type: 'PERSON',
    bloom: 'Remember',
    definition: `${id} is a key concept.`,
    embedding: new Float32Array(1),
    contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
    firstSeenChapter: 0,
    relevanceScore: null,
    srs: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides
});

const makeEdge = (id, sourceId, targetId, overrides = {}) => ({
    id,
    bookId: 'b1',
    sourceId,
    targetId,
    relation: 'related to',
    contexts: [{ chapterIndex: 0, sentenceIndices: [3] }],
    createdAt: 0,
    ...overrides
});

const makeCard = (overrides = {}) => ({
    id: `fc_${Math.random().toString(36).slice(2, 9)}`,
    bookId: 'b1',
    cognitiveLevel: 1,
    targetNodeIds: [],
    targetEdgeIds: [],
    question: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0,
    explanation: 'e', primaryChapterIndex: 0, primarySentenceIndex: 0,
    srsBox: 0, ease: 2.5, interval: 0, repetitions: 0,
    lastResult: 'new', lastReviewedAt: null,
    nextReviewAt: 0, createdAt: 0, updatedAt: 0,
    ...overrides
});

const fakeReadingState = (chapters = { 0: CHAPTER_0 }) => ({
    loadChapter: vi.fn(async (idx) => chapters[idx] ?? null)
});

const fakeLLM = (responseFn) => {
    const complete = vi.fn(async () => {
        const r = typeof responseFn === 'function' ? responseFn() : responseFn;
        return typeof r === 'string' ? r : JSON.stringify(r);
    });
    return {
        complete,
        getProvider: () => ({
            parseJSON: (txt) => {
                const cleaned = String(txt).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
                return JSON.parse(cleaned);
            }
        }),
        _complete: complete
    };
};

// ---------- Pure helpers ----------

describe('validateCardPayload', () => {
    const ok = {
        question: 'Q?',
        options: ['a', 'b', 'c', 'd'],
        correctIndex: 1,
        explanation: 'e'
    };

    it('passes a well-formed payload', () => {
        expect(validateCardPayload(ok, 4)).toBe(true);
    });

    it('rejects when question is empty / non-string', () => {
        expect(validateCardPayload({ ...ok, question: '' }, 4)).toBe(false);
        expect(validateCardPayload({ ...ok, question: 42 }, 4)).toBe(false);
    });

    it('rejects when options array length != expectedOptionCount', () => {
        expect(validateCardPayload({ ...ok, options: ['a', 'b', 'c'] }, 4)).toBe(false);
        expect(validateCardPayload({ ...ok, options: ['a', 'b', 'c', 'd', 'e'] }, 4)).toBe(false);
    });

    it('rejects when an option is empty / non-string', () => {
        expect(validateCardPayload({ ...ok, options: ['a', '', 'c', 'd'] }, 4)).toBe(false);
        expect(validateCardPayload({ ...ok, options: ['a', 2, 'c', 'd'] }, 4)).toBe(false);
    });

    it('rejects when correctIndex is out of range or non-integer', () => {
        expect(validateCardPayload({ ...ok, correctIndex: -1 }, 4)).toBe(false);
        expect(validateCardPayload({ ...ok, correctIndex: 4 }, 4)).toBe(false);
        expect(validateCardPayload({ ...ok, correctIndex: 1.5 }, 4)).toBe(false);
    });

    it('rejects duplicate options (case-insensitive)', () => {
        expect(validateCardPayload({ ...ok, options: ['a', 'A', 'c', 'd'] }, 4)).toBe(false);
    });

    it('rejects missing explanation', () => {
        expect(validateCardPayload({ ...ok, explanation: '' }, 4)).toBe(false);
        expect(validateCardPayload({ ...ok, explanation: undefined }, 4)).toBe(false);
    });

    it('rejects null / non-object', () => {
        expect(validateCardPayload(null, 4)).toBe(false);
        expect(validateCardPayload('string', 4)).toBe(false);
    });
});

describe('shuffleOptions', () => {
    it('preserves the set of options and keeps correctIndex pointing at the right string', () => {
        const payload = {
            question: 'Q?',
            options: ['alpha', 'beta', 'gamma', 'delta'],
            correctIndex: 2,        // 'gamma'
            explanation: 'e'
        };
        // Deterministic RNG that reverses the array.
        const out = shuffleOptions(payload, () => 0);
        expect(new Set(out.options)).toEqual(new Set(['alpha', 'beta', 'gamma', 'delta']));
        expect(out.options[out.correctIndex]).toBe('gamma');
    });
});

describe('buildGroundedNodePrompt', () => {
    it('includes target concept, definition, context text, and candidate distractors', () => {
        const out = buildGroundedNodePrompt({
            targetConcept: 'Excalibur',
            targetDefinition: 'A magical sword.',
            contextText: '[ch0 s2-4] Arthur drew it. The stone cracked. A king was made.',
            candidateDistractors: ['Mordred', 'Merlin'],
            distractorCount: 3,
            wholeChapter: false
        });
        expect(out).toContain('Excalibur');
        expect(out).toContain('A magical sword.');
        expect(out).toContain('[ch0 s2-4]');
        expect(out).toContain('Mordred');
        expect(out).toContain('Merlin');
        expect(out).toMatch(/4 options/);
    });

    it('whole-chapter mode tells the LLM to pick distractors from the context, not a list', () => {
        const out = buildGroundedNodePrompt({
            targetConcept: 'Excalibur',
            contextText: 'full chapter text...',
            candidateDistractors: [],
            distractorCount: 3,
            wholeChapter: true
        });
        expect(out).toMatch(/mentioned in[\s\S]*CONTEXT TEXT/);
    });

    it('padding mode with no candidates falls back to generic distractor guidance', () => {
        const out = buildGroundedNodePrompt({
            targetConcept: 'Excalibur',
            contextText: 't',
            candidateDistractors: [],
            distractorCount: 3,
            wholeChapter: false
        });
        expect(out).toMatch(/plausible misreadings/);
    });
});

describe('buildGroundedEdgePrompt', () => {
    it('includes both endpoints and relation', () => {
        const out = buildGroundedEdgePrompt({
            sourceConcept: 'Arthur',
            targetConcept: 'Excalibur',
            relation: 'wields',
            contextText: '[ch0 s0-2] ...',
            candidateDistractors: ['Mordred', 'Merlin'],
            distractorCount: 3,
            wholeChapter: false
        });
        expect(out).toContain('Arthur');
        expect(out).toContain('Excalibur');
        expect(out).toContain('wields');
        expect(out).toContain('Mordred');
    });
});

// ---------- SRSGenerator (with live storage + mocks) ----------

describe('SRSGenerator.generateForNode', () => {
    let storage;
    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    const validPayload = {
        question: 'What did Arthur draw?',
        options: ['Excalibur', 'Mordred', 'A bow', 'Nothing'],
        correctIndex: 0,
        explanation: 'The passage says Arthur drew the sword.'
    };

    it('produces a flashcard with the correct shape when the LLM returns valid JSON', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const node = makeNode('Arthur', {
            contexts: [{ chapterIndex: 0, sentenceIndices: [0] }]
        });
        const card = await gen.generateForNode(node, [node], []);
        expect(card).toBeTruthy();
        expect(card.bookId).toBe('b1');
        expect(card.cognitiveLevel).toBe(1);
        expect(card.targetNodeIds).toEqual(['Arthur']);
        expect(card.targetEdgeIds).toEqual([]);
        expect(card.options).toHaveLength(4);
        expect(card.options[card.correctIndex]).toBe('Excalibur');
        expect(card.primaryChapterIndex).toBe(0);
        expect(card.primarySentenceIndex).toBe(0);
        // SRS state from newCardDefaults.
        expect(card.srsBox).toBe(0);
        expect(card.lastResult).toBe('new');
        expect(card.ease).toBe(2.5);
    });

    it('returns null when the node has no usable context (loadChapter returns nothing)', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage,
            readingState: { loadChapter: async () => null },
            llmClient: llm,
            settings: SETTINGS
        });
        const node = makeNode('X');
        const card = await gen.generateForNode(node, [node], []);
        expect(card).toBeNull();
        expect(llm._complete).not.toHaveBeenCalled();
    });

    it('returns null when the LLM call throws', async () => {
        const llm = { complete: vi.fn(async () => { throw new Error('boom'); }), getProvider: () => ({ parseJSON: JSON.parse }) };
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const card = await gen.generateForNode(makeNode('Arthur'), [], []);
        expect(card).toBeNull();
    });

    it('returns null when the LLM returns unparseable JSON', async () => {
        const llm = fakeLLM('not json at all');
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const card = await gen.generateForNode(makeNode('Arthur'), [], []);
        expect(card).toBeNull();
    });

    it('returns null when the payload fails validation (wrong option count)', async () => {
        const llm = fakeLLM({ ...validPayload, options: ['only', 'three', 'opts'] });
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const card = await gen.generateForNode(makeNode('Arthur'), [], []);
        expect(card).toBeNull();
    });

    it('passes neighbour names as candidate distractors in padding mode', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const A = makeNode('Arthur');
        const E = makeNode('Excalibur');
        const M = makeNode('Merlin');
        const edges = [
            makeEdge('e1', 'Arthur', 'Excalibur'),
            makeEdge('e2', 'Arthur', 'Merlin')
        ];
        await gen.generateForNode(A, [A, E, M], edges);
        const promptArg = llm._complete.mock.calls[0][0].prompt;
        expect(promptArg).toContain('CANDIDATE DISTRACTORS');
        expect(promptArg).toMatch(/Excalibur|Merlin/);
    });

    it('whole-chapter mode does not pass candidate distractors', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage,
            readingState: fakeReadingState(),
            llmClient: llm,
            settings: { ...SETTINGS, srsPaddingMode: 'whole-chapter' }
        });
        const A = makeNode('Arthur');
        const M = makeNode('Merlin');
        const edges = [makeEdge('e1', 'Arthur', 'Merlin')];
        await gen.generateForNode(A, [A, M], edges);
        const promptArg = llm._complete.mock.calls[0][0].prompt;
        expect(promptArg).not.toContain('CANDIDATE DISTRACTORS');
        expect(promptArg).toMatch(/mentioned in[\s\S]*CONTEXT TEXT/);
    });

    it('respects srsLLMTemperature', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage,
            readingState: fakeReadingState(),
            llmClient: llm,
            settings: { ...SETTINGS, srsLLMTemperature: 0.9 }
        });
        await gen.generateForNode(makeNode('Arthur'), [], []);
        expect(llm._complete.mock.calls[0][0].temperature).toBe(0.9);
    });

    it('sends the SRS system prompt', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        await gen.generateForNode(makeNode('Arthur'), [], []);
        expect(llm._complete.mock.calls[0][0].system).toBe(SRS_SYSTEM_PROMPT);
    });
});

// ---------- SRSGenerator.generateForEdge ----------

describe('SRSGenerator.generateForEdge', () => {
    let storage;
    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    const validEdgePayload = {
        question: 'Who wields Excalibur?',
        options: ['Arthur', 'Mordred', 'Merlin', 'Lancelot'],
        correctIndex: 0,
        explanation: 'The passage names Arthur as the wielder.'
    };

    it('returns null when EITHER endpoint lacks a mastered L1 card (throttle)', async () => {
        const llm = fakeLLM(validEdgePayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const A = makeNode('Arthur');
        const E = makeNode('Excalibur');
        // Only Arthur has a mastered L1 card; Excalibur has none.
        await storage.saveFlashcard(makeCard({
            id: 'l1-A', cognitiveLevel: 1, targetNodeIds: ['Arthur'], srsBox: 2
        }));
        const edge = makeEdge('e1', 'Arthur', 'Excalibur', { relation: 'wields' });
        const card = await gen.generateForEdge(edge, [A, E], [edge]);
        expect(card).toBeNull();
        expect(llm._complete).not.toHaveBeenCalled();
    });

    it('produces an L2 card when BOTH endpoints have mastered L1 cards', async () => {
        const llm = fakeLLM(validEdgePayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const A = makeNode('Arthur');
        const E = makeNode('Excalibur');
        await storage.saveFlashcard(makeCard({
            id: 'l1-A', cognitiveLevel: 1, targetNodeIds: ['Arthur'], srsBox: 2
        }));
        await storage.saveFlashcard(makeCard({
            id: 'l1-E', cognitiveLevel: 1, targetNodeIds: ['Excalibur'], srsBox: 1
        }));
        const edge = makeEdge('e1', 'Arthur', 'Excalibur', { relation: 'wields' });
        const card = await gen.generateForEdge(edge, [A, E], [edge]);
        expect(card).toBeTruthy();
        expect(card.cognitiveLevel).toBe(2);
        expect(card.targetEdgeIds).toEqual(['e1']);
        expect(card.targetNodeIds.sort()).toEqual(['Arthur', 'Excalibur']);
    });

    it('returns null when either endpoint node is missing from the graph', async () => {
        const llm = fakeLLM(validEdgePayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const edge = makeEdge('e1', 'ghost', 'Excalibur');
        const card = await gen.generateForEdge(edge, [makeNode('Excalibur')], [edge]);
        expect(card).toBeNull();
    });
});

// ---------- SRSGenerator.generateForBook ----------

describe('SRSGenerator.generateForBook', () => {
    let storage;
    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    const validPayload = {
        question: 'Q?', options: ['a', 'b', 'c', 'd'], correctIndex: 0,
        explanation: 'e'
    };

    it('skips nodes that already have an L1 card', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        const A = makeNode('Arthur');
        const B = makeNode('Bedivere');
        await storage.saveKGNode(A);
        await storage.saveKGNode(B);
        // Pre-existing L1 for Arthur.
        await storage.saveFlashcard(makeCard({
            id: 'pre', cognitiveLevel: 1, targetNodeIds: ['Arthur']
        }));
        const cards = await gen.generateForBook('b1', { maxCards: 5 });
        // Only Bedivere gets a card.
        expect(cards).toHaveLength(1);
        expect(cards[0].targetNodeIds).toEqual(['Bedivere']);
    });

    it('respects maxCards (caps the L1 pass)', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        for (let i = 0; i < 5; i++) await storage.saveKGNode(makeNode(`N${i}`));
        const cards = await gen.generateForBook('b1', { maxCards: 2 });
        expect(cards).toHaveLength(2);
    });

    it('persists the generated cards via bulkPutFlashcards', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        await storage.saveKGNode(makeNode('Arthur'));
        await gen.generateForBook('b1', { maxCards: 5 });
        const all = await storage.getFlashcardsForBook('b1');
        expect(all).toHaveLength(1);
        expect(all[0].targetNodeIds).toEqual(['Arthur']);
    });

    it('returns an empty array (no save) when the LLM keeps failing', async () => {
        const llm = fakeLLM('garbage not json');
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS,
            logger: { warn: () => {} }
        });
        await storage.saveKGNode(makeNode('Arthur'));
        const cards = await gen.generateForBook('b1', { maxCards: 3 });
        expect(cards).toEqual([]);
        expect(await storage.getFlashcardsForBook('b1')).toEqual([]);
    });
});

// ---------- SRSGenerator.generateForChapter ----------

describe('SRSGenerator.generateForChapter', () => {
    let storage;
    beforeEach(async () => {
        storage = new StorageService();
        await storage.init();
    });

    const validPayload = {
        question: 'Q?', options: ['a', 'b', 'c', 'd'], correctIndex: 0,
        explanation: 'e'
    };

    it('only generates for nodes whose firstSeenChapter matches', async () => {
        const llm = fakeLLM(validPayload);
        const gen = new SRSGenerator({
            storage, readingState: fakeReadingState(), llmClient: llm, settings: SETTINGS
        });
        await storage.saveKGNode(makeNode('A', { firstSeenChapter: 0 }));
        await storage.saveKGNode(makeNode('B', { firstSeenChapter: 1 }));
        await storage.saveKGNode(makeNode('C', { firstSeenChapter: 0 }));

        const cards = await gen.generateForChapter('b1', 0, { maxCards: 5 });
        const ids = cards.flatMap((c) => c.targetNodeIds).sort();
        expect(ids).toEqual(['A', 'C']);
    });
});
