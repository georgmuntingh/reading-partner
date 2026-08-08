/**
 * Viewport chrome measurement
 *
 * `.reader-content` sizes itself as `100dvh - var(--header-height) - var(--controls-height)`.
 * Those two custom properties used to be hardcoded (56px / 120px), but the real
 * header and footer are content-sized and change with the responsive breakpoints,
 * with `@media (pointer: coarse)` tap-target rules, and with
 * `env(safe-area-inset-bottom)` on notched phones. When the reservation is too
 * small the fixed footer overlaps the bottom of the reading area and clips
 * whatever line is there.
 *
 * This module measures the real elements and writes the measurements back into
 * the custom properties, so the reading area always matches the visible area.
 */

/**
 * Keep `--header-height` / `--controls-height` in sync with the real elements.
 *
 * @param {Object} options
 * @param {HTMLElement|null} options.header - Element backing `--header-height`
 * @param {HTMLElement|null} options.controls - Element backing `--controls-height`
 * @param {() => void} [options.onChange] - Called after the properties change
 * @returns {() => void} Teardown function
 */
export function observeViewportChrome({ header, controls, onChange }) {
    const root = document.documentElement;
    let lastHeader = -1;
    let lastControls = -1;

    const measure = () => {
        // offsetHeight includes padding, so the safe-area inset added to
        // .reader-controls is accounted for automatically.
        const headerHeight = header ? header.offsetHeight : 0;
        const controlsHeight = controls ? controls.offsetHeight : 0;

        // A hidden reader (display: none) measures 0; keep the last good value
        // rather than collapsing the reservation to nothing.
        if (headerHeight <= 0 && controlsHeight <= 0) return;

        let changed = false;

        if (headerHeight > 0 && headerHeight !== lastHeader) {
            lastHeader = headerHeight;
            root.style.setProperty('--header-height', `${headerHeight}px`);
            changed = true;
        }

        if (controlsHeight > 0 && controlsHeight !== lastControls) {
            lastControls = controlsHeight;
            root.style.setProperty('--controls-height', `${controlsHeight}px`);
            changed = true;
        }

        if (changed) onChange?.();
    };

    measure();

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(measure);
        if (header) resizeObserver.observe(header);
        if (controls) resizeObserver.observe(controls);
    }

    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.visualViewport?.addEventListener('resize', measure);

    return () => {
        resizeObserver?.disconnect();
        window.removeEventListener('resize', measure);
        window.removeEventListener('orientationchange', measure);
        window.visualViewport?.removeEventListener('resize', measure);
    };
}
