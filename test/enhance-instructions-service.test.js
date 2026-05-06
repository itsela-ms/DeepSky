import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const service = require('../src/enhance-instructions-service');

// In-memory fake fs for hermetic tests
function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();

  // Auto-register parent dirs of seeded files
  for (const p of files.keys()) {
    let parent = path.dirname(p);
    while (parent && parent !== path.dirname(parent)) {
      dirs.add(parent);
      parent = path.dirname(parent);
    }
  }

  function ensureDir(p) {
    let cur = p;
    while (cur && cur !== path.dirname(cur)) {
      dirs.add(cur);
      cur = path.dirname(cur);
    }
  }

  return {
    files,
    dirs,
    async mkdir(dir, _opts) { ensureDir(dir); },
    async readFile(p, _enc) {
      if (!files.has(p)) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      return files.get(p);
    },
    async writeFile(p, content, _enc) {
      if (!dirs.has(path.dirname(p))) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      files.set(p, content);
    },
    async readdir(p, _opts) {
      if (!dirs.has(p)) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      const names = new Set();
      const entries = [];
      for (const f of files.keys()) {
        if (path.dirname(f) === p) {
          const name = path.basename(f);
          if (!names.has(name)) {
            names.add(name);
            entries.push({ name, isFile: () => true, isDirectory: () => false });
          }
        }
      }
      for (const d of dirs) {
        if (path.dirname(d) === p) {
          const name = path.basename(d);
          if (!names.has(name)) {
            names.add(name);
            entries.push({ name, isFile: () => false, isDirectory: () => true });
          }
        }
      }
      return entries;
    },
    async access(p) {
      if (!files.has(p) && !dirs.has(p)) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
    },
    async unlink(p) {
      if (!files.has(p)) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      files.delete(p);
    },
    async rm(p, opts = {}) {
      if (!files.has(p) && !dirs.has(p)) {
        if (opts.force) return;
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      for (const f of [...files.keys()]) {
        if (f === p || f.startsWith(p + path.sep)) files.delete(f);
      }
      for (const d of [...dirs]) {
        if (d === p || d.startsWith(p + path.sep)) dirs.delete(d);
      }
    },
  };
}

const P = service._paths;
const FIXED_DATE = new Date(Date.UTC(2026, 4, 15, 10, 30, 45, 123));
const EXPECTED_TS = service.formatTimestamp(FIXED_DATE);

