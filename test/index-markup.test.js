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

  it('does not promise transcript content search in the sidebar placeholder', () => {
    expect(html).toContain('placeholder="Search titles, folders, tags & resources..."');
    expect(html).not.toContain('Search sessions, tags & content...');
  });

  it('includes a startup loading screen with live status text', () => {
    expect(html).toContain('id="startup-loading-screen"');
    expect(html).toContain('id="startup-loading-title"');
    expect(html).toContain('id="startup-loading-message"');
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
  });

  it('surfaces recent release notes and a full changelog action in the About tab', () => {
    expect(html).toContain('id="about-release-meta"');
    expect(html).toContain('id="about-open-brochure"');
    expect(html).toContain('id="about-open-changelog"');
    expect(html).toContain('Open brochure');
    expect(html).toContain('Open full changelog');
    expect(html).toContain('Recent release notes');
  });

  it('keeps the enhancement review iframe sandboxed away from the parent window', () => {
    expect(html).toContain('id="review-modal-iframe"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('sandbox="allow-same-origin"');
  });
});
