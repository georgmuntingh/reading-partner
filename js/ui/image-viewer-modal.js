/**
 * Image Viewer Modal UI Component
 * Displays images in full screen with zoom and pan capabilities
 */

export class ImageViewerModal {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element for the modal
     * @param {Object} callbacks
     * @param {() => void} callbacks.onClose - Close modal
     */
    constructor(options, callbacks) {
        this._container = options.container;
        this._callbacks = callbacks;

        this._currentImage = null;
        this._scale = 1;
        this._translateX = 0;
        this._translateY = 0;
        this._isDragging = false;
        this._startX = 0;
        this._startY = 0;
        this._lastTouchDistance = 0;

        this._buildUI();
        this._setupEventListeners();
    }

    /**
     * Build the modal UI
     */
    _buildUI() {
        this._container.innerHTML = `
            <div class="image-viewer-content">
                <button class="image-viewer-close-btn btn-icon" aria-label="Close">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
                <div class="image-viewer-controls">
                    <button class="btn-icon" id="image-zoom-out" aria-label="Zoom out" title="Zoom out">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                            <line x1="8" y1="11" x2="14" y2="11"/>
                        </svg>
                    </button>
                    <button class="btn-icon" id="image-zoom-in" aria-label="Zoom in" title="Zoom in">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                            <line x1="11" y1="8" x2="11" y2="14"/>
                            <line x1="8" y1="11" x2="14" y2="11"/>
                        </svg>
                    </button>
                    <button class="btn-icon" id="image-reset" aria-label="Reset zoom" title="Reset zoom">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="1 4 1 10 7 10"/>
                            <polyline points="23 20 23 14 17 14"/>
                            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                        </svg>
                    </button>
                </div>
                <div class="image-viewer-canvas" id="image-viewer-canvas">
                    <img id="image-viewer-img" alt="Full size image">
                </div>
            </div>
        `;

        // Cache elements
        this._elements = {
            closeBtn: this._container.querySelector('.image-viewer-close-btn'),
            zoomInBtn: this._container.querySelector('#image-zoom-in'),
            zoomOutBtn: this._container.querySelector('#image-zoom-out'),
            resetBtn: this._container.querySelector('#image-reset'),
            canvas: this._container.querySelector('#image-viewer-canvas'),
            img: this._container.querySelector('#image-viewer-img')
        };
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        // Close button
        this._elements.closeBtn.addEventListener('click', () => {
            this.hide();
        });

        // Click outside to close
        this._container.addEventListener('click', (e) => {
            if (e.target === this._container) {
                this.hide();
            }
        });

        // Escape key to close
        this._escapeHandler = (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this.hide();
            }
        };
        document.addEventListener('keydown', this._escapeHandler);

        // Zoom controls
        this._elements.zoomInBtn.addEventListener('click', () => {
            this._zoom(1.2);
        });

        this._elements.zoomOutBtn.addEventListener('click', () => {
            this._zoom(0.8);
        });

        this._elements.resetBtn.addEventListener('click', () => {
            this._resetTransform();
        });

