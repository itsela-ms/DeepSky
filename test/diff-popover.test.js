import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const StatusService = require('../src/status-service');

let tmpDir;
let svc;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-diff-'));
  svc = new StatusService(tmpDir);
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function writeEvents(sessionId, events) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.promises.writeFile(path.join(sessionDir, 'events.jsonl'), lines, 'utf8');
}

function editEvent(filePath) {
  return {
    type: 'tool.execution_start',
    timestamp: new Date().toISOString(),
    data: { toolName: 'edit', arguments: { path: filePath } },
  };
}

function createEvent(filePath) {
  return {
    type: 'tool.execution_start',
    timestamp: new Date().toISOString(),
    data: { toolName: 'create', arguments: { path: filePath } },
  };
}

describe('StatusService _readFiles with fullPath', () => {
  it('returns fullPath alongside display path for edited files', async () => {
    await writeEvents('fp-edit', [
      editEvent('C:\\src\\Cloud.Api\\src\\Startup.cs'),
    ]);

    const status = await svc.getSessionStatus('fp-edit');
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({
      path: 'src/Startup.cs',
      fullPath: 'C:/src/Cloud.Api/src/Startup.cs',
      action: 'M',
    });
  });

  it('returns fullPath alongside display path for created files', async () => {
    await writeEvents('fp-create', [
      createEvent('/home/user/project/src/newfile.ts'),
    ]);

    const status = await svc.getSessionStatus('fp-create');
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({
      path: 'src/newfile.ts',
      fullPath: '/home/user/project/src/newfile.ts',
      action: 'A',
    });
  });

  it('deduplicates files by display path, keeping last action and fullPath', async () => {
    await writeEvents('fp-dedup', [
      createEvent('C:\\src\\app\\config.json'),
      editEvent('C:\\src\\app\\config.json'),
    ]);

    const status = await svc.getSessionStatus('fp-dedup');
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({
      path: 'app/config.json',
      fullPath: 'C:/src/app/config.json',
      action: 'M',
    });
  });

  it('handles multiple distinct files', async () => {
    await writeEvents('fp-multi', [
      editEvent('C:\\src\\api\\handler.cs'),
      createEvent('C:\\src\\api\\model.cs'),
      editEvent('C:\\src\\tests\\handler.test.cs'),
    ]);

    const status = await svc.getSessionStatus('fp-multi');
    expect(status.files).toHaveLength(3);
    const paths = status.files.map(f => f.path);
    expect(paths).toContain('api/handler.cs');
    expect(paths).toContain('api/model.cs');
    expect(paths).toContain('tests/handler.test.cs');
    expect(status.files.every(f => f.fullPath)).toBe(true);
  });

  it('handles string-encoded arguments', async () => {
    await writeEvents('fp-string-args', [{
      type: 'tool.execution_start',
      timestamp: new Date().toISOString(),
      data: {
        toolName: 'edit',
        arguments: '{"path": "C:/src/file.txt", "old_str": "a"}',
      },
    }]);

    const status = await svc.getSessionStatus('fp-string-args');
    expect(status.files).toHaveLength(1);
    expect(status.files[0].fullPath).toBe('C:/src/file.txt');
    expect(status.files[0].action).toBe('M');
  });

  it('returns empty array when no edit/create events exist', async () => {
    await writeEvents('fp-empty', [{
      type: 'tool.execution_start',
      timestamp: new Date().toISOString(),
      data: { toolName: 'grep', arguments: { pattern: 'foo' } },
    }]);

    const status = await svc.getSessionStatus('fp-empty');
    expect(status.files).toEqual([]);
  });

  it('skips events with missing arguments gracefully', async () => {
    await writeEvents('fp-no-args', [{
      type: 'tool.execution_start',
      timestamp: new Date().toISOString(),
      data: { toolName: 'edit' },
    }]);

    const status = await svc.getSessionStatus('fp-no-args');
    expect(status.files).toEqual([]);
  });
});

