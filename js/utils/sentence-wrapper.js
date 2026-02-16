/**
 * Sentence Wrapper Utility
 * Wraps text content within DOM elements into <span class="sentence"> elements.
 *
 * This module works at the block-element level to correctly handle inline
 * formatting elements (<i>, <a>, <span>, <strong>, etc.) that would otherwise
 * cause a single sentence to be split into multiple fragments.
 */

import { splitIntoSentences } from './sentence-splitter.js';

/** Block-level HTML tags. */
const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG',
    'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
    'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP',
    'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);

/** Tags whose content should not be sentence-split. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

/**
 * Normalize a tag name to uppercase for case-insensitive comparison.
 * XHTML documents (used in EPUBs) have lowercase tag names, while HTML
 * documents use uppercase. This ensures both are handled correctly.
 */
function tag(element) {
    return element.tagName.toUpperCase();
}

/**
 * Check whether an element has any block-level children.
 */
function hasBlockChildren(element) {
    for (const child of element.children) {
        if (BLOCK_TAGS.has(tag(child))) {
            return true;
        }
    }
    return false;
}

/**
 * Collect all text nodes inside `root` in document order,
 * skipping those inside SKIP_TAGS.
 * Includes whitespace-only text nodes so the position map matches textContent.
 */
function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                let parent = node.parentNode;
                while (parent && parent !== root) {
                    if (SKIP_TAGS.has(tag(parent))) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    parent = parent.parentNode;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );
    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }
    return nodes;
}

/**
 * Find the position of `sentence` inside `text` starting from `startFrom`,
 * allowing flexible whitespace matching.
 *
 * Returns { start, end } in the original text, or null if not found.
 */
function findSentenceInText(text, sentence, startFrom) {
    // Exact match first
    const exactIdx = text.indexOf(sentence, startFrom);
    if (exactIdx !== -1) {
        return { start: exactIdx, end: exactIdx + sentence.length };
    }

    // Whitespace-flexible match: replace each whitespace run in the sentence
    // with \s+ so it can match variable whitespace in the original text.
    const escaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexPattern = escaped.replace(/\\?\s+/g, '\\s+');
    const regex = new RegExp(flexPattern);
    const match = regex.exec(text.substring(startFrom));
    if (match) {
        return {
            start: startFrom + match.index,
            end: startFrom + match.index + match[0].length
        };
    }
    return null;
}

/**
 * Build a position-map array for a list of text nodes.
 * Each entry: { node, start, end } where start/end are character offsets
 * in the concatenated text of all nodes.
 */
function buildPositionMap(textNodes) {
    const map = [];
    let pos = 0;
    for (const node of textNodes) {
        const len = node.textContent.length;
        map.push({ node, start: pos, end: pos + len });
        pos += len;
    }
    return map;
}

/**
 * Process a "leaf block" element whose children are entirely inline.
 * Collects the full text, splits into sentences, splits text nodes at
 * sentence boundaries, and wraps each piece in a sentence span.
 *
 * A single sentence that spans multiple inline elements will produce
 * multiple <span class="sentence"> elements sharing the same data-index.
 */
function processLeafBlock(element, sentences) {
    const textNodes = collectTextNodes(element);
    if (textNodes.length === 0) return;

    const posMap = buildPositionMap(textNodes);
    const fullText = posMap.map(e => e.node.textContent).join('');
    if (!fullText.trim()) return;

    const sentenceTexts = splitIntoSentences(fullText);
    if (sentenceTexts.length === 0) return;

    // Locate each sentence in fullText
    const sentenceRanges = [];
    let searchPos = 0;
    for (const rawSentence of sentenceTexts) {
        const trimmed = rawSentence.trim();
        if (!trimmed) continue;

        const loc = findSentenceInText(fullText, trimmed, searchPos);
        if (!loc) continue;

        sentenceRanges.push({
            start: loc.start,
            end: loc.end,
            text: trimmed,
            index: sentences.length
        });
        sentences.push(trimmed);
        searchPos = loc.end;
    }

    if (sentenceRanges.length === 0) return;

    // Collect every character offset where a text-node split is needed.
    const splitPoints = new Set();
    for (const sr of sentenceRanges) {
        splitPoints.add(sr.start);
        splitPoints.add(sr.end);
    }

    // Split text nodes at sentence boundaries (back-to-front so earlier
    // offsets stay valid).
    for (let i = posMap.length - 1; i >= 0; i--) {
        const { node, start, end } = posMap[i];

        // Gather local offsets where this node needs splitting
        const localSplits = [];
        for (const sp of splitPoints) {
            const local = sp - start;
            if (local > 0 && local < end - start) {
                localSplits.push(local);
            }
        }
        if (localSplits.length === 0) continue;

        // Split from back to front within this node
        localSplits.sort((a, b) => b - a);
        for (const offset of localSplits) {
            node.splitText(offset);
        }
    }

    // Re-collect text nodes and rebuild position map after all splits.
    const newTextNodes = collectTextNodes(element);
    const newPosMap = buildPositionMap(newTextNodes);

    // Wrap each text-node portion that belongs to a sentence.
    for (const { node, start, end } of newPosMap) {
        // Which sentence does this text node belong to?
        let matchedSentence = null;
        for (const sr of sentenceRanges) {
            if (start >= sr.start && end <= sr.end) {
                matchedSentence = sr;
                break;
            }
        }
        if (!matchedSentence) continue; // gap / whitespace between sentences

        const span = document.createElement('span');
        span.className = 'sentence';
        span.dataset.index = matchedSentence.index.toString();
        node.parentNode.insertBefore(span, node);
        span.appendChild(node);
    }
}

/**
 * Walk through `element` and wrap text content in sentence spans.
 *
 * For block elements that contain only inline content, the full text
 * is collected across all inline children, split into sentences, and
 * wrapped — correctly handling inline formatting like <i>, <a>, <span>, etc.
 *
 * @param {Element} element  - root element to process
 * @param {string[]} sentences - array that collects plain-text sentences
 */
export function wrapSentencesInElement(element, sentences) {
    if (SKIP_TAGS.has(tag(element))) return;

    if (!hasBlockChildren(element)) {
        // Leaf block: contains only inline content — process as a unit.
        processLeafBlock(element, sentences);
    } else {
        // Container block: recurse into children.
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                if (SKIP_TAGS.has(tag(child))) continue;
                if (BLOCK_TAGS.has(tag(child))) {
                    wrapSentencesInElement(child, sentences);
                } else {
                    // Inline element at container level (rare but possible)
                    processLeafBlock(child, sentences);
                }
            } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
                // Bare text node at container level — process individually.
                // Wrap it in a temporary span so processLeafBlock can operate on it.
                const wrapper = document.createElement('span');
                child.parentNode.insertBefore(wrapper, child);
                wrapper.appendChild(child);
                processLeafBlock(wrapper, sentences);
                // Unwrap: move children back and remove the temporary span
                while (wrapper.firstChild) {
                    wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
                }
                wrapper.remove();
            }
        }
    }
}
