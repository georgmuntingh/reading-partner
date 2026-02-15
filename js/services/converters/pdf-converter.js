/**
 * PDF to Markdown Converter
 *
 * Modular converter that transforms a PDF ArrayBuffer into structured Markdown.
 * Uses pdf.js (pdfjs-dist) for client-side text extraction with position/font data,
 * then applies heuristics to infer headings and paragraphs.
 *
 * This module is designed to be swappable — the only public interface is:
 *   convertPdfToMarkdown(arrayBuffer) => Promise<{ title, chapters: [{ title, markdown }] }>
 *
 * Each PDF page becomes one chapter. The converter infers headings from font size
 * and groups text items into lines and paragraphs based on spatial proximity.
 */

/* global pdfjsLib */

/**
 * Convert a PDF ArrayBuffer to structured Markdown chapters (one per page).
 * @param {ArrayBuffer} arrayBuffer - The raw PDF file data
 * @returns {Promise<{ title: string, chapters: Array<{ title: string, markdown: string }> }>}
 */
export async function convertPdfToMarkdown(arrayBuffer) {
    if (typeof pdfjsLib === 'undefined') {
        throw new Error('pdf.js library is not loaded. Please ensure pdfjs-dist is available.');
    }

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;

    // Try to extract title from PDF metadata
    const metadata = await pdf.getMetadata().catch(() => null);
    const title = metadata?.info?.Title || '';

    const chapters = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });

        const markdown = _pageToMarkdown(textContent, viewport);

        chapters.push({
            title: `Page ${pageNum}`,
            markdown
        });
    }

    return { title, chapters };
}

/**
 * Convert a single page's text content to Markdown.
 * @param {Object} textContent - pdf.js text content object with items array
 * @param {Object} viewport - pdf.js viewport for coordinate reference
 * @returns {string} Markdown text for this page
 */
function _pageToMarkdown(textContent, viewport) {
    const items = textContent.items;
    if (!items || items.length === 0) {
        return '';
    }

    // Collect font sizes used and compute the median to determine "body" size
    const fontSizes = items
        .filter(item => item.str && item.str.trim())
        .map(item => _getFontSize(item));

    if (fontSizes.length === 0) {
        return '';
    }

    const medianFontSize = _median(fontSizes);

    // Group text items into lines based on vertical position (y-coordinate)
    const lines = _groupIntoLines(items, viewport);

    // Build markdown by accumulating body text lines into paragraphs.
    // PDF line breaks within a paragraph are joined with spaces so that
    // the resulting Markdown has flowing text (no embedded newlines that
    // would break sentence detection in the downstream pipeline).
    const markdownParts = [];
    let currentParagraph = [];
    let prevLineY = null; // baseline y of the previous line

    for (const line of lines) {
        if (!line.text.trim()) continue;

        const lineSize = line.avgFontSize;
        const isLarger = lineSize > medianFontSize * 1.25;
        const isMuchLarger = lineSize > medianFontSize * 1.6;

        // Detect paragraph breaks from baseline-to-baseline distance
        let isParaBreak = false;
        if (prevLineY !== null) {
            const baselineDistance = prevLineY - line.top; // positive going down
            // Normal line spacing is ~1.2–1.5x font size; a gap above ~1.8x
            // indicates an extra vertical skip (paragraph break, section gap, etc.)
            if (baselineDistance > lineSize * 1.8) {
                isParaBreak = true;
            }
        }

        const trimmedText = line.text.trim();

        // Flush accumulated paragraph on break or heading
        if ((isParaBreak || isLarger || isMuchLarger) && currentParagraph.length > 0) {
            markdownParts.push(currentParagraph.join(' '));
            markdownParts.push('');
            currentParagraph = [];
        }

        if (isMuchLarger) {
            markdownParts.push(`# ${trimmedText}`);
            markdownParts.push('');
        } else if (isLarger) {
            markdownParts.push(`## ${trimmedText}`);
            markdownParts.push('');
        } else {
            currentParagraph.push(trimmedText);
        }

        prevLineY = line.top;
    }

    // Flush remaining paragraph
    if (currentParagraph.length > 0) {
        markdownParts.push(currentParagraph.join(' '));
    }

    return markdownParts.join('\n');
}

/**
 * Group text items into lines based on y-coordinate proximity.
 * Items on the same horizontal baseline (within tolerance) form a single line.
 * @param {Array} items - pdf.js text content items
 * @param {Object} viewport - page viewport
 * @returns {Array<{ text: string, top: number, bottom: number, avgFontSize: number }>}
 */
function _groupIntoLines(items, viewport) {
    if (items.length === 0) return [];

    // Extract position and text from each item
    const positioned = items
        .filter(item => item.str) // skip empty items
        .map(item => {
            const fontSize = _getFontSize(item);
            // transform[5] is the y-position in PDF coordinates (bottom-up)
            const y = item.transform[5];
            const x = item.transform[4];
            return {
                text: item.str,
                x,
                y,
                fontSize,
                width: item.width || 0
            };
        });

    if (positioned.length === 0) return [];

    // Sort by y descending (top of page first), then by x ascending (left to right)
    positioned.sort((a, b) => {
        const yDiff = b.y - a.y;
        if (Math.abs(yDiff) > 2) return yDiff;
        return a.x - b.x;
    });

    // Group into lines: items within a small y-tolerance belong to the same line
    const lines = [];
    let currentLine = {
        items: [positioned[0]],
        y: positioned[0].y
    };

    for (let i = 1; i < positioned.length; i++) {
        const item = positioned[i];
        const yTolerance = Math.max(currentLine.items[0].fontSize * 0.5, 3);

        if (Math.abs(item.y - currentLine.y) <= yTolerance) {
            currentLine.items.push(item);
        } else {
            lines.push(_finalizeLine(currentLine));
            currentLine = { items: [item], y: item.y };
        }
    }
    lines.push(_finalizeLine(currentLine));

    return lines;
}

/**
 * Finalize a line group into a single line object.
 * Sorts items left-to-right and concatenates text with appropriate spacing.
 * @param {Object} lineGroup - { items, y }
 * @returns {{ text: string, top: number, bottom: number, avgFontSize: number }}
 */
function _finalizeLine(lineGroup) {
    const items = lineGroup.items.sort((a, b) => a.x - b.x);
    const avgFontSize = items.reduce((sum, it) => sum + it.fontSize, 0) / items.length;

    let text = '';
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (i > 0) {
            // Add space between items if there's a gap
            const prevItem = items[i - 1];
            const gap = item.x - (prevItem.x + prevItem.width);
            if (gap > avgFontSize * 0.3) {
                text += ' ';
            }
        }
        text += item.text;
    }

    return {
        text,
        top: lineGroup.y,
        bottom: lineGroup.y - avgFontSize,
        avgFontSize
    };
}

/**
 * Extract font size from a text content item.
 * The font size is derived from the transform matrix.
 * @param {Object} item - pdf.js text content item
 * @returns {number}
 */
function _getFontSize(item) {
    // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY]
    // Font size is typically abs(scaleY) or abs(scaleX)
    const scaleY = Math.abs(item.transform[3]);
    const scaleX = Math.abs(item.transform[0]);
    return Math.max(scaleY, scaleX) || 12; // fallback to 12 if zero
}

/**
 * Compute the median of a number array.
 * @param {number[]} arr
 * @returns {number}
 */
function _median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
