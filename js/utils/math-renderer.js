/**
 * Math Renderer Utility
 *
 * Renders LaTeX written between dollar delimiters: `$...$` inline and
 * `$$...$$` as a centred display block.
 *
 * The work is split into two passes because the reader needs to extract
 * sentences in between them:
 *
 *   substituteMath(root)  replaces each math run with a placeholder element
 *                         whose *text* is a single spoken word. Sentence
 *                         splitting then sees ordinary prose, so a formula
 *                         cannot break a sentence in half, and the TTS says
 *                         "equation" instead of reading LaTeX source aloud.
 *
 *   renderMathIn(root)    swaps those placeholders for KaTeX output. Run it
 *                         after the HTML is in the live DOM.
 *
 * Callers with no text-to-speech concern (Q&A answers, previews) can just use
 * `renderMarkdownInto`, which does both.
 */

import katex from 'katex';
// Bundled rather than pulled from a CDN so equations still render in the
// offline Android build and on cached web visits.
import 'katex/dist/katex.min.css';
import { marked } from 'marked';

/** The word spoken in place of an equation. */
export const MATH_PLACEHOLDER = 'equation';

/** Tags whose text must never be treated as math. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

/**
 * Display math: `$$ ... $$`, possibly spanning lines.
 * Inline math: `$ ... $` on one line.
 *
 * Both require the content to start and end with a non-space character, which
 * is the usual convention and keeps "a $ b" from matching. Inline math
 * additionally rejects a closing `$` that is followed by a digit, so a sentence
 * like "it cost $5 and $10" is left alone.
 *
 * This is a heuristic: prose that mixes currency with real math can still be
 * misread. Nothing downstream can catch that, because KaTeX renders arbitrary
 * text rather than rejecting it.
 */
const DISPLAY_MATH = /\$\$(\S(?:[\s\S]*?\S)?)\$\$/;
const INLINE_MATH = /\$(\S(?:[^$\n]*\S)?)\$(?!\d)/;

/**
 * Find the first math run in a string.
 * @param {string} text
 * @returns {{ index: number, length: number, latex: string, display: boolean }|null}
 */
function findMath(text) {
    const display = DISPLAY_MATH.exec(text);
    const inline = INLINE_MATH.exec(text);

    // Prefer whichever starts first; on a tie the display form wins, since
    // `$$x$$` also matches the inline pattern at the same offset.
    if (display && (!inline || display.index <= inline.index)) {
        return { index: display.index, length: display[0].length, latex: display[1], display: true };
    }
    if (inline) {
        return { index: inline.index, length: inline[0].length, latex: inline[1], display: false };
    }
    return null;
}

/**
 * Build the placeholder element for one math run.
 * @param {Document} doc
 * @param {string} latex
 * @param {boolean} display
 * @returns {HTMLElement}
 */
function createPlaceholder(doc, latex, display) {
    const el = doc.createElement('span');
    el.className = display ? 'math math-display' : 'math math-inline';
    el.dataset.latex = latex;
    if (display) el.dataset.display = 'true';
    // Text content is what sentence-splitting and the TTS will see.
    el.textContent = MATH_PLACEHOLDER;
    return el;
}

/**
 * Replace every `$...$` / `$$...$$` run under `root` with a placeholder element.
 * Safe to call more than once: placeholders contain no dollar signs.
 * @param {Element} root
 * @returns {number} How many math runs were substituted.
 */
export function substituteMath(root) {
    if (!root) return 0;

    const doc = root.ownerDocument || document;

    // Collect the candidate text nodes with a plain recursive walk rather than
    // a TreeWalker: a TreeWalker built with a filter object yields nothing
    // under happy-dom, which would make this silently untestable.
    const textNodes = [];
    const collect = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                if (child.nodeValue && child.nodeValue.indexOf('$') !== -1) {
                    textNodes.push(child);
                }
            } else if (child.nodeType === 1) {
                if (!SKIP_TAGS.has(child.tagName.toUpperCase())) collect(child);
            }
        }
    };
    collect(root);

    let count = 0;
    for (const node of textNodes) {
        let remaining = node.nodeValue;
        let match = findMath(remaining);
        if (!match) continue;

        const fragment = doc.createDocumentFragment();
        while (match) {
            if (match.index > 0) {
                fragment.appendChild(doc.createTextNode(remaining.slice(0, match.index)));
            }
            fragment.appendChild(createPlaceholder(doc, match.latex, match.display));
            count++;
            remaining = remaining.slice(match.index + match.length);
            match = findMath(remaining);
        }
        if (remaining) fragment.appendChild(doc.createTextNode(remaining));

        node.parentNode.replaceChild(fragment, node);
    }

    return count;
}

/**
 * Give each math placeholder the sentence index of the sentence it sits in.
 *
 * `wrapSentencesInElement` does wrap the placeholder's own text, but that span
 * lives *inside* the math element -- and `renderMathIn` later replaces the
 * element's contents wholesale, taking the span with it. Copying the index onto
 * the math element itself puts it somewhere KaTeX will not overwrite, so the
 * formula still highlights along with the rest of its sentence.
 *
 * Call it after sentence wrapping.
 * @param {Element} root
 * @returns {number} How many placeholders were attached to a sentence.
 */
export function assignMathToSentences(root) {
    if (!root) return 0;

    const isSentence = (el) => el?.classList?.contains('sentence') && el.dataset.index !== undefined;
    let count = 0;

    for (const el of root.querySelectorAll('span.math')) {
        // The span the wrapper put around the placeholder's own text is the
        // most direct answer, and the only one for display maths that stands
        // alone in its paragraph with no sentence siblings either side.
        let source = el.querySelector('.sentence[data-index]');

        // Otherwise borrow from the sentence this formula continues, or the
        // one it runs into for a formula that opens a sentence.
        if (!source) {
            source = el.previousElementSibling;
            while (source && !isSentence(source)) source = source.previousElementSibling;
        }
        if (!source) {
            source = el.nextElementSibling;
            while (source && !isSentence(source)) source = source.nextElementSibling;
        }

        if (!source) continue;

        el.classList.add('sentence');
        el.dataset.index = source.dataset.index;
        count++;
    }

    return count;
}

/**
 * Render every placeholder under `root` with KaTeX.
 * A formula KaTeX cannot parse is left as its original source text, so a
 * malformed equation degrades to what the reader would have seen anyway.
 * @param {Element} root
 * @returns {number} How many placeholders were rendered.
 */
export function renderMathIn(root) {
    if (!root) return 0;

    const placeholders = root.querySelectorAll('span.math[data-latex]');
    let count = 0;

    for (const el of placeholders) {
        const latex = el.dataset.latex;
        const display = el.dataset.display === 'true';
        try {
            katex.render(latex, el, {
                displayMode: display,
                throwOnError: false,
                output: 'html'
            });
            // Keep the source around so a re-render (after repagination, say)
            // is idempotent, and mark it done so we do not redo the work.
            el.dataset.rendered = 'true';
            count++;
        } catch (error) {
            console.warn('Failed to render equation:', latex, error);
            el.textContent = display ? `$$${latex}$$` : `$${latex}$`;
        }
    }

    return count;
}

/**
 * Parse markdown and render it, math included, into an element.
 * For surfaces with no text-to-speech involvement.
 * @param {Element} element - Destination; its contents are replaced.
 * @param {string} markdown
 */
export function renderMarkdownInto(element, markdown) {
    if (!element) return;
    element.innerHTML = marked.parse(markdown || '');
    substituteMath(element);
    renderMathIn(element);
}
