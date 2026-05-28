import { describe, it, expect, vi } from 'vitest';

const {
  getSessionDirectoryAvailability,
  resolveGeneratedFilePath,
  resolveSessionDirectory,
  resolveSessionFilesDirectory,
} = require('../src/session-paths');

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
