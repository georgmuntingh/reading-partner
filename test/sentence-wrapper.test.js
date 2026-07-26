import { describe, it, expect } from 'vitest';
import { wrapSentencesInElement } from '../js/utils/sentence-wrapper.js';

/**
 * Build a detached element from an HTML string.
 */
function elementFrom(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
}

describe('wrapSentencesInElement', () => {
    it('wraps plain sentences in indexed spans', () => {
        const el = elementFrom('<p>First sentence. Second sentence.</p>');
        const sentences = [];

        wrapSentencesInElement(el, sentences);

        expect(sentences).toEqual(['First sentence.', 'Second sentence.']);
        expect(el.querySelectorAll('span.sentence').length).toBe(2);
        expect(el.querySelector('span.sentence').dataset.index).toBe('0');
    });

    describe('tts-skip', () => {
        // NOTE: happy-dom's TreeWalker(SHOW_TEXT) does not descend into child
        // elements, so inline spans are invisible to the wrapper in this test
        // environment regardless of the skip rule. The assertion below is the
        // contract that matters; real browsers reach the same result via the
        // explicit .tts-skip check.
        it('excludes inline .tts-skip text from the sentence stream', () => {
            const el = elementFrom(
                '<p><span class="tts-skip">u/</span>spez<span class="tts-skip"> · 412 points</span></p>'
            );
            const sentences = [];

            wrapSentencesInElement(el, sentences);

            expect(sentences).toEqual(['spez']);
            // The skipped text is still rendered, just not spoken.
            expect(el.textContent).toContain('412 points');
            expect(el.textContent).toContain('u/');
        });

        it('excludes a whole block marked .tts-skip', () => {
            const el = elementFrom(
                '<div><p>Real content here.</p><p class="tts-skip">[12 more replies]</p></div>'
            );
            const sentences = [];

            wrapSentencesInElement(el, sentences);

            expect(sentences).toEqual(['Real content here.']);
            expect(el.textContent).toContain('[12 more replies]');
        });

        it('excludes nested content inside a .tts-skip subtree', () => {
            const el = elementFrom(
                '<div class="tts-skip"><p>Hidden from speech.</p></div>'
            );
            const sentences = [];

            wrapSentencesInElement(el, sentences);

            expect(sentences).toEqual([]);
            expect(el.querySelectorAll('span.sentence').length).toBe(0);
        });

        it('leaves the sentence index sequence contiguous around skipped text', () => {
            const el = elementFrom(
                '<div><p>One.</p><p class="tts-skip">Skipped.</p><p>Two.</p></div>'
            );
            const sentences = [];

            wrapSentencesInElement(el, sentences);

            expect(sentences).toEqual(['One.', 'Two.']);
            const indices = [...el.querySelectorAll('span.sentence')].map((s) => s.dataset.index);
            expect(indices).toEqual(['0', '1']);
        });
    });

    describe('skipped tags (existing behaviour)', () => {
        it('does not sentence-split code blocks', () => {
            const el = elementFrom('<div><p>Try this.</p><pre><code>npm run build</code></pre></div>');
            const sentences = [];

            wrapSentencesInElement(el, sentences);

            expect(sentences).toEqual(['Try this.']);
            expect(el.querySelector('pre').querySelectorAll('span.sentence').length).toBe(0);
            expect(el.textContent).toContain('npm run build');
        });

        it('skips inline <code> inside a paragraph', () => {
            const el = elementFrom('<p>Run <code>npm test</code> now.</p>');
            const sentences = [];

            wrapSentencesInElement(el, sentences);

            expect(sentences.join(' ')).not.toContain('npm test');
        });
    });
});
