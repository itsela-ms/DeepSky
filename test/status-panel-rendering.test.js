import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const source = readFileSync(join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const renderSource = source.slice(source.indexOf('function renderStatusPanel('), source.indexOf('function fitActiveTerminal('));

let body;
let render;
let api;
let document;
const status = {
  intent: null, summary: { text: 'Summary' }, nextSteps: [], files: [], timeline: [],
  generatedFiles: [{ name: 'report.html', path: 'report.html', source: 'artifacts', ext: 'html' }],
};

beforeEach(() => {
  document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  document.body.innerHTML = '<div id="panel"></div><button id="outside">Outside</button>';
  body = document.getElementById('panel');
  api = { openGeneratedFile: vi.fn().mockResolvedValue({ ok: true }) };
  const escapeHtml = value => {
    const span = document.createElement('span');
    span.textContent = value;
    return span.innerHTML.replace(/"/g, '&quot;');
  };
  render = new Function(
    'statusPanelBody', 'window', 'document', 'escapeHtml', 'renderStatusSection', 'renderStatusSummaryMetaHtml', 'hideStatusDiffPopover',
    `${renderSource}
     return renderStatusPanel;`
  )(body, { api }, document, escapeHtml,
    (key, icon, title, badge, content) => `<section class="status-section" data-section="${key}">
      <button class="status-section-header" type="button">${title}</button>${content}</section>`, () => '', () => {});
});

afterEach(() => document.defaultView.close());

describe('status panel report interaction', () => {
  it('uses a native focusable button and forwards the report source on activation', async () => {
    render('session-a', status, {}, {});
    const button = body.querySelector('button.status-generated-file-item');
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    await Promise.resolve();
    expect(api.openGeneratedFile).toHaveBeenCalledWith('session-a', 'report.html', 'artifacts');
  });

  it('restores focus and scroll while updating the same session in the background', () => {
    render('session-a', status, {}, {});
    const button = body.querySelector('.status-generated-file-item');
    button.focus();
    body.scrollTop = 120;
    render('session-a', { ...status, summary: { text: 'Updated' } }, {}, {});
    expect(document.activeElement).toBe(body.querySelector('.status-generated-file-item'));
    expect(body.scrollTop).toBe(120);
    expect(body.textContent).toContain('Updated');
  });

  it('moves focus to a surviving section when the focused report disappears', () => {
    render('session-a', status, {}, {});
    body.querySelector('.status-generated-file-item').focus();
    render('session-a', { ...status, generatedFiles: [] }, {}, {});
    expect(document.activeElement).toBe(body.querySelector('.status-section-header'));
  });

  it('preserves section-header focus while its contents refresh', () => {
    render('session-a', status, {}, {});
    body.querySelector('[data-section="generatedFiles"] .status-section-header').focus();
    render('session-a', status, {}, {});
    expect(document.activeElement).toBe(body.querySelector('[data-section="generatedFiles"] .status-section-header'));
  });

  it('keeps focus on the correct source when duplicate report names are reordered', () => {
    const legacy = { ...status.generatedFiles[0], source: 'session' };
    render('session-a', { ...status, generatedFiles: [legacy, ...status.generatedFiles] }, {}, {});
    body.querySelector('[data-source="artifacts"]').focus();
    render('session-a', { ...status, generatedFiles: [...status.generatedFiles, legacy] }, {}, {});
    expect(document.activeElement).toBe(body.querySelector('[data-source="artifacts"]'));
  });

  it('does not steal focus from outside the panel during refresh', () => {
    render('session-a', status, {}, {});
    const outside = document.getElementById('outside');
    outside.focus();
    render('session-a', status, {}, {});
    expect(document.activeElement).toBe(outside);
  });

  it('never preserves another session panel just because its report is focused', () => {
    render('session-a', status, {}, {});
    body.querySelector('.status-generated-file-item').focus();
    render('session-b', { ...status, summary: { text: 'Session B' } }, {}, {});
    expect(body.dataset.sessionId).toBe('session-b');
    expect(body.textContent).toContain('Session B');
    expect(body.querySelector('.status-generated-file-item').dataset.sessionId).toBe('session-b');
    expect(document.activeElement).toBe(document.body);
  });
});
