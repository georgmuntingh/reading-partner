/**
 * Settings Modal — Spaced Review (SRS) section tests
 *
 * Narrow tests for the Phase 4 SRS settings UI: defaults, save
 * serialization, load round-trip, and the padding-row hide/show
 * toggle that tracks the padding-mode select.
 *
 * We don't exercise the modal's other sections; those long predate
 * the SRS work.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SettingsModal } from '../js/ui/settings-modal.js';

const mount = (overrides = {}) => {
    document.body.innerHTML = '<div id="settings-modal"></div>';
    const container = document.getElementById('settings-modal');
    const callbacks = {
        onClose: vi.fn(),
        onSave: vi.fn(),
        onBackendChange: vi.fn(),
        getBook: () => null,
        onDomainChange: vi.fn(),
        onClearKG: vi.fn(),
        ...overrides
    };
    const modal = new SettingsModal({ container }, callbacks);
    return { modal, callbacks, container };
};

beforeEach(() => { document.body.innerHTML = ''; });

// ---------- Defaults ----------

describe('SettingsModal — SRS defaults', () => {
    it('seeds the SRS section with documented defaults', () => {
        const { modal } = mount();
        const s = modal.getSettings();
        expect(s.srsEnabled).toBe(true);
        expect(s.srsPaddingMode).toBe('padding');
        expect(s.srsPaddingSentences).toBe(3);
        expect(s.srsDistractorCount).toBe(3);
        expect(s.srsLLMTemperature).toBe(0.4);
        expect(s.srsTriggerOnChapterFinish).toBe(true);
        expect(s.srsTriggerLazyOnOpen).toBe(true);
        expect(s.srsFailIntervalMinutes).toBe(10);
        expect(s.srsEaseDefault).toBe(2.5);
        expect(s.srsEaseMin).toBe(1.3);
        expect(s.srsEaseStepFail).toBeCloseTo(0.2, 5);
        expect(s.srsMaxNewPerSession).toBe(10);
        expect(s.srsMaxReviewsPerSession).toBe(30);
    });
});

// ---------- UI elements rendered ----------

describe('SettingsModal — SRS section DOM', () => {
    it('renders every SRS input/control', () => {
        const { container } = mount();
        const ids = [
            'settings-srs-enabled',
            'settings-srs-padding-mode',
            'settings-srs-padding-row',
            'settings-srs-padding-n',
            'settings-srs-distractor-count',
            'settings-srs-temperature',
            'settings-srs-trigger-chapter-finish',
            'settings-srs-trigger-lazy',
            'settings-srs-fail-interval',
            'settings-srs-ease-default',
            'settings-srs-ease-min',
            'settings-srs-ease-step-fail',
            'settings-srs-max-new',
            'settings-srs-max-reviews'
        ];
        for (const id of ids) {
            expect(container.querySelector(`#${id}`),
                `missing element #${id}`).toBeTruthy();
        }
    });

    it('the "Spaced Review" section is collapsible (rendered as <details>)', () => {
        const { container } = mount();
        const sections = Array.from(container.querySelectorAll('details.settings-section'));
        const srsSection = sections.find((s) =>
            s.querySelector('.settings-section-header')?.textContent.includes('Spaced Review')
        );
        expect(srsSection).toBeTruthy();
    });
});

// ---------- Load: setSettings + _loadCurrentSettings ----------

describe('SettingsModal — SRS load (round-trip from settings → DOM)', () => {
    it('populates every SRS input from supplied settings', () => {
        const { modal, container } = mount();
        modal.setSettings({
            srsEnabled: false,
            srsPaddingMode: 'whole-chapter',
            srsPaddingSentences: 7,
            srsDistractorCount: 5,
            srsLLMTemperature: 0.85,
            srsTriggerOnChapterFinish: false,
            srsTriggerLazyOnOpen: false,
            srsFailIntervalMinutes: 45,
            srsEaseDefault: 2.0,
            srsEaseMin: 1.5,
            srsEaseStepFail: 0.35,
            srsMaxNewPerSession: 25,
            srsMaxReviewsPerSession: 75
        });
        modal._loadCurrentSettings();

        expect(container.querySelector('#settings-srs-enabled').checked).toBe(false);
        expect(container.querySelector('#settings-srs-padding-mode').value).toBe('whole-chapter');
        expect(Number(container.querySelector('#settings-srs-padding-n').value)).toBe(7);
        expect(Number(container.querySelector('#settings-srs-distractor-count').value)).toBe(5);
        expect(Number(container.querySelector('#settings-srs-temperature').value)).toBeCloseTo(0.85, 5);
        expect(container.querySelector('#settings-srs-trigger-chapter-finish').checked).toBe(false);
        expect(container.querySelector('#settings-srs-trigger-lazy').checked).toBe(false);
        expect(Number(container.querySelector('#settings-srs-fail-interval').value)).toBe(45);
        expect(Number(container.querySelector('#settings-srs-ease-default').value)).toBeCloseTo(2.0, 5);
        expect(Number(container.querySelector('#settings-srs-ease-min').value)).toBeCloseTo(1.5, 5);
        expect(Number(container.querySelector('#settings-srs-ease-step-fail').value)).toBeCloseTo(0.35, 5);
        expect(Number(container.querySelector('#settings-srs-max-new').value)).toBe(25);
        expect(Number(container.querySelector('#settings-srs-max-reviews').value)).toBe(75);
    });

    it('updates the inline value displays to match the loaded settings', () => {
        const { modal, container } = mount();
        modal.setSettings({ srsPaddingSentences: 5, srsFailIntervalMinutes: 60 });
        modal._loadCurrentSettings();
        expect(container.querySelector('#settings-srs-padding-n-value').textContent).toBe('5');
        expect(container.querySelector('#settings-srs-fail-interval-value').textContent).toBe('60');
    });
});

// ---------- Save: UI → settings payload ----------

describe('SettingsModal — SRS save (DOM → onSave payload)', () => {
    it('serializes every SRS field in the onSave payload', () => {
        const { modal, container, callbacks } = mount();

        // Mutate every SRS UI element.
        container.querySelector('#settings-srs-enabled').checked = false;
        container.querySelector('#settings-srs-padding-mode').value = 'whole-chapter';
        container.querySelector('#settings-srs-padding-n').value = '6';
        container.querySelector('#settings-srs-distractor-count').value = '4';
        container.querySelector('#settings-srs-temperature').value = '0.75';
        container.querySelector('#settings-srs-trigger-chapter-finish').checked = false;
        container.querySelector('#settings-srs-trigger-lazy').checked = false;
        container.querySelector('#settings-srs-fail-interval').value = '20';
        container.querySelector('#settings-srs-ease-default').value = '2.2';
        container.querySelector('#settings-srs-ease-min').value = '1.4';
        container.querySelector('#settings-srs-ease-step-fail').value = '0.3';
        container.querySelector('#settings-srs-max-new').value = '15';
        container.querySelector('#settings-srs-max-reviews').value = '50';

        modal._save();

        expect(callbacks.onSave).toHaveBeenCalledTimes(1);
        const payload = callbacks.onSave.mock.calls[0][0];

        expect(payload.srsEnabled).toBe(false);
        expect(payload.srsPaddingMode).toBe('whole-chapter');
        expect(payload.srsPaddingSentences).toBe(6);
        expect(payload.srsDistractorCount).toBe(4);
        expect(payload.srsLLMTemperature).toBeCloseTo(0.75, 5);
        expect(payload.srsTriggerOnChapterFinish).toBe(false);
        expect(payload.srsTriggerLazyOnOpen).toBe(false);
        expect(payload.srsFailIntervalMinutes).toBe(20);
        expect(payload.srsEaseDefault).toBeCloseTo(2.2, 5);
        expect(payload.srsEaseMin).toBeCloseTo(1.4, 5);
        expect(payload.srsEaseStepFail).toBeCloseTo(0.3, 5);
        expect(payload.srsMaxNewPerSession).toBe(15);
        expect(payload.srsMaxReviewsPerSession).toBe(50);
    });

    it('clamps an out-of-range temperature to [0, 1]', () => {
        const { modal, container, callbacks } = mount();
        // Manually set above the slider's max to exercise the clamp.
        const slider = container.querySelector('#settings-srs-temperature');
        slider.max = '2';
        slider.value = '1.5';
        modal._save();
        const payload = callbacks.onSave.mock.calls[0][0];
        expect(payload.srsLLMTemperature).toBeLessThanOrEqual(1);
        expect(payload.srsLLMTemperature).toBeGreaterThanOrEqual(0);
    });

    it("padding-mode select serializes 'padding' for any non-whole-chapter value", () => {
        const { modal, container, callbacks } = mount();
        container.querySelector('#settings-srs-padding-mode').value = 'something-bogus';
        modal._save();
        expect(callbacks.onSave.mock.calls[0][0].srsPaddingMode).toBe('padding');
    });
});

// ---------- Padding-row hide/show toggle ----------

describe('SettingsModal — padding-row hide/show toggle', () => {
    it('selecting "Whole chapter" hides the padding-N row', () => {
        const { container } = mount();
        const select = container.querySelector('#settings-srs-padding-mode');
        const row = container.querySelector('#settings-srs-padding-row');
        select.value = 'whole-chapter';
        select.dispatchEvent(new Event('change'));
        expect(row.classList.contains('hidden')).toBe(true);
    });

    it('switching back to "Padding window" reveals the row again', () => {
        const { container } = mount();
        const select = container.querySelector('#settings-srs-padding-mode');
        const row = container.querySelector('#settings-srs-padding-row');
        select.value = 'whole-chapter';
        select.dispatchEvent(new Event('change'));
        select.value = 'padding';
        select.dispatchEvent(new Event('change'));
        expect(row.classList.contains('hidden')).toBe(false);
    });

    it('loading settings with srsPaddingMode=whole-chapter hides the row', () => {
        const { modal, container } = mount();
        modal.setSettings({ srsPaddingMode: 'whole-chapter' });
        modal._loadCurrentSettings();
        const row = container.querySelector('#settings-srs-padding-row');
        expect(row.classList.contains('hidden')).toBe(true);
    });
});

// ---------- Live value displays ----------

describe('SettingsModal — SRS slider live value displays', () => {
    it('moving the padding slider updates the inline label', () => {
        const { container } = mount();
        const slider = container.querySelector('#settings-srs-padding-n');
        slider.value = '7';
        slider.dispatchEvent(new Event('input'));
        expect(container.querySelector('#settings-srs-padding-n-value').textContent).toBe('7');
    });

    it('moving the temperature slider formats to 2 decimals', () => {
        const { container } = mount();
        const slider = container.querySelector('#settings-srs-temperature');
        slider.value = '0.65';
        slider.dispatchEvent(new Event('input'));
        expect(container.querySelector('#settings-srs-temperature-value').textContent).toBe('0.65');
    });

    it('moving the ease-default slider formats to 2 decimals', () => {
        const { container } = mount();
        const slider = container.querySelector('#settings-srs-ease-default');
        slider.value = '2.3';
        slider.dispatchEvent(new Event('input'));
        expect(container.querySelector('#settings-srs-ease-default-value').textContent).toBe('2.30');
    });
});
