import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { getFocusableElements, trapFocusWithin, isBackdropClickTarget } = require('../src/modal-utils');

describe('modal-utils', () => {
  it('collects focusable elements in document order', () => {
    const { window } = new JSDOM(`
      <div id="modal">
        <button id="first">First</button>
        <button id="disabled" disabled>Disabled</button>
        <a id="link" href="#x">Link</a>
        <div tabindex="-1">Skip</div>
        <button id="last">Last</button>
      </div>
    `);

    const ids = getFocusableElements(window.document.getElementById('modal')).map((element) => element.id);
    expect(ids).toEqual(['first', 'link', 'last']);
  });

  it('wraps focus from the last element back to the first', () => {
    const { window } = new JSDOM(`
      <div id="modal">
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>
    `, { pretendToBeVisual: true });
    const modal = window.document.getElementById('modal');
    const first = window.document.getElementById('first');
    const last = window.document.getElementById('last');
    const preventDefault = vi.fn();

    last.focus();
    const handled = trapFocusWithin({ key: 'Tab', shiftKey: false, preventDefault }, modal);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.document.activeElement).toBe(first);
  });

  it('wraps focus from the first element back to the last on Shift+Tab', () => {
    const { window } = new JSDOM(`
      <div id="modal">
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>
    `, { pretendToBeVisual: true });
    const modal = window.document.getElementById('modal');
    const first = window.document.getElementById('first');
    const last = window.document.getElementById('last');
    const preventDefault = vi.fn();

    first.focus();
    const handled = trapFocusWithin({ key: 'Tab', shiftKey: true, preventDefault }, modal);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.document.activeElement).toBe(last);
  });

  it('identifies modal backdrop clicks', () => {
    const { window } = new JSDOM('<div class="enhance-modal-backdrop"></div><div class="other"></div>');
    expect(isBackdropClickTarget(window.document.querySelector('.enhance-modal-backdrop'))).toBe(true);
    expect(isBackdropClickTarget(window.document.querySelector('.other'))).toBe(false);
  });
});
