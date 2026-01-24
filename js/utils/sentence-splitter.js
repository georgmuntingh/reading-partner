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

    // Normalize whitespace
    text = text.replace(/\s+/g, ' ').trim();

    if (!text) {
        return [];
    }

    // Use Intl.Segmenter if available (Chrome 87+, Safari 14.1+)
    if ('Segmenter' in Intl) {
        try {
            const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
            const segments = [...segmenter.segment(text)];
            return segments
                .map(s => s.segment.trim())
                .filter(s => s.length > 0);
        } catch (e) {
            console.warn('Intl.Segmenter failed, using fallback:', e);
        }
    }

    // Fallback: regex-based sentence splitting
    return splitSentencesFallback(text);
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
        'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
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