// Replicate renderDiffLines pure logic for testing (matches src/renderer.js)
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDiffLines(diff, truncated) {
  const lines = diff.split('\n');
  let html = '';
  for (const line of lines) {
    let cls = 'diff-line-ctx';
    if (line.startsWith('+')) cls = 'diff-line-add';
    else if (line.startsWith('-')) cls = 'diff-line-del';
    else if (line.startsWith('@@')) cls = 'diff-line-hunk';
    else if (line.startsWith('diff ') || line.startsWith('index ')) continue;
    html += `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
  }
  if (truncated) {
    html += '<div class="diff-popover-empty">... diff truncated (200+ lines)</div>';
  }
  return html;
}

describe('renderDiffLines', () => {
  it('classifies added lines with diff-line-add', () => {
    const html = renderDiffLines('+const x = 1;', false);
    expect(html).toContain('diff-line-add');
    expect(html).toContain('+const x = 1;');
  });

  it('classifies removed lines with diff-line-del', () => {
    const html = renderDiffLines('-const y = 2;', false);
    expect(html).toContain('diff-line-del');
  });

  it('classifies hunk headers with diff-line-hunk', () => {
    const html = renderDiffLines('@@ -1,3 +1,4 @@', false);
    expect(html).toContain('diff-line-hunk');
  });

  it('classifies context lines with diff-line-ctx', () => {
    const html = renderDiffLines(' unchanged line', false);
    expect(html).toContain('diff-line-ctx');
  });

  it('skips diff and index header lines', () => {
    const diff = [
      'diff --git a/file.txt b/file.txt',
      'index abc1234..def5678 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
    ].join('\n');

    const html = renderDiffLines(diff, false);
    expect(html).not.toContain('diff --git');
    expect(html).not.toContain('index abc1234');
    expect(html).toContain('diff-line-del');
    expect(html).toContain('diff-line-add');
    expect(html).toContain('diff-line-hunk');
  });

  it('shows truncation notice when truncated flag is true', () => {
    const html = renderDiffLines('+line', true);
    expect(html).toContain('diff truncated');
    expect(html).toContain('200+ lines');
    expect(html).toContain('diff-popover-empty');
  });

  it('does not show truncation notice when truncated is false', () => {
    const html = renderDiffLines('+line', false);
    expect(html).not.toContain('truncated');
  });

  it('escapes HTML in diff content', () => {
    const html = renderDiffLines('+<script>alert("xss")</script>', false);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('handles empty diff string', () => {
    const html = renderDiffLines('', false);
    // Single empty line produces one context div
    expect(html).toContain('diff-line-ctx');
  });

  it('handles multi-line diff with mixed types', () => {
    const diff = [
      '@@ -10,4 +10,5 @@ function test() {',
      '   const a = 1;',
      '-  const b = 2;',
      '+  const b = 3;',
      '+  const c = 4;',
      '   return a + b;',
    ].join('\n');

    const html = renderDiffLines(diff, false);
    const addCount = (html.match(/diff-line-add/g) || []).length;
    const delCount = (html.match(/diff-line-del/g) || []).length;
    const ctxCount = (html.match(/diff-line-ctx/g) || []).length;
    const hunkCount = (html.match(/diff-line-hunk/g) || []).length;

    expect(hunkCount).toBe(1);
    expect(delCount).toBe(1);
    expect(addCount).toBe(2);
    expect(ctxCount).toBe(2);
  });
});

// Replicate the truncation logic from main.js file:getDiff handler
function truncateDiff(diff, maxLines = 200) {
  if (!diff) return { diff: null, error: null };
  const lines = diff.split('\n');
  const truncated = lines.length > maxLines;
  const output = truncated ? lines.slice(0, maxLines).join('\n') + '\n...' : diff;
  return { diff: output, truncated };
}

describe('diff truncation logic', () => {
  it('does not truncate diff under the limit', () => {
    const diff = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
    const result = truncateDiff(diff);
    expect(result.truncated).toBeFalsy();
    expect(result.diff).toBe(diff);
  });

  it('does not truncate diff at exactly the limit', () => {
    const diff = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n');
    const result = truncateDiff(diff);
    expect(result.truncated).toBeFalsy();
    expect(result.diff).toBe(diff);
  });

  it('truncates diff over the limit and sets truncated flag', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `+line ${i}`);
    const diff = lines.join('\n');
    const result = truncateDiff(diff);

    expect(result.truncated).toBe(true);
    const outputLines = result.diff.split('\n');
    // 200 lines + the "..." indicator line
    expect(outputLines).toHaveLength(201);
    expect(outputLines[200]).toBe('...');
    expect(outputLines[0]).toBe('+line 0');
    expect(outputLines[199]).toBe('+line 199');
  });

  it('truncates very large diffs efficiently', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `-removed line ${i}`);
    const diff = lines.join('\n');
    const result = truncateDiff(diff);

    expect(result.truncated).toBe(true);
    expect(result.diff.split('\n')).toHaveLength(201);
  });

  it('returns null diff and no error for empty input', () => {
    expect(truncateDiff(null)).toEqual({ diff: null, error: null });
    expect(truncateDiff('')).toEqual({ diff: null, error: null });
  });

  it('truncated diff renders with truncation notice', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `+line ${i}`);
    const { diff, truncated } = truncateDiff(lines.join('\n'));
    const html = renderDiffLines(diff, truncated);
    expect(html).toContain('diff truncated');
    expect(html).toContain('200+ lines');
  });

  it('non-truncated diff renders without truncation notice', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `+line ${i}`);
    const { diff, truncated } = truncateDiff(lines.join('\n'));
    const html = renderDiffLines(diff, truncated);
    expect(html).not.toContain('truncated');
  });
});
