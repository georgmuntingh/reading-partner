/**
 * Sentence Splitter Utility
 * Splits text into sentences using Intl.Segmenter (if available) or regex fallback
 */

/**
 * Split text into sentences
 * @param {string} text - Text to split
 * @param {string} [lang='en'] - Language code
 * @returns {string[]} Array of sentences
 */
export function splitIntoSentences(text, lang = 'en') {
    if (!text || typeof text !== 'string') {
        return [];
    }

    // Fix common issues BEFORE normalization
    // 1. Fix missing spaces after punctuation (e.g., "word.Another" -> "word. Another")
    text = text.replace(/([.!?:;])([A-Z])/g, '$1 $2');

    // 2. Fix missing spaces after colons followed by lowercase (e.g., "word:another" -> "word: another")
    text = text.replace(/([a-z]):([a-z])/gi, '$1: $2');

    // Normalize whitespace
    text = text.replace(/\s+/g, ' ').trim();

    if (!text) {
        return [];
    }

    // Use Intl.Segmenter if available (Chrome 87+, Safari 14.1+)
    if ('Segmenter' in Intl) {
        try {
            // Protect abbreviation periods so the segmenter doesn't split on them
            const { processed, restore } = protectAbbreviations(text);

            const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
            const segments = [...segmenter.segment(processed)];
            return segments
                .map(s => restore(s.segment).trim())
                .filter(s => s.length > 0);
        } catch (e) {
            console.warn('Intl.Segmenter failed, using fallback:', e);
        }
    }

    // Fallback: regex-based sentence splitting
    return splitSentencesFallback(text);
}

/**
 * Abbreviations whose trailing period should not trigger a sentence break.
 */
const PROTECTED_ABBREVIATIONS = [
    'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr',
    'vs', 'etc', 'approx', 'dept', 'est', 'govt',
    'Inc', 'Ltd', 'Corp', 'Co',
    'St', 'Ave', 'Blvd', 'Rd', 'Mt', 'Ft',
    'Gen', 'Gov', 'Sgt', 'Cpl', 'Pvt', 'Capt', 'Lt', 'Col', 'Maj',
    'Rev', 'Hon', 'Pres', 'Dept', 'Assn', 'Bros', 'No', 'Vol',
    'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec'
];

// Unicode private-use character as placeholder for protected periods
const PERIOD_PLACEHOLDER = '\uE000';

/**
 * Replace abbreviation periods with a placeholder so sentence segmenters
 * don't treat them as sentence boundaries.
 * @param {string} text
 * @returns {{ processed: string, restore: (s: string) => string }}
 */
function protectAbbreviations(text) {
    let processed = text;
    for (const abbr of PROTECTED_ABBREVIATIONS) {
        const regex = new RegExp(`\\b${abbr}\\.`, 'g');
        processed = processed.replace(regex, `${abbr}${PERIOD_PLACEHOLDER}`);
    }
    // Also protect "e.g." and "i.e." (internal periods)
    processed = processed.replace(/\be\.g\./gi, `e${PERIOD_PLACEHOLDER}g${PERIOD_PLACEHOLDER}`);
    processed = processed.replace(/\bi\.e\./gi, `i${PERIOD_PLACEHOLDER}e${PERIOD_PLACEHOLDER}`);

    const restore = (s) => s.replace(new RegExp(PERIOD_PLACEHOLDER, 'g'), '.');
    return { processed, restore };
}

/**
 * Regex-based sentence splitting fallback
 * @param {string} text
 * @returns {string[]}
 */
function splitSentencesFallback(text) {
    // Handle common abbreviations to avoid false splits
    const abbreviations = [
        'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr',
        'vs', 'etc', 'e.g', 'i.e', 'Inc', 'Ltd', 'Corp',
        'St', 'Ave', 'Blvd', 'Rd', 'Mt', 'Ft',
        'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
        // Single-letter abbreviations (A-Z)
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
        'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
    ];

    // Temporarily replace abbreviation periods
    let processed = text;
    const placeholders = [];

    abbreviations.forEach((abbr, i) => {
        const regex = new RegExp(`\\b${abbr}\\.`, 'g');
        const placeholder = `__ABBR${i}__`;
        processed = processed.replace(regex, `${abbr}${placeholder}`);
        placeholders.push({ placeholder, replacement: '.' });
    });

    // Split on sentence-ending punctuation followed by space and capital letter
    // or followed by end of string
    const sentenceEndPattern = /([.!?]+)(?:\s+|$)/g;

    const sentences = [];
    let lastIndex = 0;
    let match;

    while ((match = sentenceEndPattern.exec(processed)) !== null) {
        const sentence = processed.slice(lastIndex, match.index + match[1].length);
        if (sentence.trim()) {
            sentences.push(sentence.trim());
        }
        lastIndex = match.index + match[0].length;
    }

    // Add remaining text if any
    const remaining = processed.slice(lastIndex).trim();
    if (remaining) {
        sentences.push(remaining);
    }

    // Restore abbreviation periods
    return sentences.map(s => {
        let result = s;
        placeholders.forEach(({ placeholder, replacement }) => {
            result = result.replace(new RegExp(placeholder, 'g'), replacement);
        });
        return result;
    });
}

/**
 * Split text into paragraphs, then sentences
 * @param {string} text - Text to split
 * @returns {{ paragraphs: { sentences: string[] }[] }}
 */
export function splitIntoParagraphsAndSentences(text) {
    if (!text || typeof text !== 'string') {
        return { paragraphs: [] };
    }

    // Split by double newlines or multiple line breaks for paragraphs
    const paragraphTexts = text
        .split(/\n\s*\n|\r\n\s*\r\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

    const paragraphs = paragraphTexts.map(pText => ({
        sentences: splitIntoSentences(pText)
    }));

    return { paragraphs };
}

/**
 * Split a long sentence into smaller chunks at natural break points
 * Used for TTS when a sentence exceeds the model's maximum length
 * @param {string} text - Sentence to split
 * @param {number} maxLength - Maximum length per chunk (default: 500 characters)
 * @returns {string[]} Array of text chunks
 */
export function splitLongSentence(text, maxLength = 500) {
    if (!text || text.length <= maxLength) {
        return [text];
    }

    const chunks = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        // Try to split at natural break points: comma, semicolon, dash, or space
        let splitPoint = -1;

        // Look for break points in the preferred range (around maxLength)
        const searchEnd = Math.min(maxLength, remaining.length);
        const searchStart = Math.floor(searchEnd * 0.7); // Start searching from 70% of maxLength

        // Priority: semicolon, comma, dash, then space
        const breakPoints = [
            { char: ';', offset: 1 },
            { char: ',', offset: 1 },
            { char: ' - ', offset: 3 },
            { char: ' — ', offset: 3 },
            { char: ' ', offset: 1 }
        ];

        for (const { char, offset } of breakPoints) {
            splitPoint = remaining.lastIndexOf(char, searchEnd);
            if (splitPoint >= searchStart) {
                splitPoint += offset;
                break;
            }
        }

        // If no break point found, force split at maxLength
        if (splitPoint < searchStart) {
            splitPoint = maxLength;
        }

        // Extract chunk and update remaining
        chunks.push(remaining.substring(0, splitPoint).trim());
        remaining = remaining.substring(splitPoint).trim();
    }

    // Add the last chunk
    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}
