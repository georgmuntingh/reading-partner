/**
 * Parser Factory
 * Dispatches to the appropriate format parser based on file extension or type.
 */

import { EPUBParser } from './epub-parser.js';
import { MarkdownParser } from './markdown-parser.js';
import { HTMLParser } from './html-parser.js';

/** @type {Map<string, import('./format-parser.js').FormatParser>} */
const parserInstances = new Map();

/**
 * Supported file extensions and their format types
 */
const EXTENSION_MAP = {
    '.epub': 'epub',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.html': 'html',
    '.htm': 'html',
};

/**
 * Accepted file extensions for file input elements
 */
export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_MAP).join(',');

/**
 * Human-readable format labels
 */
export const FORMAT_LABELS = {
    epub: 'EPUB',
    markdown: 'Markdown',
    html: 'HTML',
};

/**
 * Detect the file type from a filename
 * @param {string} filename
 * @returns {string|null} format type or null if unsupported
 */
export function detectFileType(filename) {
    const lower = filename.toLowerCase();
    for (const [ext, type] of Object.entries(EXTENSION_MAP)) {
        if (lower.endsWith(ext)) {
            return type;
        }
    }
    return null;
}

/**
 * Get or create a parser for the given format type
 * @param {string} fileType - 'epub', 'markdown', or 'html'
 * @returns {import('./format-parser.js').FormatParser}
 */
export function getParser(fileType) {
    if (parserInstances.has(fileType)) {
        return parserInstances.get(fileType);
    }

    let parser;
    switch (fileType) {
        case 'epub':
            parser = new EPUBParser();
            break;
        case 'markdown':
            parser = new MarkdownParser();
            break;
        case 'html':
            parser = new HTMLParser();
            break;
        default:
            throw new Error(`Unsupported file format: ${fileType}`);
    }

    parserInstances.set(fileType, parser);
    return parser;
}

/**
 * Get the parser for a given file (detects type from filename)
 * @param {string} filename
 * @returns {import('./format-parser.js').FormatParser}
 */
export function getParserForFile(filename) {
    const fileType = detectFileType(filename);
    if (!fileType) {
        const ext = filename.split('.').pop();
        throw new Error(`Unsupported file format: .${ext}. Supported formats: ${Object.keys(FORMAT_LABELS).join(', ')}`);
    }
    return getParser(fileType);
}

/**
 * Destroy all parser instances and free resources
 */
export function destroyAllParsers() {
    for (const parser of parserInstances.values()) {
        parser.destroy();
    }
    parserInstances.clear();
}
