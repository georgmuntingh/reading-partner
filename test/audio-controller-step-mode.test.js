import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The controller talks to a real TTS engine and a logger; neither belongs in a
// unit test of the playback loop.
vi.mock('../js/services/tts-engine.js', () => ({
    ttsEngine: {
        playBuffer: vi.fn().mockResolvedValue(undefined),
        stopAudio: vi.fn(),
        generateAudio: vi.fn()
    }
}));
vi.mock('../js/services/app-logger.js', () => ({
    appLogger: { enabled: false, info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { AudioController } = await import('../js/controllers/audio-controller.js');
const { ttsEngine } = await import('../js/services/tts-engine.js');

const SENTENCES = ['One.', 'Two.', 'Three.'];

let controller;
let sentenceChanges;
let states;
let chapterEnds;

/**
 * Build a controller whose buffers are already "generated", so the loop never
 * waits on audio synthesis.
 */
function makeController(sentences = SENTENCES) {
    sentenceChanges = [];
    states = [];
    chapterEnds = 0;

    const c = new AudioController({
        onSentenceChange: (i) => sentenceChanges.push(i),
        onStateChange: (s) => states.push({ ...s }),
        onChapterEnd: () => { chapterEnds++; }
    });

    // Stand in for TTS synthesis: every sentence has a ready buffer.
    c._generateBuffer = vi.fn(async (index) => {
        const buffer = { duration: 0.1, index };
        c._bufferQueue.set(index, buffer);
        return buffer;
    });
    c._maintainBuffer = vi.fn();

    c.setSentences(sentences, 0);
    return c;
}

beforeEach(() => {
    ttsEngine.playBuffer.mockClear();
    controller = makeController();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('continuous playback (step mode off)', () => {
    it('reads every sentence in one go', async () => {
        await controller.play();

        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(3);
        expect(sentenceChanges).toEqual([0, 1, 2]);
    });

    it('reports the chapter end when it runs out of sentences', async () => {
        await controller.play();

        expect(chapterEnds).toBe(1);
        expect(controller.getState().status).toBe('stopped');
    });
});

describe('step mode', () => {
    beforeEach(() => {
        controller.setStepMode(true);
    });

    it('reads a single sentence and stops', async () => {
        await controller.play();

        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(1);
        expect(controller.getState().status).toBe('paused');
    });

    it('leaves the highlight on the sentence Play will read next', async () => {
        await controller.play();

        expect(controller.getCurrentIndex()).toBe(1);
        expect(sentenceChanges[sentenceChanges.length - 1]).toBe(1);
    });

    it('walks forward one sentence per Play', async () => {
        await controller.play();
        expect(controller.getCurrentIndex()).toBe(1);

        await controller.play();
        expect(controller.getCurrentIndex()).toBe(2);
        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(2);
    });

    it('still reports the chapter end after the last sentence', async () => {
        await controller.play();
        await controller.play();
        expect(chapterEnds).toBe(0);

        await controller.play(); // reads the third and final sentence
        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(3);
        expect(chapterEnds).toBe(1);
        expect(controller.getState().status).toBe('stopped');
    });

    it('keeps buffering ahead so the next Play starts without a wait', async () => {
        await controller.play();
        expect(controller._maintainBuffer).toHaveBeenCalled();
    });

    it('goes back to continuous playback when switched off', async () => {
        await controller.play();
        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(1);

        controller.setStepMode(false);
        await controller.play();

        // Sentences two and three, back to back.
        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(3);
        expect(chapterEnds).toBe(1);
    });

    it('starts from an explicit index like normal playback', async () => {
        await controller.play(2);

        expect(ttsEngine.playBuffer).toHaveBeenCalledTimes(1);
        expect(chapterEnds).toBe(1);
    });

    it('reports its own state', () => {
        expect(controller.getStepMode()).toBe(true);
        controller.setStepMode(false);
        expect(controller.getStepMode()).toBe(false);
    });

    it('treats a one-sentence chapter as a chapter end, not a step pause', async () => {
        const single = makeController(['Only one.']);
        single.setStepMode(true);
        await single.play();

        // Single-sentence chapter: the increment runs past the end, so this is
        // a chapter end rather than a step pause.
        expect(chapterEnds).toBe(1);
        expect(single.getState().status).toBe('stopped');
    });
});
