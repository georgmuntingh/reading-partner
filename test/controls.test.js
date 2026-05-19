import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlaybackControls } from '../js/ui/controls.js';

/**
 * Helper: render a minimal set of buttons that satisfies the
 * PlaybackControls constructor and return refs to the new SRS button
 * along with the controller instance. The other buttons are present
 * but their behaviour isn't the subject of these tests.
 */
const mount = (callbacks = {}) => {
    document.body.innerHTML = `
        <button id="play"></button><span id="play-icon"></span><span id="pause-icon"></span>
        <button id="prev"></button><button id="next"></button>
        <button id="prev-chapter"></button><button id="next-chapter"></button>
        <button id="ask"></button>
        <button id="quiz"></button>
        <button id="srs"></button>
    `;
    const cb = {
        onPlay: vi.fn(), onPause: vi.fn(),
        onPrev: vi.fn(), onNext: vi.fn(),
        onPrevChapter: vi.fn(), onNextChapter: vi.fn(),
        onAsk: vi.fn(), onQuiz: vi.fn(),
        onSRS: vi.fn(),
        ...callbacks
    };
    const controls = new PlaybackControls({
        playBtn: document.getElementById('play'),
        playIcon: document.getElementById('play-icon'),
        pauseIcon: document.getElementById('pause-icon'),
        prevBtn: document.getElementById('prev'),
        nextBtn: document.getElementById('next'),
        prevChapterBtn: document.getElementById('prev-chapter'),
        nextChapterBtn: document.getElementById('next-chapter'),
        askBtn: document.getElementById('ask'),
        quizBtn: document.getElementById('quiz'),
        srsBtn: document.getElementById('srs')
    }, cb);
    return { controls, cb };
};

const mountWithoutSrs = () => {
    document.body.innerHTML = `
        <button id="play"></button><span id="play-icon"></span><span id="pause-icon"></span>
        <button id="prev"></button><button id="next"></button>
        <button id="prev-chapter"></button><button id="next-chapter"></button>
        <button id="ask"></button>
        <button id="quiz"></button>
    `;
    const cb = {
        onPlay: vi.fn(), onPause: vi.fn(),
        onPrev: vi.fn(), onNext: vi.fn(),
        onPrevChapter: vi.fn(), onNextChapter: vi.fn(),
        onAsk: vi.fn(), onQuiz: vi.fn()
        // No onSRS, no srsBtn option.
    };
    const controls = new PlaybackControls({
        playBtn: document.getElementById('play'),
        playIcon: document.getElementById('play-icon'),
        pauseIcon: document.getElementById('pause-icon'),
        prevBtn: document.getElementById('prev'),
        nextBtn: document.getElementById('next'),
        prevChapterBtn: document.getElementById('prev-chapter'),
        nextChapterBtn: document.getElementById('next-chapter'),
        askBtn: document.getElementById('ask'),
        quizBtn: document.getElementById('quiz')
    }, cb);
    return { controls, cb };
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('PlaybackControls — SRS button wiring (Phase 11)', () => {
    it('clicking #srs invokes the onSRS callback exactly once', () => {
        const { cb } = mount();
        document.getElementById('srs').click();
        expect(cb.onSRS).toHaveBeenCalledTimes(1);
    });

    it('does not call onQuiz when the SRS button is clicked', () => {
        const { cb } = mount();
        document.getElementById('srs').click();
        expect(cb.onQuiz).not.toHaveBeenCalled();
    });

    it('setEnabled(false) disables the SRS button alongside Quiz and Ask', () => {
        const { controls } = mount();
        controls.setEnabled(false);
        expect(document.getElementById('srs').disabled).toBe(true);
        expect(document.getElementById('quiz').disabled).toBe(true);
        expect(document.getElementById('ask').disabled).toBe(true);
    });

    it('setEnabled(true) re-enables the SRS button', () => {
        const { controls } = mount();
        controls.setEnabled(false);
        controls.setEnabled(true);
        expect(document.getElementById('srs').disabled).toBe(false);
    });

    it('omitting srsBtn keeps the controls fully functional (backward compatibility)', () => {
        const { controls, cb } = mountWithoutSrs();
        // Clicking quiz should still work — the missing srsBtn must not
        // throw during construction or break the rest of the wiring.
        document.getElementById('quiz').click();
        expect(cb.onQuiz).toHaveBeenCalledTimes(1);
        controls.setEnabled(false);
        expect(document.getElementById('quiz').disabled).toBe(true);
    });

    it('onSRS callback is optional even when srsBtn is provided', () => {
        document.body.innerHTML = `
            <button id="play"></button><span id="play-icon"></span><span id="pause-icon"></span>
            <button id="prev"></button><button id="next"></button>
            <button id="prev-chapter"></button><button id="next-chapter"></button>
            <button id="ask"></button>
            <button id="quiz"></button>
            <button id="srs"></button>
        `;
        new PlaybackControls({
            playBtn: document.getElementById('play'),
            playIcon: document.getElementById('play-icon'),
            pauseIcon: document.getElementById('pause-icon'),
            prevBtn: document.getElementById('prev'),
            nextBtn: document.getElementById('next'),
            prevChapterBtn: document.getElementById('prev-chapter'),
            nextChapterBtn: document.getElementById('next-chapter'),
            askBtn: document.getElementById('ask'),
            quizBtn: document.getElementById('quiz'),
            srsBtn: document.getElementById('srs')
        }, {
            onPlay: vi.fn(), onPause: vi.fn(),
            onPrev: vi.fn(), onNext: vi.fn(),
            onPrevChapter: vi.fn(), onNextChapter: vi.fn(),
            onAsk: vi.fn(), onQuiz: vi.fn()
            // intentionally no onSRS
        });
        expect(() => document.getElementById('srs').click()).not.toThrow();
    });
});
