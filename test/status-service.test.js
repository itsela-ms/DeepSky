import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');
const os = require('os');
const StatusService = require('../src/status-service');

let tmpDir;
let svc;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepsky-status-'));
  svc = new StatusService(tmpDir);
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

async function writeSessionFile(sessionId, fileName, content) {
  const sessionDir = path.join(tmpDir, sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, fileName), content, 'utf8');
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

describe('StatusService summary and comment handling', () => {
  it('normalizes summary sections into coherent status text', async () => {
    await writeSessionFile('summary-section', 'session-summary.md', [
      '# DeepSky summary',
      '',
      '## Summary',
      'Investigated the current session status flow.',
      '',
      '- Added a place for user-authored notes',
      '- Tightened summary cleanup for readability',
      '',
      '## Key Context',
      'This part should not be included.',
    ].join('\n'));

    const status = await svc.getSessionStatus('summary-section');
    expect(status.summary).toEqual({
      text: 'Investigated the current session status flow. Added a place for user-authored notes. Tightened summary cleanup for readability',
      source: 'session-summary',
    });
  });

  it('clamps overly long summaries without cutting through words', async () => {
    await writeSessionFile('long-summary', 'session-summary.md', [
      '# DeepSky summary',
      '',
      '## Summary',
      'This is a deliberately long summary sentence that keeps going so the status panel does not end up rendering a wall of text when the summary file gets a bit too enthusiastic about every single implementation detail.',
      'This second sentence continues the story with more explanation about how the renderer and services coordinate updates for comments and status content.',
      'This third sentence exists mostly to force truncation and prove the output stays bounded and readable.',
    ].join('\n'));

    const status = await svc.getSessionStatus('long-summary');
    expect(status.summary.source).toBe('session-summary');
    expect(status.summary.text.length).toBeLessThanOrEqual(320);
    expect(status.summary.text.endsWith('...')).toBe(true);
    expect(status.summary.text).not.toMatch(/\s{2,}/);
  });

  it('returns notes alongside status data', async () => {
    const sessionDir = await writeSessionFile('notes-status', '.deepsky-notes.json',
      JSON.stringify([{ id: 'abc', text: 'Needs follow-up with the UI polish pass.', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }]));

    const status = await svc.getSessionStatus('notes-status');
    expect(status.notes).toHaveLength(1);
    expect(status.notes[0].text).toBe('Needs follow-up with the UI polish pass.');
  });

  it('migrates legacy .deepsky-comment to notes in status', async () => {
    await writeSessionFile('notes-migrate-status', '.deepsky-comment', '  Needs follow-up.  ');

    const status = await svc.getSessionStatus('notes-migrate-status');
    expect(status.notes).toHaveLength(1);
    expect(status.notes[0].text).toBe('Needs follow-up.');
  });

  it('refreshes cached status when tracked files change', async () => {
    await writeSessionFile('status-cache', '.deepsky-notes.json',
      JSON.stringify([{ id: 'a', text: 'First note', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }]));

    const first = await svc.getSessionStatus('status-cache');
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0].text).toBe('First note');

    await new Promise(resolve => setTimeout(resolve, 20));
    await writeSessionFile('status-cache', '.deepsky-notes.json',
      JSON.stringify([
        { id: 'a', text: 'First note', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
        { id: 'b', text: 'Second note', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }
      ]));

    const second = await svc.getSessionStatus('status-cache');
    expect(second.notes).toHaveLength(2);
  });
});
