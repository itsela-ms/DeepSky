import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const { renderStatusSummaryMetaHtml } = require('../src/status-summary');

describe('status-summary', () => {
  it('renders the quick actions structure for session and files folders', () => {
    const html = renderStatusSummaryMetaHtml('376fedd7-eec9-429e-a4b9-5fb252880d42');
    const { document } = new JSDOM(html).window;

    const actionsLabel = document.querySelector('.status-summary-actions-label');
    expect(actionsLabel?.textContent).toBe('Quick actions');

    const actionButtons = [...document.querySelectorAll('.status-summary-action')];
    expect(actionButtons).toHaveLength(2);
    expect(actionButtons.map((button) => button.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      '📁 session',
      '📄 files',
    ]);

    const copyButton = document.querySelector('.status-summary-id-copy');
    expect(copyButton?.textContent?.replace(/\s+/g, ' ').trim()).toBe('📋');
    expect(copyButton?.getAttribute('aria-label')).toBe('Copy session ID');
    expect(copyButton?.classList.contains('status-copy-session-id')).toBe(true);

    expect(document.querySelector('.status-open-session-directory')?.getAttribute('title')).toBe('Open session directory');
    expect(document.querySelector('.status-open-session-files-directory')?.getAttribute('title')).toBe('Open session files directory');
    expect(copyButton?.getAttribute('title')).toBe('Copy session ID');
  });

  it('escapes the session id in both text and attributes', () => {
    const html = renderStatusSummaryMetaHtml('abc"<script>');
    const { document } = new JSDOM(html).window;

    expect(document.querySelector('.status-summary-id')?.textContent).toBe('abc"<script>');
    expect(document.querySelector('.status-summary-id')?.getAttribute('title')).toBe('abc"<script>');
    expect(document.querySelector('.status-open-session-directory')?.getAttribute('data-session-id')).toBe('abc"<script>');
    expect(document.querySelector('script')).toBeNull();
  });
});
