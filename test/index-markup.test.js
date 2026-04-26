import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const INDEX_PATH = join(__dirname, '..', 'src', 'index.html');

let html;

beforeAll(() => {
  html = readFileSync(INDEX_PATH, 'utf8');
});

describe('index.html accessibility regressions', () => {
  it('marks the settings modal as a dialog', () => {
    expect(html).toMatch(/id="settings-overlay"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/class="settings-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
    expect(html).toMatch(/id="settings-title"/);
  });

  it('provides live regions for toasts and notification announcements', () => {
    expect(html).toMatch(/id="toast-container"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="notification-live-region"[^>]*aria-live="polite"/);
  });

  it('does not promise Ctrl+F on the sidebar search button', () => {
    expect(html).toContain('title="Search sessions"');
    expect(html).not.toContain('Search sessions (Ctrl+F)');
  });
});
