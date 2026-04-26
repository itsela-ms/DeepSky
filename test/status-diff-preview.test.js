import { describe, it, expect } from 'vitest';

const { classifyDiffLine, renderDiffPreviewHtml } = require('../src/status-diff-preview');

describe('status-diff-preview', () => {
  it('classifies diff lines for styling', () => {
    expect(classifyDiffLine('diff --git a/a.js b/a.js')).toBe('meta');
    expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk');
    expect(classifyDiffLine('+added line')).toBe('added');
    expect(classifyDiffLine('-removed line')).toBe('removed');
    expect(classifyDiffLine(' unchanged')).toBe('context');
  });

  it('renders styled html for diff previews', () => {
    const html = renderDiffPreviewHtml([
      'diff --git a/a.js b/a.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ' unchanged',
    ].join('\n'));

    expect(html).toContain('status-diff-meta');
    expect(html).toContain('status-diff-hunk');
    expect(html).toContain('status-diff-removed');
    expect(html).toContain('status-diff-added');
    expect(html).toContain('status-diff-context');
    expect(html).toContain('diff --git a/a.js b/a.js');
  });
});
