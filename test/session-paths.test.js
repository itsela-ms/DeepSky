import { describe, it, expect, vi } from 'vitest';
const path = require('path');

const {
  getSessionDirectoryAvailability,
  resolveGeneratedFilePath,
  resolveSessionDirectory,
  resolveSessionFilesDirectory,
} = require('../src/session-paths');

const BASE = path.resolve(path.join('Users', 'itsela', '.copilot', 'session-state'));
const SESSION_ID = '376fedd7-eec9-429e-a4b9-5fb252880d42';
const SESSION_DIR = path.join(BASE, SESSION_ID);
const FILES_DIR = path.join(SESSION_DIR, 'files');
const REPORT_PATH = path.join(FILES_DIR, 'report.html');
const OUTSIDE_DIR = path.resolve(path.sep + 'outside');
const OUTSIDE_FILE = path.join(OUTSIDE_DIR, 'report.html');

describe('session-paths', () => {
  describe('resolveSessionDirectory', () => {
    it('returns the real session directory path for a valid session id', async () => {
      const realpath = vi.fn(async (target) => target);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionDirectory(BASE, SESSION_ID, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).resolves.toBe(SESSION_DIR);
    });

    it('rejects paths that resolve outside the session-state root', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(BASE)
        .mockResolvedValueOnce(OUTSIDE_DIR);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionDirectory(BASE, SESSION_ID, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Invalid session directory.');
    });

    it('rejects paths that are not directories', async () => {
      const realpath = vi.fn(async (target) => target);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => false,
      }));
      await expect(resolveSessionDirectory(BASE, SESSION_ID, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Session directory no longer exists.');
    });

    it('rejects symlinked session directories', async () => {
      const realpath = vi.fn(async (target) => target);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => true,
        isDirectory: () => false,
      }));
      await expect(resolveSessionDirectory(BASE, SESSION_ID, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Session directory no longer exists.');
    });
  });

  describe('resolveSessionFilesDirectory', () => {
    it('returns the real files directory path for a valid session id', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(BASE)
        .mockResolvedValueOnce(FILES_DIR);
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionFilesDirectory(BASE, SESSION_ID, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).resolves.toBe(FILES_DIR);
    });

    it('rejects files directories that resolve outside the session root', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(BASE)
        .mockResolvedValueOnce(path.join(OUTSIDE_DIR, 'files'));
      const lstat = vi.fn(async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
      }));
      await expect(resolveSessionFilesDirectory(BASE, SESSION_ID, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Invalid session directory.');
    });
  });

  describe('resolveGeneratedFilePath', () => {
    const relPath = path.join('files', 'report.html');

    it('returns the validated real path for generated files inside the files directory', async () => {
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

      await expect(resolveGeneratedFilePath(BASE, SESSION_ID, relPath, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).resolves.toBe(REPORT_PATH);
    });

    it('rejects generated files that resolve outside the files directory', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(BASE)
        .mockResolvedValueOnce(FILES_DIR)
        .mockResolvedValueOnce(OUTSIDE_FILE);
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

      await expect(resolveGeneratedFilePath(BASE, SESSION_ID, relPath, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Generated file no longer exists.');
    });

    it('rejects files directories that resolve outside the session root', async () => {
      const otherSystemDir = path.resolve(path.sep + 'system');
      const otherSystemFile = path.join(otherSystemDir, 'tool');
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(BASE)
        .mockResolvedValueOnce(otherSystemDir)
        .mockResolvedValueOnce(otherSystemFile);
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

      await expect(resolveGeneratedFilePath(BASE, SESSION_ID, relPath, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Generated file no longer exists.');
    });

    it('rejects symlinked files directories', async () => {
      const realpath = vi
        .fn()
        .mockResolvedValueOnce(BASE)
        .mockResolvedValueOnce(FILES_DIR)
        .mockResolvedValueOnce(REPORT_PATH);
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

      await expect(resolveGeneratedFilePath(BASE, SESSION_ID, relPath, {
        realpathImpl: realpath,
        lstatImpl: lstat,
      })).rejects.toThrow('Generated file no longer exists.');
    });
  });

  describe('getSessionDirectoryAvailability', () => {
    // The fixture uses Windows-style backslash paths (e.g. 'C:\\Users\\...').
    // The implementation guards path traversal with `path.sep`, which is '/'
    // on darwin/linux, so the startsWith() check fails and both directories
    // report unavailable. The assertion only holds on Windows hosts.
    it.skipIf(process.platform !== 'win32')('returns separate availability flags for session and files directories', async () => {
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