describe('enhance-instructions-service', () => {
  describe('formatTimestamp', () => {
    it('produces YYYY-MM-DD_HHmmssSSS with millisecond precision', () => {
      const ts = service.formatTimestamp(new Date(2026, 0, 5, 9, 8, 7, 42));
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}_\d{9}$/);
      expect(ts).toBe('2026-01-05_090807042');
    });

    it('produces unique timestamps for sub-second calls', () => {
      const a = service.formatTimestamp(new Date(2026, 0, 5, 9, 8, 7, 100));
      const b = service.formatTimestamp(new Date(2026, 0, 5, 9, 8, 7, 200));
      expect(a).not.toBe(b);
    });
  });

  describe('isValidTimestamp', () => {
    it('accepts valid format', () => {
      expect(service.isValidTimestamp('2026-05-15_103045123')).toBe(true);
    });
    it('rejects garbage', () => {
      expect(service.isValidTimestamp('../../../etc/passwd')).toBe(false);
      expect(service.isValidTimestamp('')).toBe(false);
      expect(service.isValidTimestamp(null)).toBe(false);
      expect(service.isValidTimestamp('2026-05-15_103045')).toBe(false); // old 6-digit format
    });
  });

  describe('createBackup', () => {
    it('snapshots instructions and playbooks with manifest', async () => {
      const fakeFs = makeFakeFs({
        [P.INSTRUCTIONS_FILE]: '# original instructions',
        [path.join(P.PLAYBOOKS_DIR, 'a.md')]: '# playbook a',
        [path.join(P.PLAYBOOKS_DIR, 'b.md')]: '# playbook b',
        [path.join(P.PLAYBOOKS_DIR, 'notes.txt')]: 'should be ignored',
      });

      const result = await service.createBackup({ fs: fakeFs, now: FIXED_DATE });

      expect(result.timestamp).toBe(EXPECTED_TS);
      expect(result.fileCount).toBe(3);

      const backupRoot = path.join(P.BACKUPS_ROOT, EXPECTED_TS);
      expect(fakeFs.files.get(path.join(backupRoot, 'copilot-instructions.md'))).toBe('# original instructions');
      expect(fakeFs.files.get(path.join(backupRoot, 'playbooks', 'a.md'))).toBe('# playbook a');
      expect(fakeFs.files.get(path.join(backupRoot, 'playbooks', 'b.md'))).toBe('# playbook b');
      expect(fakeFs.files.get(path.join(backupRoot, 'playbooks', 'notes.txt'))).toBeUndefined();

      const manifest = JSON.parse(fakeFs.files.get(path.join(backupRoot, 'manifest.json')));
      expect(manifest.timestamp).toBe(EXPECTED_TS);
      expect(manifest.files).toHaveLength(3);
    });

    it('still produces backup folder when nothing exists yet', async () => {
      const fakeFs = makeFakeFs();
      const result = await service.createBackup({ fs: fakeFs, now: FIXED_DATE });
      expect(result.fileCount).toBe(0);
      const manifest = JSON.parse(fakeFs.files.get(path.join(P.BACKUPS_ROOT, EXPECTED_TS, 'manifest.json')));
      expect(manifest.files).toEqual([]);
    });

    it('recreates the proposal folder when reusing a matching backup', async () => {
      const ts = '2026-05-14_010203004';
      const backupRoot = path.join(P.BACKUPS_ROOT, ts);
      const proposalRoot = path.join(P.PROPOSALS_ROOT, ts);
      const fakeFs = makeFakeFs({
        [P.INSTRUCTIONS_FILE]: '# original instructions',
        [path.join(backupRoot, 'copilot-instructions.md')]: '# original instructions',
        [path.join(backupRoot, 'manifest.json')]: JSON.stringify({
          timestamp: ts,
          createdAt: '2026-05-14T01:02:03.004Z',
          files: [{ name: 'copilot-instructions.md' }],
        }),
      });

      fakeFs.dirs.delete(proposalRoot);

      const result = await service.createBackup({ fs: fakeFs, now: FIXED_DATE });

      expect(result.timestamp).toBe(ts);
      expect(result.reused).toBe(true);
      expect(fakeFs.dirs.has(proposalRoot)).toBe(true);
    });

    it('clears stale proposal files when reusing a matching backup', async () => {
      const ts = '2026-05-14_010203004';
      const backupRoot = path.join(P.BACKUPS_ROOT, ts);
      const proposalRoot = path.join(P.PROPOSALS_ROOT, ts);
      const staleChanges = path.join(proposalRoot, 'changes.html');
      const fakeFs = makeFakeFs({
        [P.INSTRUCTIONS_FILE]: '# original instructions',
        [path.join(backupRoot, 'copilot-instructions.md')]: '# original instructions',
        [path.join(backupRoot, 'manifest.json')]: JSON.stringify({
          timestamp: ts,
          createdAt: '2026-05-14T01:02:03.004Z',
          files: [{ name: 'copilot-instructions.md' }],
        }),
        [staleChanges]: '<html>stale</html>',
      });

      const result = await service.createBackup({ fs: fakeFs, now: FIXED_DATE });

      expect(result.timestamp).toBe(ts);
      expect(result.reused).toBe(true);
      expect(fakeFs.dirs.has(proposalRoot)).toBe(true);
      expect(fakeFs.files.has(staleChanges)).toBe(false);
    });
  });

  describe('listBackups', () => {
    it('returns newest-first with hasChangesHtml flag', async () => {
      const fakeFs = makeFakeFs();
      const t1 = '2026-05-15_103045000';
      const t2 = '2026-05-16_080000000';
      const m1 = JSON.stringify({ timestamp: t1, createdAt: 'a', files: [{ name: 'x' }] });
      const m2 = JSON.stringify({ timestamp: t2, createdAt: 'b', files: [{ name: 'y' }, { name: 'z' }] });
      await fakeFs.mkdir(path.join(P.BACKUPS_ROOT, t1), { recursive: true });
      await fakeFs.writeFile(path.join(P.BACKUPS_ROOT, t1, 'manifest.json'), m1);
      await fakeFs.mkdir(path.join(P.PROPOSALS_ROOT, t1), { recursive: true });
      // changes.html now lives in the proposals folder, not the backup
      await fakeFs.writeFile(path.join(P.PROPOSALS_ROOT, t1, 'changes.html'), '<html/>');
      await fakeFs.mkdir(path.join(P.BACKUPS_ROOT, t2), { recursive: true });
      await fakeFs.writeFile(path.join(P.BACKUPS_ROOT, t2, 'manifest.json'), m2);

      const list = await service.listBackups({ fs: fakeFs });
      expect(list).toHaveLength(2);
      expect(list[0].timestamp).toBe(t2);
      expect(list[0].hasChangesHtml).toBe(false);
      expect(list[0].fileCount).toBe(2);
      expect(list[1].timestamp).toBe(t1);
      expect(list[1].hasChangesHtml).toBe(true);
    });

    it('returns empty when backups dir does not exist', async () => {
      const fakeFs = makeFakeFs();
      expect(await service.listBackups({ fs: fakeFs })).toEqual([]);
    });

    it('ignores backup folders without valid timestamp names', async () => {
      const fakeFs = makeFakeFs();
      const valid = '2026-05-16_080000000';
      const invalid = '..';
      await fakeFs.mkdir(path.join(P.BACKUPS_ROOT, valid), { recursive: true });
      await fakeFs.writeFile(path.join(P.BACKUPS_ROOT, valid, 'manifest.json'), JSON.stringify({
        timestamp: valid,
        createdAt: 'valid',
        files: [],
      }));
      await fakeFs.mkdir(path.join(P.BACKUPS_ROOT, invalid), { recursive: true });
      await fakeFs.writeFile(path.join(P.BACKUPS_ROOT, invalid, 'manifest.json'), JSON.stringify({
        timestamp: invalid,
        createdAt: 'invalid',
        files: [],
      }));

      const list = await service.listBackups({ fs: fakeFs });

      expect(list).toHaveLength(1);
      expect(list[0].timestamp).toBe(valid);
    });
  });

  describe('rollback', () => {
    it('restores files and removes playbooks not in backup', async () => {
      const ts = '2026-05-15_103045000';
      const backupRoot = path.join(P.BACKUPS_ROOT, ts);
      const fakeFs = makeFakeFs({
        [P.INSTRUCTIONS_FILE]: '# new (modified)',
        [path.join(P.PLAYBOOKS_DIR, 'a.md')]: '# new a',
        [path.join(P.PLAYBOOKS_DIR, 'extra.md')]: '# added later, should be removed',
        [path.join(backupRoot, 'manifest.json')]: JSON.stringify({
          timestamp: ts,
          files: [
            { name: 'copilot-instructions.md' },
            { name: 'playbooks/a.md' },
          ],
        }),
        [path.join(backupRoot, 'copilot-instructions.md')]: '# original',
        [path.join(backupRoot, 'playbooks', 'a.md')]: '# original a',
      });

      const result = await service.rollback(ts, { fs: fakeFs });

      expect(fakeFs.files.get(P.INSTRUCTIONS_FILE)).toBe('# original');
      expect(fakeFs.files.get(path.join(P.PLAYBOOKS_DIR, 'a.md'))).toBe('# original a');
      expect(fakeFs.files.get(path.join(P.PLAYBOOKS_DIR, 'extra.md'))).toBeUndefined();
      expect(result.timestamp).toBe(ts);
      expect(result.restored.some(r => r.includes('extra.md'))).toBe(true);
    });

    it('removes instructions file if it was not in the backup (asymmetric rollback fix)', async () => {
      const ts = '2026-05-15_103045000';
      const backupRoot = path.join(P.BACKUPS_ROOT, ts);
      const fakeFs = makeFakeFs({
        // Current state: instructions file exists
        [P.INSTRUCTIONS_FILE]: '# created after backup, should be removed',
        // Backup: no instructions file in manifest
        [path.join(backupRoot, 'manifest.json')]: JSON.stringify({ timestamp: ts, files: [] }),
      });

      const result = await service.rollback(ts, { fs: fakeFs });

      expect(fakeFs.files.get(P.INSTRUCTIONS_FILE)).toBeUndefined();
      expect(result.restored.some(r => r === 'removed: copilot-instructions.md')).toBe(true);
    });

    it('rejects invalid timestamp', async () => {
      const fakeFs = makeFakeFs();
      await expect(service.rollback('../etc/passwd', { fs: fakeFs })).rejects.toThrow(/Invalid backup timestamp/);
    });
  });

  describe('getBackupHtml', () => {
    it('returns html when present', async () => {
      const ts = '2026-05-15_103045000';
      const fakeFs = makeFakeFs({
        // changes.html lives in the proposals folder, not the backup
        [path.join(P.PROPOSALS_ROOT, ts, 'changes.html')]: '<html>diff</html>',
      });
      expect(await service.getBackupHtml(ts, { fs: fakeFs })).toBe('<html>diff</html>');
    });

    it('returns null when missing', async () => {
      const fakeFs = makeFakeFs();
      expect(await service.getBackupHtml('2026-05-15_103045000', { fs: fakeFs })).toBeNull();
    });

    it('rejects invalid timestamp', async () => {
      const fakeFs = makeFakeFs();
      await expect(service.getBackupHtml('../bad', { fs: fakeFs })).rejects.toThrow(/Invalid backup timestamp/);
    });
  });

  describe('writeEnhancePrompt', () => {
    it('creates the proposal directory before writing the prompt file', async () => {
      const fakeFs = makeFakeFs();
      const backupDir = path.join(P.BACKUPS_ROOT, EXPECTED_TS);
      const proposalDir = path.join(P.PROPOSALS_ROOT, EXPECTED_TS);

      const result = await service.writeEnhancePrompt(backupDir, proposalDir, { fs: fakeFs });

      expect(result.promptFilePath).toBe(path.join(proposalDir, P.PROMPT_FILE));
      expect(fakeFs.dirs.has(proposalDir)).toBe(true);
      expect(fakeFs.dirs.has(path.join(proposalDir, P.PROPOSED_SUBDIR))).toBe(true);
      expect(fakeFs.dirs.has(path.join(proposalDir, P.PROPOSED_SUBDIR, 'playbooks'))).toBe(true);
      expect(fakeFs.files.get(result.promptFilePath)).toContain(proposalDir.replace(/\\/g, '/'));
    });

    it('recreates the proposal directory and retries if it disappears before write', async () => {
      const fakeFs = makeFakeFs();
      const backupDir = path.join(P.BACKUPS_ROOT, EXPECTED_TS);
      const proposalDir = path.join(P.PROPOSALS_ROOT, EXPECTED_TS);
      const promptFilePath = path.join(proposalDir, P.PROMPT_FILE);
      const baseWriteFile = fakeFs.writeFile;
      let firstWrite = true;

      fakeFs.writeFile = async (p, content, enc) => {
        if (p === promptFilePath && firstWrite) {
          firstWrite = false;
          fakeFs.dirs.delete(proposalDir);
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return baseWriteFile.call(fakeFs, p, content, enc);
      };

      const result = await service.writeEnhancePrompt(backupDir, proposalDir, { fs: fakeFs });

      expect(result.promptFilePath).toBe(promptFilePath);
      expect(fakeFs.files.get(promptFilePath)).toContain('propose-then-apply');
      expect(fakeFs.dirs.has(proposalDir)).toBe(true);
      expect(fakeFs.dirs.has(path.join(proposalDir, P.PROPOSED_SUBDIR, 'playbooks'))).toBe(true);
    });
  });

  describe('buildEnhancePrompt', () => {
    it('embeds backup + proposal paths and references frontier models generically', () => {
      const prompt = service.buildEnhancePrompt('/some/backup/dir', '/some/proposal/dir');
      expect(prompt).toContain('/some/backup/dir');
      expect(prompt).toContain('/some/proposal/dir');
      expect(prompt).toContain('frontier');
      expect(prompt).toContain('changes.html');
      expect(prompt).toContain('propose-then-apply');
      expect(prompt).toContain('Catppuccin Mocha');
      expect(prompt).toMatch(/<ins>|diff-add/);
      // Should NOT pin to specific model names
      expect(prompt).not.toMatch(/GPT-?5\.[0-9]/);
      expect(prompt).not.toMatch(/Opus 4\.[0-9]/);
      expect(prompt).not.toMatch(/Claude 3/);
    });
  });
});
