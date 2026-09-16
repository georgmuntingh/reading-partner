import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    substituteMath,
    renderMathIn,
    renderMarkdownInto,
    MATH_PLACEHOLDER
} from '../js/utils/math-renderer.js';

let root;

beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root');
});

/** The latex captured by each placeholder, in document order. */
function latexes(el = root) {
    return [...el.querySelectorAll('span.math')].map((s) => s.dataset.latex);
}

describe('substituteMath', () => {
    it('replaces inline math with a spoken placeholder', () => {
        root.innerHTML = '<p>The energy is $E = mc^2$ exactly.</p>';

        expect(substituteMath(root)).toBe(1);
        expect(latexes()).toEqual(['E = mc^2']);
        expect(root.querySelector('span.math').textContent).toBe(MATH_PLACEHOLDER);
        expect(root.textContent).toBe(`The energy is ${MATH_PLACEHOLDER} exactly.`);
    });

    it('marks display math from double dollars', () => {
        root.innerHTML = '<p>$$a^2 + b^2 = c^2$$</p>';

        substituteMath(root);
        const el = root.querySelector('span.math');
        expect(el.dataset.latex).toBe('a^2 + b^2 = c^2');
        expect(el.dataset.display).toBe('true');
        expect(el.classList.contains('math-display')).toBe(true);
    });

    it('handles several formulas in one text node', () => {
        root.innerHTML = '<p>Given $x$ and $y$, then $z$.</p>';

        expect(substituteMath(root)).toBe(3);
        expect(latexes()).toEqual(['x', 'y', 'z']);
    });

    it('keeps display and inline math straight when both appear', () => {
        root.innerHTML = '<p>Inline $a$ then display $$b$$ done.</p>';

        substituteMath(root);
        const els = [...root.querySelectorAll('span.math')];
        expect(els.map((e) => e.dataset.latex)).toEqual(['a', 'b']);
        expect(els[0].dataset.display).toBeUndefined();
        expect(els[1].dataset.display).toBe('true');
    });

    it('leaves text either side of the formula intact', () => {
        root.innerHTML = '<p>before $x$ after</p>';
        substituteMath(root);
        expect(root.querySelector('p').childNodes[0].nodeValue).toBe('before ');
        expect(root.querySelector('p').childNodes[2].nodeValue).toBe(' after');
    });

    it('sees math inside inline formatting', () => {
        root.innerHTML = '<p>An <em>italic $x$ phrase</em>.</p>';
        expect(substituteMath(root)).toBe(1);
        expect(root.querySelector('em span.math')).toBeTruthy();
    });
});

describe('substituteMath: things that are not math', () => {
    it('leaves prices alone', () => {
        root.innerHTML = '<p>It cost $5 and $10 in total.</p>';

        expect(substituteMath(root)).toBe(0);
        expect(root.textContent).toBe('It cost $5 and $10 in total.');
    });

    it('ignores a dollar with spaces inside the delimiters', () => {
        root.innerHTML = '<p>from $ 5 to $ 9</p>';
        expect(substituteMath(root)).toBe(0);
    });

    it('ignores a lone dollar sign', () => {
        root.innerHTML = '<p>Costs $ and time.</p>';
        expect(substituteMath(root)).toBe(0);
    });

    it('does not touch code or pre blocks', () => {
        root.innerHTML = '<p><code>$x$</code></p><pre>$y$</pre>';

        expect(substituteMath(root)).toBe(0);
        expect(root.textContent).toBe('$x$$y$');
    });

    it('does not let inline math span a line break', () => {
        root.innerHTML = '<p>cost $5\nand $6</p>';
        expect(substituteMath(root)).toBe(0);
    });

    it('is a no-op on text with no dollars at all', () => {
        root.innerHTML = '<p>Plain prose.</p>';
        expect(substituteMath(root)).toBe(0);
    });

    it('tolerates a null root', () => {
        expect(substituteMath(null)).toBe(0);
    });
});

describe('renderMathIn', () => {
    it('renders a placeholder into KaTeX output', () => {
        root.innerHTML = '<p>$E = mc^2$</p>';
        substituteMath(root);

        expect(renderMathIn(root)).toBe(1);
        const el = root.querySelector('span.math');
        expect(el.querySelector('.katex')).toBeTruthy();
        expect(el.textContent).not.toBe(MATH_PLACEHOLDER);
    });

    it('keeps the latex source on the element for re-rendering', () => {
        root.innerHTML = '<p>$x^2$</p>';
        substituteMath(root);
        renderMathIn(root);

        expect(root.querySelector('span.math').dataset.latex).toBe('x^2');
        expect(root.querySelector('span.math').dataset.rendered).toBe('true');
    });

    it('falls back to the original source when the latex is malformed', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        root.innerHTML = '<p>$\\frac{$</p>';
        substituteMath(root);
        renderMathIn(root);

        const el = root.querySelector('span.math');
        // Either KaTeX rendered its own error markup, or we restored the source;
        // what must not happen is an exception or an empty element.
        expect(el.textContent.length).toBeGreaterThan(0);
    });

    it('renders nothing when there are no placeholders', () => {
        root.innerHTML = '<p>Plain.</p>';
        expect(renderMathIn(root)).toBe(0);
    });

    it('tolerates a null root', () => {
        expect(renderMathIn(null)).toBe(0);
    });
});

describe('renderMarkdownInto', () => {
    it('parses markdown and renders its math in one step', () => {
        renderMarkdownInto(root, 'Energy is $E = mc^2$ per Einstein.');

        expect(root.querySelector('p')).toBeTruthy();
        expect(root.querySelector('span.math .katex')).toBeTruthy();
    });

    it('does not treat fenced code as math', () => {
        renderMarkdownInto(root, '```\n$x$\n```');
        expect(root.querySelector('span.math')).toBeNull();
    });

    it('tolerates empty input', () => {
        renderMarkdownInto(root, '');
        expect(root.innerHTML).toBe('');
    });
});