        // Mouse wheel zoom
        this._elements.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this._zoom(delta, e.clientX, e.clientY);
        }, { passive: false });

        // Mouse drag for panning
        this._elements.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // Left click only
                this._startDrag(e.clientX, e.clientY);
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (this._isDragging) {
                this._drag(e.clientX, e.clientY);
            }
        });

        document.addEventListener('mouseup', () => {
            this._endDrag();
        });

        // Touch events for mobile
        this._elements.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                // Single touch - pan
                this._startDrag(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                // Two fingers - pinch zoom
                e.preventDefault();
                const touch1 = e.touches[0];
                const touch2 = e.touches[1];
                this._lastTouchDistance = this._getTouchDistance(touch1, touch2);
            }
        }, { passive: false });

        this._elements.canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1 && this._isDragging) {
                // Single touch - pan
                this._drag(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                // Two fingers - pinch zoom
                e.preventDefault();
                const touch1 = e.touches[0];
                const touch2 = e.touches[1];
                const distance = this._getTouchDistance(touch1, touch2);

                if (this._lastTouchDistance > 0) {
                    const delta = distance / this._lastTouchDistance;
                    const centerX = (touch1.clientX + touch2.clientX) / 2;
                    const centerY = (touch1.clientY + touch2.clientY) / 2;
                    this._zoom(delta, centerX, centerY);
                }

                this._lastTouchDistance = distance;
            }
        }, { passive: false });

        this._elements.canvas.addEventListener('touchend', (e) => {
            if (e.touches.length === 0) {
                this._endDrag();
                this._lastTouchDistance = 0;
            } else if (e.touches.length === 1) {
                // One finger left, reset for panning
                this._lastTouchDistance = 0;
            }
        });
    }

    /**
     * Calculate distance between two touch points
     */
    _getTouchDistance(touch1, touch2) {
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Start dragging
     */
    _startDrag(x, y) {
        this._isDragging = true;
        this._startX = x - this._translateX;
        this._startY = y - this._translateY;
        this._elements.canvas.style.cursor = 'grabbing';
    }

    /**
     * Handle drag movement
     */
    _drag(x, y) {
        if (!this._isDragging) return;

        this._translateX = x - this._startX;
        this._translateY = y - this._startY;
        this._updateTransform();
    }

    /**
     * End dragging
     */
    _endDrag() {
        this._isDragging = false;
        this._elements.canvas.style.cursor = this._scale > 1 ? 'grab' : 'default';
    }

    /**
     * Zoom in/out
     * @param {number} factor - Scale factor (>1 = zoom in, <1 = zoom out)
     * @param {number} [originX] - X coordinate of zoom origin
     * @param {number} [originY] - Y coordinate of zoom origin
     */
    _zoom(factor, originX, originY) {
        const oldScale = this._scale;
        this._scale = Math.min(Math.max(0.5, this._scale * factor), 5);

        if (originX !== undefined && originY !== undefined) {
            // Zoom towards the cursor/touch position
            const rect = this._elements.canvas.getBoundingClientRect();
            const offsetX = originX - rect.left;
            const offsetY = originY - rect.top;

            // Adjust translation to zoom towards the origin point
            this._translateX = offsetX - (offsetX - this._translateX) * (this._scale / oldScale);
            this._translateY = offsetY - (offsetY - this._translateY) * (this._scale / oldScale);
        }

        this._updateTransform();
        this._elements.canvas.style.cursor = this._scale > 1 ? 'grab' : 'default';
    }

    /**
     * Reset transform to initial state
     */
    _resetTransform() {
        this._scale = 1;
        this._translateX = 0;
        this._translateY = 0;
        this._updateTransform();
        this._elements.canvas.style.cursor = 'default';
    }

    /**
     * Update image transform
     */
    _updateTransform() {
        this._elements.img.style.transform =
            `translate(${this._translateX}px, ${this._translateY}px) scale(${this._scale})`;
    }

    /**
     * Show the modal with an image
     * @param {string} src - Image source URL
     * @param {string} [alt] - Image alt text
     */
    show(src, alt = '') {
        this._currentImage = src;
        this._elements.img.src = src;
        this._elements.img.alt = alt;
        this._resetTransform();

        this._container.classList.remove('hidden');
        // Force reflow
        this._container.offsetHeight;
        this._container.classList.add('active');
    }

    /**
     * Hide the modal
     */
    hide() {
        this._container.classList.remove('active');
        // Add hidden after transition completes
        setTimeout(() => {
            if (!this._container.classList.contains('active')) {
                this._container.classList.add('hidden');
                this._elements.img.src = '';
                this._currentImage = null;
            }
        }, 300);

        this._callbacks.onClose?.();
    }

    /**
     * Check if modal is visible
     * @returns {boolean}
     */
    isVisible() {
        return this._container.classList.contains('active');
    }

    /**
     * Cleanup event listeners
     */
    destroy() {
        document.removeEventListener('keydown', this._escapeHandler);
    }
}
