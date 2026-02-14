/**
 * Format Detector Utility
 * Auto-detects whether pasted content is HTML, Markdown, or Plain Text.
 */

/**
 * Detected format types
 * @typedef {'html' | 'markdown' | 'plaintext'} DetectedFormat
 */

/**
 * Detect the format of pasted text content.
 * Priority: HTML > Markdown > Plain Text
 *
 * @param {string} text - The pasted text content
 * @returns {DetectedFormat}
 */
export function detectPastedFormat(text) {
    if (!text || !text.trim()) {
        return 'plaintext';
    }

    if (looksLikeHtml(text)) {
        return 'html';
    }

    if (looksLikeMarkdown(text)) {
        return 'markdown';
    }

    return 'plaintext';
}

/**
 * Check if text looks like HTML content.
 * Looks for structural HTML tags (not just inline like <b> or <i>).
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeHtml(text) {
    // Check for common structural HTML tags
    const htmlTagPattern = /<(?:html|head|body|div|p|h[1-6]|ul|ol|li|table|section|article|header|footer|nav|main|form|pre|blockquote)\b[^>]*>/i;
    if (htmlTagPattern.test(text)) {
        return true;
    }

    // Check for DOCTYPE or html tags
    if (/^\s*<!DOCTYPE\s+html/i.test(text)) {
        return true;
    }

    // Check for multiple closing tags (strong signal)
    const closingTags = text.match(/<\/[a-z][a-z0-9]*>/gi);
    if (closingTags && closingTags.length >= 3) {
        return true;
    }

    return false;
}

/**
 * Check if text looks like Markdown content.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeMarkdown(text) {
    let signals = 0;

    // ATX headings: # Heading
    if (/^#{1,6}\s+\S/m.test(text)) {
        signals += 2;
    }

    // Bold/italic: **text** or __text__ or *text* or _text_
    if (/\*{1,2}[^*\s][^*]*\*{1,2}/.test(text) || /_{1,2}[^_\s][^_]*_{1,2}/.test(text)) {
        signals += 1;
    }

    // Links: [text](url)
    if (/\[[^\]]+\]\([^)]+\)/.test(text)) {
        signals += 2;
    }

    // Images: ![alt](url)
    if (/!\[[^\]]*\]\([^)]+\)/.test(text)) {
        signals += 2;
    }

    // Code blocks: ```
    if (/^```/m.test(text)) {
        signals += 2;
    }

    // Inline code: `code`
    if (/`[^`]+`/.test(text)) {
        signals += 1;
    }

    // Unordered lists: - item or * item
    if (/^[\s]*[-*+]\s+\S/m.test(text)) {
        signals += 1;
    }

    // Ordered lists: 1. item
    if (/^\s*\d+\.\s+\S/m.test(text)) {
        signals += 1;
    }

    // Blockquotes: > text
    if (/^>\s+\S/m.test(text)) {
        signals += 1;
    }

    // Horizontal rules: --- or ***
    if (/^[-*_]{3,}\s*$/m.test(text)) {
        signals += 1;
    }

    // Need at least 2 signals to consider it Markdown
    return signals >= 2;
}

/**
 * Get a human-readable label for a detected format
 * @param {DetectedFormat} format
 * @returns {string}
 */
export function getFormatLabel(format) {
    switch (format) {
        case 'html': return 'HTML';
        case 'markdown': return 'Markdown';
        case 'plaintext': return 'Plain Text';
        default: return 'Text';
    }
}
