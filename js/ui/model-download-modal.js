/**
 * Model Download Modal
 * Shows download progress when a local model needs to be downloaded.
 * Used both from Settings (explicit download) and on-demand prompts.
 */

export class ModelDownloadModal {
    constructor() {
        this._container = null;
        this._onCancel = null;
        this._isVisible = false;
        this._currentFiles = new Map(); // Track individual file progress
        this._createDOM();
    }

    /**
     * Show a download confirmation prompt
     * @param {Object} options
     * @param {string} options.modelName - Human-readable model name
     * @param {string} options.modelSize - Estimated download size
     * @param {string} options.purpose - What the model is for (e.g., 'Speech Recognition', 'AI Assistant')
     * @returns {Promise<boolean>} true if user confirms, false if cancelled
     */
    async promptDownload({ modelName, modelSize, purpose }) {
        return new Promise((resolve) => {
            this._titleEl.textContent = `Download ${purpose} Model`;
            this._messageEl.textContent = `"${modelName}" needs to be downloaded (${modelSize}). The model will be cached in your browser for future use.`;
            this._progressSection.classList.add('hidden');
            this._promptSection.classList.remove('hidden');
            this._doneSection.classList.add('hidden');

            this._confirmBtn.onclick = () => {
                resolve(true);
                this._showProgress();
            };
            this._cancelBtn.onclick = () => {
                resolve(false);
                this.hide();
            };

            this._show();
        });
    }

    /**
     * Show the download progress UI directly (no confirmation prompt)
     * @param {string} title
     */
    showProgress(title = 'Downloading Model') {
        this._titleEl.textContent = title;
        this._showProgress();
        this._show();
    }

    /**
     * Update progress
     * @param {Object} progress
     * @param {string} [progress.status] - Status text
     * @param {string} [progress.file] - Current file being downloaded
     * @param {number} [progress.loaded] - Bytes loaded
     * @param {number} [progress.total] - Total bytes
     * @param {number} [progress.progress] - Percentage (0-100)
     */
    updateProgress(progress) {
        if (progress.status) {
            this._statusEl.textContent = progress.status;
        }

        if (progress.file && progress.total) {
            this._currentFiles.set(progress.file, {
                loaded: progress.loaded || 0,
                total: progress.total
            });

            // Calculate overall progress
            let totalLoaded = 0;
            let totalSize = 0;
            for (const [, file] of this._currentFiles) {
                totalLoaded += file.loaded;
                totalSize += file.total;
            }

            const percent = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
            this._progressBar.style.width = `${percent}%`;
            this._progressText.textContent = `${this._formatBytes(totalLoaded)} / ${this._formatBytes(totalSize)} (${percent}%)`;
        }

        if (progress.progress !== undefined && !progress.file) {
            this._progressBar.style.width = `${Math.round(progress.progress)}%`;
        }
    }

    /**
     * Show download complete state
     * @param {string} [message]
     */
    showComplete(message = 'Model downloaded successfully!') {
        this._progressSection.classList.add('hidden');
        this._promptSection.classList.add('hidden');
        this._doneSection.classList.remove('hidden');
        this._doneMessage.textContent = message;

        // Auto-hide after 2 seconds
        setTimeout(() => this.hide(), 2000);
    }

    /**
     * Show download error
     * @param {string} message
     */
    showError(message) {
        this._statusEl.textContent = `Error: ${message}`;
        this._statusEl.classList.add('error');
        this._progressBar.classList.add('error');
    }

    /**
     * Set cancel callback
     * @param {() => void} callback
     */
    onCancel(callback) {
        this._onCancel = callback;
    }

    /**
     * Hide the modal
     */
    hide() {
        this._isVisible = false;
        this._container.classList.add('hidden');
        this._container.classList.remove('visible');
        this._currentFiles.clear();
        this._statusEl.classList.remove('error');
        this._progressBar.classList.remove('error');
    }

    // ========== Private ==========

    _show() {
        this._isVisible = true;
        this._container.classList.remove('hidden');
        // Force reflow before adding visible class for animation
        this._container.offsetHeight;
        this._container.classList.add('visible');
    }

    _showProgress() {
        this._promptSection.classList.add('hidden');
        this._doneSection.classList.add('hidden');
        this._progressSection.classList.remove('hidden');
        this._progressBar.style.width = '0%';
        this._progressText.textContent = 'Starting download...';
        this._statusEl.textContent = 'Preparing...';
        this._currentFiles.clear();
    }

    _createDOM() {
        this._container = document.createElement('div');
        this._container.className = 'model-download-modal hidden';
        this._container.innerHTML = `
            <div class="model-download-backdrop"></div>
            <div class="model-download-dialog">
                <h3 class="model-download-title"></h3>

                <!-- Prompt section -->
                <div class="model-download-prompt">
                    <p class="model-download-message"></p>
                    <div class="model-download-actions">
                        <button class="model-download-cancel-btn">Cancel</button>
                        <button class="model-download-confirm-btn">Download</button>
                    </div>
                </div>

                <!-- Progress section -->
                <div class="model-download-progress hidden">
                    <div class="model-download-status"></div>
                    <div class="model-download-bar-container">
                        <div class="model-download-bar"></div>
                    </div>
                    <div class="model-download-progress-text"></div>
                </div>

                <!-- Done section -->
                <div class="model-download-done hidden">
                    <div class="model-download-done-message"></div>
                </div>
            </div>
        `;

        // Cache elements
        this._titleEl = this._container.querySelector('.model-download-title');
        this._messageEl = this._container.querySelector('.model-download-message');
        this._promptSection = this._container.querySelector('.model-download-prompt');
        this._progressSection = this._container.querySelector('.model-download-progress');
        this._doneSection = this._container.querySelector('.model-download-done');
        this._doneMessage = this._container.querySelector('.model-download-done-message');
        this._confirmBtn = this._container.querySelector('.model-download-confirm-btn');
        this._cancelBtn = this._container.querySelector('.model-download-cancel-btn');
        this._statusEl = this._container.querySelector('.model-download-status');
        this._progressBar = this._container.querySelector('.model-download-bar');
        this._progressText = this._container.querySelector('.model-download-progress-text');

        // Events
        this._container.querySelector('.model-download-backdrop').addEventListener('click', () => {
            // Don't close during download, only during prompt
            if (!this._progressSection.classList.contains('hidden')) return;
            this._onCancel?.();
            this.hide();
        });

        // Add to document
        document.body.appendChild(this._container);
    }

    _formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}

// Export singleton
export const modelDownloadModal = new ModelDownloadModal();
