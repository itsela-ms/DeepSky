import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const StatusService = require('../src/status-service');

let tmpDir;
let svc;
let execFileMock;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-status-'));
  execFileMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
  svc = new StatusService(tmpDir, { execFile: execFileMock });
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function writePlan(sessionId, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'plan.md'), content, 'utf8');
  return sessionDir;
}

async function writeGeneratedFile(sessionId, relativePath, content = '') {
  const filePath = path.join(tmpDir, sessionId, 'files', ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeGeneratedDirectoryLink(sessionId, linkName, targetDir) {
  const linkPath = path.join(tmpDir, sessionId, 'files', linkName);
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.promises.symlink(targetDir, linkPath, type);
  return linkPath;
}

async function writeSessionSummary(sessionId, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'session-summary.md'), content, 'utf8');
  return sessionDir;
}

async function writeWorkspace(sessionId, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'workspace.yaml'), content, 'utf8');
  return sessionDir;
}

describe('StatusService next step summaries', () => {
  it('keeps concise checkbox steps unchanged', async () => {
    await writePlan('short-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ] Engage source tenant admin',
      '- [ ] Roll traffic to AME',
    ].join('\n'));

    const status = await svc.getSessionStatus('short-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Engage source tenant admin',
      'Roll traffic to AME',
    ]);
  });

  it('summarizes verbose checkbox steps to six words or fewer', async () => {
    await writePlan('verbose-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ] Engage the Source Tenant Admin by posting in the support Teams channel with all app details',
      '- [ ] Download the `AppMigration` PowerShell artifacts from the latest successful pipeline build',
    ].join('\n'));

    const status = await svc.getSessionStatus('verbose-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Engage the Source Tenant Admin',
      'Download the AppMigration PowerShell artifacts',
    ]);
    expect(status.nextSteps.every(step => step.text.split(/\s+/).length <= 6)).toBe(true);
  });

  it('summarizes numbered fallback steps to six words or fewer', async () => {
    await writePlan('numbered-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '1. **Acquire the AME token and prepare destination migration** - extra details go here',
      '2. **Soft-delete Corp source app after bake** - more details',
    ].join('\n'));

    const status = await svc.getSessionStatus('numbered-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Acquire the AME token and prepare',
      'Soft-delete Corp source app after bake',
    ]);
    expect(status.nextSteps.every(step => step.text.split(/\s+/).length <= 6)).toBe(true);
  });

  it('skips empty checkbox items after summarization', async () => {
    await writePlan('empty-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ]    ',
      '- [ ] Roll traffic to AME',
    ].join('\n'));

    const status = await svc.getSessionStatus('empty-steps');
    expect(status.nextSteps).toHaveLength(1);
    expect(status.nextSteps[0]).toMatchObject({
      text: 'Roll traffic to AME',
      current: true,
      done: false,
    });
  });

  it('preserves unicode characters in summarized steps', async () => {
    await writePlan('unicode-steps', [
      '# Test Plan',
      '',
      '## Next Steps',
      '- [ ] Mettre à jour résumé partagé',
      '- [ ] Validate café migration readiness',
    ].join('\n'));

    const status = await svc.getSessionStatus('unicode-steps');
    expect(status.nextSteps.map(step => step.text)).toEqual([
      'Mettre à jour résumé partagé',
      'Validate café migration readiness',
    ]);
  });
});

describe('StatusService generated files', () => {
  it('returns only user-targeted reports from the session files folder', async () => {
    await writeGeneratedFile('generated-files', 'reports/validation.html', '<html></html>');
    await writeGeneratedFile('generated-files', 'notes/output.json', '{"ok":true}');
    await writeGeneratedFile('generated-files', 'exports/brief.pdf', 'pdf');

    const status = await svc.getSessionStatus('generated-files');
    expect(status.generatedFiles.map(file => file.path)).toEqual([
      'files/reports/validation.html',
      'files/exports/brief.pdf',
    ]);
  });

  it('prioritizes html files ahead of other generated files', async () => {
    await writeGeneratedFile('generated-priority', 'artifact.json', '{}');
    await writeGeneratedFile('generated-priority', 'preview.html', '<html></html>');

    const status = await svc.getSessionStatus('generated-priority');
    expect(status.generatedFiles[0]).toMatchObject({
      name: 'preview.html',
      ext: 'html',
    });
  });

  it('skips symlinked directories when discovering generated files', async () => {
    const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-generated-link-'));
    await fs.promises.writeFile(path.join(outsideDir, 'outside.html'), '<html>outside</html>', 'utf8');
    await writeGeneratedFile('generated-safe', 'reports/inside.html', '<html>inside</html>');
    await writeGeneratedDirectoryLink('generated-safe', 'linked-outside', outsideDir);

    const status = await svc.getSessionStatus('generated-safe');
    expect(status.generatedFiles.map(file => file.path)).toEqual(['files/reports/inside.html']);

    await fs.promises.rm(outsideDir, { recursive: true, force: true });
  });
});

