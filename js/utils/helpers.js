/**
 * Helper Utilities
 */

/**
 * Generate a hash for a string (for book IDs)
 * @param {string} str
 * @returns {Promise<string>}
 */
export async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Generate a unique ID
 * @returns {string}
 */
export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Debounce a function
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * Throttle a function
 * @param {Function} fn
 * @param {number} limit
 * @returns {Function}
 */
export function throttle(fn, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    };
}

/**
 * Sanitize HTML content - remove scripts and dangerous attributes
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHTML(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const doc = template.content;

    // Remove script tags
    doc.querySelectorAll('script').forEach(el => el.remove());

    // Remove dangerous attributes
    const dangerousAttrs = ['onclick', 'onload', 'onerror', 'onmouseover', 'onfocus', 'onblur'];
    doc.querySelectorAll('*').forEach(el => {
        dangerousAttrs.forEach(attr => el.removeAttribute(attr));
        // Remove javascript: URLs
        if (el.hasAttribute('href') && el.getAttribute('href').startsWith('javascript:')) {
            el.removeAttribute('href');
        }
        if (el.hasAttribute('src') && el.getAttribute('src').startsWith('javascript:')) {
            el.removeAttribute('src');
        }
    });

    return template.innerHTML;
}

/**
 * Extract plain text from HTML
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    // Replace <br> and block elements with newlines
    template.content.querySelectorAll('br').forEach(el => {
        el.replaceWith('\n');
    });

    template.content.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li').forEach(el => {
        el.prepend(document.createTextNode('\n\n'));
    });

    return template.content.textContent || '';
}

/**
 * Sleep for a given duration
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clamp a number between min and max
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Scroll element into view with offset
 * @param {HTMLElement} element
 * @param {HTMLElement} container
 * @param {number} offset
 */
export function scrollIntoViewWithOffset(element, container, offset = 100) {
    const elementTop = element.offsetTop;
    const containerScrollTop = container.scrollTop;
    const containerHeight = container.clientHeight;

    const elementRelativeTop = elementTop - containerScrollTop;

    // If element is above viewport or below
    if (elementRelativeTop < offset || elementRelativeTop > containerHeight - offset) {
        container.scrollTo({
            top: elementTop - offset,
            behavior: 'smooth'
        });
    }
}
