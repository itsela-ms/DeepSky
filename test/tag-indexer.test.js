import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TagIndexer = require('../src/tag-indexer');

let tmpDir;
let indexer;

function writeSession(sessionId, events) {
  const dir = path.join(tmpDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines + '\n', 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsky-tags-'));
  indexer = new TagIndexer(tmpDir);
});

afterEach(() => {
  if (indexer) { try { indexer.stop(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('TagIndexer', () => {
  it('returns an empty array for unknown sessions', () => {
    expect(indexer.getTagsForSession('does-not-exist')).toEqual([]);
  });

  it('extracts repo, topic, and tool tags from session events', async () => {
    writeSession('session-1', [
      { type: 'user.message', data: { content: 'help me deploy Cloud.Monitoring with KQL' } },
      { type: 'tool.call', data: { toolName: 'kusto-mcp-query' } },
    ]);
    await indexer.rebuildIfStale();
    const tags = indexer.getTagsForSession('session-1');
    expect(tags).toContain('repo:Cloud.Monitoring');
    expect(tags).toContain('deployment');
    expect(tags).toContain('kusto');
    expect(tags).toContain('tool:kusto');
  });

  it('aggregates tag counts across sessions via getAllTags()', async () => {
    writeSession('a', [
      { type: 'user.message', data: { content: 'pipeline build for Cloud.Monitoring' } },
    ]);
    writeSession('b', [
      { type: 'user.message', data: { content: 'pipeline build alert investigation' } },
    ]);
    await indexer.rebuildIfStale();
    const counts = indexer.getAllTags();
    expect(counts.pipelines).toBeGreaterThanOrEqual(2);
    expect(counts.build).toBeGreaterThanOrEqual(2);
  });

  it('searchByTags finds sessions matching a substring', async () => {
    writeSession('s1', [
      { type: 'user.message', data: { content: 'security incident in MDE' } },
    ]);
    writeSession('s2', [
      { type: 'user.message', data: { content: 'unrelated' } },
    ]);
    await indexer.rebuildIfStale();
    const matches = indexer.searchByTags('security');
    expect(matches.has('s1')).toBe(true);
    expect(matches.has('s2')).toBe(false);
  });

  it('prunes orphaned sessions on rebuild', async () => {
    writeSession('to-keep', [{ type: 'user.message', data: { content: 'deploy MDE' } }]);
    writeSession('to-remove', [{ type: 'user.message', data: { content: 'fix bug in MDE' } }]);
    await indexer.rebuildIfStale();
    expect(indexer.getTagsForSession('to-remove').length).toBeGreaterThan(0);

    fs.rmSync(path.join(tmpDir, 'to-remove'), { recursive: true, force: true });
    await indexer.rebuildIfStale();

    expect(indexer.getTagsForSession('to-remove')).toEqual([]);
    expect(indexer.getTagsForSession('to-keep').length).toBeGreaterThan(0);
  });
});