describe('StatusService git file tracking', () => {
  it('returns file changes from git status instead of session background files', async () => {
    await writeWorkspace('git-files', 'cwd: C:\\repo\nsummary: repo session');
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/app.js\nA  reports/output.html\nR  old.txt -> new.txt\n D stale.txt\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/reports/output.html b/reports/output.html\nnew file mode 100644\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/old.txt b/new.txt\nsimilarity index 98%\nrename from old.txt\nrename to new.txt\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/stale.txt b/stale.txt\ndeleted file mode 100644\n', stderr: '' });

    const status = await svc.getSessionStatus('git-files');
    expect(status.files).toEqual([
      { path: 'src/app.js', action: 'M', diff: 'diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new' },
      { path: 'reports/output.html', action: 'A', diff: 'diff --git a/reports/output.html b/reports/output.html\nnew file mode 100644' },
      { path: 'new.txt', action: 'R', diff: 'diff --git a/old.txt b/new.txt\nsimilarity index 98%\nrename from old.txt\nrename to new.txt' },
      { path: 'stale.txt', action: 'D', diff: 'diff --git a/stale.txt b/stale.txt\ndeleted file mode 100644' },
    ]);
  });

  it('returns no file changes when session cwd is not a git repo', async () => {
    await writeWorkspace('non-git-files', 'cwd: C:\\repo\nsummary: repo session');
    execFileMock.mockRejectedValueOnce(new Error('not a git repo'));

    const status = await svc.getSessionStatus('non-git-files');
    expect(status.files).toEqual([]);
  });

  it('refreshes cached status after explicit invalidation', async () => {
    await writeWorkspace('cache-reset', 'cwd: C:\\repo-a\nsummary: repo session');
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo-a\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/old.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/old.js b/src/old.js\n', stderr: '' });

    const first = await svc.getSessionStatus('cache-reset');
    expect(first.files).toEqual([{ path: 'src/old.js', action: 'M', diff: 'diff --git a/src/old.js b/src/old.js' }]);

    await writeWorkspace('cache-reset', 'cwd: C:\\repo-b\nsummary: repo session');
    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo-b\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/new.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/new.js b/src/new.js\n', stderr: '' });

    svc.invalidateSession('cache-reset');
    const second = await svc.getSessionStatus('cache-reset');
    expect(second.files).toEqual([{ path: 'src/new.js', action: 'M', diff: 'diff --git a/src/new.js b/src/new.js' }]);
  });

  it('prefers the newer workspace cwd over an older DeepSky override when collecting git status', async () => {
    const sessionDir = await writeWorkspace('cwd-priority', 'cwd: C:\\repo-old\nsummary: repo session');
    await fs.promises.writeFile(path.join(sessionDir, '.deepsky-cwd'), 'C:\\repo-override', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 15));
    await writeWorkspace('cwd-priority', 'cwd: C:\\repo-new\nsummary: repo session');

    execFileMock
      .mockResolvedValueOnce({ stdout: 'C:\\repo-new\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/current.js\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/src/current.js b/src/current.js\n', stderr: '' });

    const status = await svc.getSessionStatus('cwd-priority');
    expect(status.files).toEqual([{ path: 'src/current.js', action: 'M', diff: 'diff --git a/src/current.js b/src/current.js' }]);
    expect(execFileMock).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--show-toplevel'], expect.objectContaining({ cwd: 'C:\\repo-new' }));
  });
});

describe('StatusService summary extraction', () => {
  it('reads only the Summary block from plain session-summary format', async () => {
    await writeSessionSummary('plain-summary', [
      'Summary:',
      'DeepSky now shows generated files in session status. It keeps the summary short and readable.',
      '',
      'Key Context:',
      '- noisy internal details should not show up',
      '',
      'Resume Prompt:',
      'Do more implementation work later.',
    ].join('\n'));

    const status = await svc.getSessionStatus('plain-summary');
    expect(status.summary).toMatchObject({
      text: 'DeepSky now shows generated files in session status. It keeps the summary short and readable.',
      source: 'session-summary',
    });
  });

  it('limits summary text to one or two natural sentences', async () => {
    await writeSessionSummary('long-summary', [
      'Summary:',
      'DeepSky now keeps session summaries concise and readable for the status panel. It avoids showing implementation-heavy details in the default view. A third sentence should be dropped.',
    ].join('\n'));

    const status = await svc.getSessionStatus('long-summary');
    expect(status.summary.text).toBe(
      'DeepSky now keeps session summaries concise and readable for the status panel. It avoids showing implementation-heavy details in the default view.'
    );
  });
});
