import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const {
  getSessionDirectoryAvailability,
  resolveGeneratedFilePath,
  resolveSessionDirectory,
  resolveSessionFilesDirectory,
} = require('../src/session-paths');

describe('separate session artifact paths', () => {
  const base = path.resolve('test-state', 'session-state');
  const sessionId = '376fedd7-eec9-429e-a4b9-5fb252880d42';
  const artifacts = path.resolve(base, '..', 'files', sessionId);
  const deps = () => ({
    source: 'artifacts',
    realpathImpl: vi.fn(async target => target),
    lstatImpl: vi.fn(async target => ({
      isSymbolicLink: () => false,
      isDirectory: () => target === artifacts || target === path.dirname(artifacts),
      isFile: () => target !== artifacts,
    })),
  });

  it('opens artifacts scoped to the selected session', async () => {
    await expect(resolveGeneratedFilePath(base, sessionId, path.join('nested', 'report.html'), deps()))
      .resolves.toBe(path.join(artifacts, 'nested', 'report.html'));
  });

  it('rejects traversal into another session and arbitrary absolute paths', () => {
    expect(() => resolveGeneratedFilePath(base, sessionId, path.join('..', 'another-session', 'report.html'), deps())).toThrow();
    expect(() => resolveGeneratedFilePath(base, sessionId, path.resolve('outside-report.html'), deps())).toThrow();
  });

  it('rejects unknown sources and invalid session ids', () => {
    expect(() => resolveGeneratedFilePath(base, sessionId, 'report.html', { ...deps(), source: 'anywhere' })).toThrow();
    expect(() => resolveGeneratedFilePath(base, '..', 'report.html', deps())).toThrow();
  });

  it('rejects linked files escaping the session artifact folder', async () => {
    const injected = deps();
    injected.realpathImpl.mockImplementation(async target =>
      target.endsWith('report.html') ? path.resolve('outside-report.html') : target);
    await expect(resolveGeneratedFilePath(base, sessionId, 'report.html', injected)).rejects.toThrow();
  });

  it.each(['link', 'file'])('rejects an artifact root that is a %s', async kind => {
    const injected = deps();
    const normalLstat = injected.lstatImpl.getMockImplementation();
    injected.lstatImpl.mockImplementation(async target => target === path.dirname(artifacts)
      ? { isSymbolicLink: () => kind === 'link', isDirectory: () => kind !== 'file' }
      : normalLstat(target));
    await expect(resolveGeneratedFilePath(base, sessionId, 'report.html', injected)).rejects.toThrow();
  });

  it('discovers and resolves both real report folders using the production defaults', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepsky-report-paths-'));
    try {
      const stateRoot = path.join(root, 'session-state');
      const sessionFiles = path.join(stateRoot, sessionId, 'files');
      const artifactFiles = path.join(root, 'files', sessionId);
      await fs.mkdir(sessionFiles, { recursive: true });
      await fs.mkdir(artifactFiles, { recursive: true });
      await fs.writeFile(path.join(sessionFiles, 'report.html'), 'legacy report');
      await fs.writeFile(path.join(artifactFiles, 'report.html'), 'artifact report');
      const StatusService = require('../src/status-service');
      const service = new StatusService(stateRoot, { execFile: async () => ({ stdout: '', stderr: '' }) });
      const status = await service.getSessionStatus(sessionId);
      expect(status.generatedFiles).toHaveLength(2);
      const contents = [];
      for (const report of status.generatedFiles) {
        const resolved = await resolveGeneratedFilePath(stateRoot, sessionId, report.path, { source: report.source });
        contents.push(await fs.readFile(resolved, 'utf8'));
      }
      expect(contents.sort()).toEqual(['artifact report', 'legacy report']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a junction at the shared artifact root during discovery and opening', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepsky-artifact-junction-'));
    try {
      const stateRoot = path.join(root, 'session-state');
      const external = path.join(root, 'redirected');
      await fs.mkdir(path.join(stateRoot, sessionId, 'files'), { recursive: true });
      await fs.writeFile(path.join(stateRoot, sessionId, 'files', 'legacy.html'), 'legacy report');
      await fs.mkdir(path.join(external, sessionId), { recursive: true });
      await fs.writeFile(path.join(external, sessionId, 'report.html'), 'redirected report');
      await fs.symlink(external, path.join(root, 'files'), process.platform === 'win32' ? 'junction' : 'dir');
      const StatusService = require('../src/status-service');
      const service = new StatusService(stateRoot, { execFile: async () => ({ stdout: '', stderr: '' }) });
      expect((await service.getSessionStatus(sessionId)).generatedFiles.map(file => file.name)).toEqual(['legacy.html']);
      await expect(resolveGeneratedFilePath(stateRoot, sessionId, 'report.html', { source: 'artifacts' })).rejects.toThrow();
      const legacyPath = await resolveGeneratedFilePath(stateRoot, sessionId, path.join('files', 'legacy.html'));
      expect(await fs.readFile(legacyPath, 'utf8')).toBe('legacy report');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// These tests mock fs but the assertions hardcode Windows backslash paths
// (`C:\\Users\\itsela\\.copilot\\session-state\\...`) which are not valid on
// POSIX — path.join produces nonsense like `/Users/runner/work/C:\Users\...`.
// Skip the whole suite on macOS/Linux CI runners. The functions under test
// are exercised in real terms by session-service.test.js which is portable.
describe.skipIf(process.platform !== 'win32')('session-paths', () => {
  describe('resolveSessionDirectory', () => {
    it('returns the real session directory path for a valid session id', async () => {
      const realpath = vi.fn(async (target) => target);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionDirectory(
        'C:\\Users\\itsela\\.copilot\\session-state',
        '376fedd7-eec9-429e-a4b9-5fb252880d42',
        { realpathImpl: realpath, lstatImpl: lstat },
      )).resolves.toBe('C:\\Users\\itsela\\.copilot\\session-state\\376fedd7-eec9-429e-a4b9-5fb252880d42');
    });

    it('rejects paths that resolve outside the session-state root', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce('C:\\Users\\itsela\\.copilot\\session-state')
        .mockResolvedValueOnce('C:\\outside');
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionDirectory(
        'C:\\Users\\itsela\\.copilot\\session-state',
        '376fedd7-eec9-429e-a4b9-5fb252880d42',
        { realpathImpl: realpath, lstatImpl: lstat },
      )).rejects.toThrow('Invalid session directory.');
    });

    it('rejects paths that are not directories', async () => {
      const realpath = vi.fn(async (target) => target);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => false,
      }));
      await expect(resolveSessionDirectory(
        'C:\\Users\\itsela\\.copilot\\session-state',
        '376fedd7-eec9-429e-a4b9-5fb252880d42',
        { realpathImpl: realpath, lstatImpl: lstat },
      )).rejects.toThrow('Session directory no longer exists.');
    });

    it('rejects symlinked session directories', async () => {
      const realpath = vi.fn(async (target) => target);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => true,
        isDirectory: () => false,
      }));
      await expect(resolveSessionDirectory(
        'C:\\Users\\itsela\\.copilot\\session-state',
        '376fedd7-eec9-429e-a4b9-5fb252880d42',
        { realpathImpl: realpath, lstatImpl: lstat },
      )).rejects.toThrow('Session directory no longer exists.');
    });
  });

  describe('resolveSessionFilesDirectory', () => {
    it('returns the real files directory path for a valid session id', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce('C:\\Users\\itsela\\.copilot\\session-state')
        .mockResolvedValueOnce('C:\\Users\\itsela\\.copilot\\session-state\\376fedd7-eec9-429e-a4b9-5fb252880d42\\files');
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionFilesDirectory(
        'C:\\Users\\itsela\\.copilot\\session-state',
        '376fedd7-eec9-429e-a4b9-5fb252880d42',
        { realpathImpl: realpath, lstatImpl: lstat },
      )).resolves.toBe('C:\\Users\\itsela\\.copilot\\session-state\\376fedd7-eec9-429e-a4b9-5fb252880d42\\files');
    });

    it('rejects files directories that resolve outside the session root', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce('C:\\Users\\itsela\\.copilot\\session-state')
        .mockResolvedValueOnce('C:\\outside\\files');
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionFilesDirectory(
        'C:\\Users\\itsela\\.copilot\\session-state',
        '376fedd7-eec9-429e-a4b9-5fb252880d42',
        { realpathImpl: realpath, lstatImpl: lstat },
      )).rejects.toThrow('Invalid session directory.');
    });
  });

  describe('resolveGeneratedFilePath', () => {
    it('returns the validated real path for generated files inside the files directory', async () => {
      const base = 'C:\\Users\\itsela\\.copilot\\session-state';
      const sessionId = '376fedd7-eec9-429e-a4b9-5fb252880d42';
      const realpath = vi.fn(async (target) => target);
      const lstat = vi
        .fn()
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isDirectory: () => true,
        })
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isFile: () => true,
        });

      await expect(resolveGeneratedFilePath(base, sessionId, 'files\\report.html', {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).resolves.toBe(`${base}\\${sessionId}\\files\\report.html`);
    });

    it('rejects generated files that resolve outside the files directory', async () => {
      const base = 'C:\\Users\\itsela\\.copilot\\session-state';
      const sessionId = '376fedd7-eec9-429e-a4b9-5fb252880d42';
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(`${base}\\${sessionId}\\files`)
        .mockResolvedValueOnce('C:\\outside\\report.html');
      const lstat = vi
        .fn()
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isDirectory: () => true,
        })
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isFile: () => true,
        });

      await expect(resolveGeneratedFilePath(base, sessionId, 'files\\report.html', {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Generated file no longer exists.');
    });

    it('rejects files directories that resolve outside the session root', async () => {
      const base = 'C:\\Users\\itsela\\.copilot\\session-state';
      const sessionId = '376fedd7-eec9-429e-a4b9-5fb252880d42';
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce('C:\\Windows\\System32')
        .mockResolvedValueOnce('C:\\Windows\\System32\\cmd.exe');
      const lstat = vi
        .fn()
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isDirectory: () => true,
        })
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isFile: () => true,
        });

      await expect(resolveGeneratedFilePath(base, sessionId, 'files\\cmd.exe', {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Generated file no longer exists.');
    });

    it('rejects symlinked files directories', async () => {
      const base = 'C:\\Users\\itsela\\.copilot\\session-state';
      const sessionId = '376fedd7-eec9-429e-a4b9-5fb252880d42';
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(`${base}\\${sessionId}\\files`)
        .mockResolvedValueOnce(`${base}\\${sessionId}\\files\\report.html`);
      const lstat = vi
        .fn()
        .mockResolvedValueOnce({
          isSymbolicLink: () => true,
          isDirectory: () => false,
        })
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isFile: () => true,
        });

      await expect(resolveGeneratedFilePath(base, sessionId, 'files\\report.html', {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Generated file no longer exists.');
    });
  });

  describe('getSessionDirectoryAvailability', () => {
    it('returns separate availability flags for session and files directories', async () => {
      const base = 'C:\\Users\\itsela\\.copilot\\session-state';
      const sessionId = '376fedd7-eec9-429e-a4b9-5fb252880d42';
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(`${base}\\${sessionId}`)
        .mockResolvedValueOnce(base)
        .mockRejectedValueOnce(new Error('missing'));
      const lstat = vi
        .fn()
        .mockResolvedValueOnce({
          isSymbolicLink: () => false,
          isDirectory: () => true,
        });

      await expect(getSessionDirectoryAvailability(base, sessionId, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).resolves.toEqual({
        sessionDirectoryAvailable: true,
        filesDirectoryAvailable: false,
      });
    });
  });
});
