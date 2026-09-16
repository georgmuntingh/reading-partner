import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../js/services/markdown-parser.js';

/**
 * Runs a markdown string through the real chapter pipeline and returns what the
 * reader and the TTS engine each end up with.
 */
async function loadChapter(markdown) {
    const parser = new MarkdownParser();
    const file = {
        name: 'test.md',
        size: markdown.length,
        lastModified: 1,
        text: async () => markdown
    };
    const book = await parser.loadFromFile(file);
    const sentences = await parser.loadChapter(book, 0);
    return { sentences, html: book.chapters[0].html };
}

describe('markdown pipeline: math and speech', () => {
    it('gives the TTS a spoken placeholder instead of LaTeX source', async () => {
        const { sentences } = await loadChapter(
            '# T\n\nThe energy of a quantum is $E = h\\nu$, where $h$ is constant.\n'
        );

        const line = sentences.find((s) => s.includes('quantum'));
        expect(line).toBeTruthy();
        expect(line).toContain('equation');
        expect(line).not.toContain('$');
        expect(line).not.toContain('h\\nu');
    });

    it('keeps a formula from splitting its sentence in two', async () => {
        const { sentences } = await loadChapter(
            '# T\n\nThe energy of a quantum is $E = h\\nu$, where $h$ is constant.\n'
        );

        const line = sentences.find((s) => s.includes('quantum'));
        // One sentence, running from "The" through to the full stop.
        expect(line.trim().endsWith('is constant.')).toBe(true);
    });

    it('handles display math as its own spoken placeholder', async () => {
        const { sentences, html } = await loadChapter(
            '# T\n\nIt follows that:\n\n$$K = h\\nu - \\phi$$\n\nDone.\n'
        );

        expect(sentences.some((s) => s.includes('equation'))).toBe(true);
        expect(html).toContain('data-display="true"');
    });

    it('marks up each formula for rendering, carrying its source', async () => {
        const { html } = await loadChapter('# T\n\nLet $x^2$ be given.\n');

        expect(html).toContain('class="math math-inline sentence"');
        expect(html).toContain('data-latex="x^2"');
    });

    it('gives a formula the sentence index of the sentence around it', async () => {
        const { html } = await loadChapter(
            '# T\n\nFirst one. The value $x$ matters here.\n'
        );

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const math = doc.querySelector('span.math');
        const before = math.previousElementSibling;

        expect(math.dataset.index).toBeDefined();
        expect(math.dataset.index).toBe(before.dataset.index);
        expect(math.classList.contains('sentence')).toBe(true);
    });

    it('gives standalone display maths a sentence index of its own', async () => {
        const { html } = await loadChapter('# T\n\nIt follows:\n\n$$K = h\\nu$$\n');

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const math = doc.querySelector('span.math-display');

        // Nothing either side of it in its paragraph, so it has to take the
        // index from the sentence span wrapped around its placeholder text.
        expect(math.previousElementSibling).toBeNull();
        expect(math.dataset.index).toBeDefined();
        expect(math.classList.contains('sentence')).toBe(true);
    });

    it('leaves prose containing prices completely alone', async () => {
        const { sentences, html } = await loadChapter(
            '# T\n\nA spectrometer cost $200 and $500 back then.\n'
        );

        expect(html).not.toContain('span class="math');
        expect(sentences.some((s) => s.includes('$200 and $500'))).toBe(true);
    });

    it('does not touch maths-looking text inside code spans', async () => {
        const { html } = await loadChapter('# T\n\nUse `$HOME` and `$PATH` here.\n');
        expect(html).not.toContain('span class="math');
    });

    it('still produces ordinary paragraphs for prose with no maths', async () => {
        const { sentences, html } = await loadChapter(
            '# T\n\nFirst paragraph here.\n\nSecond paragraph here.\n'
        );

        expect(html).toContain('<p>');
        expect(sentences.length).toBeGreaterThanOrEqual(3);
    });
});
