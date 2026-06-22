import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const UpdateService = require('../src/update-service');

function makeMockAutoUpdater() {
  const handlers = {};
  return {
    autoDownload: undefined,
    autoInstallOnAppQuit: undefined,
    allowPrerelease: undefined,
    handlers,
    on: vi.fn((event, handler) => { handlers[event] = handler; }),
    checkForUpdates: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn(),
  };
}

function makeMockIpcMain() {
  const handlers = {};
  return {
    ipcMain: { handle: vi.fn((channel, handler) => { handlers[channel] = handler; }) },
    handlers,
  };
}

function makeSettingsService(overrides = {}) {
  const defaults = { autoUpdateEnabled: true, updateChannel: 'stable' };
  const settings = { ...defaults, ...overrides };
  return { get: () => ({ ...settings }), update: (partial) => Object.assign(settings, partial) };
}

function makeMainWindow() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('UpdateService', () => {
  let mockAutoUpdater;
  let mockIpc;
  let tempDirs;

  beforeEach(() => {
    vi.useFakeTimers();
    mockAutoUpdater = makeMockAutoUpdater();
    mockIpc = makeMockIpcMain();
    tempDirs = [];
  });

  afterEach(() => {
    for (const tempDir of tempDirs) rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makePendingUpdatePath() {
    const tempDir = mkdtempSync(join(tmpdir(), 'deepsky-update-'));
    tempDirs.push(tempDir);
    return join(tempDir, 'pending-update.json');
  }

  describe('constructor — applies settings to autoUpdater', () => {
    it('enables auto-download without using quit-time installs when autoUpdateEnabled is true', () => {
      new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: true }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.autoDownload).toBe(true);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    });

    it('disables auto-download when autoUpdateEnabled is false', () => {
      new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: false }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    });

    it('enables pre-releases when updateChannel is beta', () => {
      new UpdateService(makeMainWindow(), makeSettingsService({ updateChannel: 'beta' }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.allowPrerelease).toBe(true);
    });

    it('disables pre-releases when updateChannel is stable', () => {
      new UpdateService(makeMainWindow(), makeSettingsService({ updateChannel: 'stable' }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.allowPrerelease).toBe(false);
    });

    it('defaults to enabled + stable when settings are missing', () => {
      const svc = makeSettingsService({});
      new UpdateService(makeMainWindow(), svc, { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.autoDownload).toBe(true);
      expect(mockAutoUpdater.allowPrerelease).toBe(false);
    });
  });

  describe('applySettings IPC — live toggle', () => {
    it('switches to beta channel when setting changes', () => {
      const settings = makeSettingsService({ updateChannel: 'stable' });
      new UpdateService(makeMainWindow(), settings, { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.allowPrerelease).toBe(false);

      settings.update({ updateChannel: 'beta' });
      mockIpc.handlers['update:applySettings']();
      expect(mockAutoUpdater.allowPrerelease).toBe(true);
    });

    it('disables auto-update when setting changes', () => {
      const settings = makeSettingsService({ autoUpdateEnabled: true });
      new UpdateService(makeMainWindow(), settings, { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.autoDownload).toBe(true);

      settings.update({ autoUpdateEnabled: false });
      mockIpc.handlers['update:applySettings']();
      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    });

    it('re-enables auto-update when setting changes back', () => {
      const settings = makeSettingsService({ autoUpdateEnabled: false });
      new UpdateService(makeMainWindow(), settings, { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      expect(mockAutoUpdater.autoDownload).toBe(false);

      settings.update({ autoUpdateEnabled: true });
      mockIpc.handlers['update:applySettings']();
      expect(mockAutoUpdater.autoDownload).toBe(true);
    });
  });

  describe('checkOnStartup — respects autoUpdateEnabled', () => {
    it('skips startup check when auto-update is disabled', async () => {
      const svc = new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: false }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      await svc.checkOnStartup();
      vi.advanceTimersByTime(10000);
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('schedules startup check when auto-update is enabled', async () => {
      const svc = new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: true }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      await svc.checkOnStartup();
      vi.advanceTimersByTime(6000); // past the 5s delay
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
    });

    it('skips startup check when an update is pending install', async () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');
      const svc = new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: true }), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      await svc.checkOnStartup();
      vi.advanceTimersByTime(6000);

      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe('periodic check — respects autoUpdateEnabled', () => {
    it('does not start periodic checks when disabled', async () => {
      const svc = new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: false }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      await svc.checkOnStartup();
      vi.advanceTimersByTime(20 * 60 * 1000); // 20 minutes
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('stops periodic timer when auto-update is disabled mid-session', async () => {
      const settings = makeSettingsService({ autoUpdateEnabled: true });
      const svc = new UpdateService(makeMainWindow(), settings, { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      await svc.checkOnStartup();
      // Flush the 5s startup timeout so it doesn't interfere
      await vi.advanceTimersByTimeAsync(6000);
      mockAutoUpdater.checkForUpdates.mockClear();

      // Disable mid-session
      settings.update({ autoUpdateEnabled: false });
      mockIpc.handlers['update:applySettings']();

      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe('settings persistence integration', () => {
    it('autoUpdateEnabled defaults to true in SettingsService', () => {
      const SettingsService = require('../src/settings-service');
      const svc = new SettingsService('/tmp/fake');
      expect(svc.get().autoUpdateEnabled).toBe(true);
    });

    it('updateChannel defaults to stable in SettingsService', () => {
      const SettingsService = require('../src/settings-service');
      const svc = new SettingsService('/tmp/fake');
      expect(svc.get().updateChannel).toBe('stable');
    });
  });

  describe('getStatus IPC', () => {
    it('returns current status', () => {
      new UpdateService(makeMainWindow(), makeSettingsService(), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      const result = mockIpc.handlers['update:getStatus']();
      expect(result).toEqual({ status: 'idle', info: null, progress: null, error: null });
    });
  });

  describe('pending downloaded updates', () => {
    it('saves a pending update marker when an update downloads', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      mockAutoUpdater.handlers['update-downloaded']({ version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' });

      const saved = JSON.parse(readFileSync(pendingUpdatePath, 'utf8'));
      expect(saved).toMatchObject({ version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' });
      expect(saved.downloadedAt).toEqual(expect.any(String));
      expect(mockIpc.handlers['update:getStatus']()).toMatchObject({
        status: 'downloaded',
        info: { version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' },
      });
    });

    it('hydrates a downloaded update as pending install on startup', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' }), 'utf8');

      new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: true }), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      expect(mockIpc.handlers['update:getStatus']()).toEqual({
        status: 'pending-install',
        info: { version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' },
        progress: { percent: 0, indeterminate: true },
        error: null,
      });
    });

    it('leaves a pending update downloaded when auto-update is disabled', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');

      new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: false }), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      expect(mockIpc.handlers['update:getStatus']()).toMatchObject({
        status: 'downloaded',
        info: { version: '1.2.4' },
      });
    });

    it('clears the pending marker when the running version matches', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');

      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.4',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      expect(mockIpc.handlers['update:getStatus']()).toEqual({ status: 'idle', info: null, progress: null, error: null });
      expect(existsSync(pendingUpdatePath)).toBe(false);
    });

    it('clears a stale pending marker when the running version is newer', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.3' }), 'utf8');

      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.4-beta.1',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      expect(mockIpc.handlers['update:getStatus']()).toEqual({ status: 'idle', info: null, progress: null, error: null });
      expect(existsSync(pendingUpdatePath)).toBe(false);
    });

    it('keeps a pending stable release when the current version is its prerelease', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');

      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.4-beta.1',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      expect(mockIpc.handlers['update:getStatus']()).toMatchObject({
        status: 'pending-install',
        info: { version: '1.2.4' },
      });
      expect(existsSync(pendingUpdatePath)).toBe(true);
    });

    it('clears an invalid pending marker instead of blocking startup', () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: 'not-a-version' }), 'utf8');

      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.4-beta.1',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      expect(mockIpc.handlers['update:getStatus']()).toEqual({ status: 'idle', info: null, progress: null, error: null });
      expect(existsSync(pendingUpdatePath)).toBe(false);
    });

    it('does not crash startup when a stale pending marker cannot be deleted', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const clearError = new Error('file is locked');
      clearError.code = 'EPERM';
      const fs = {
        readFileSync: vi.fn(() => JSON.stringify({ version: '1.2.4' })),
        unlinkSync: vi.fn(() => { throw clearError; }),
      };

      expect(() => new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.4',
        fs,
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath: 'C:\\Users\\test\\.copilot\\pending-update.json',
      })).not.toThrow();

      expect(warn).toHaveBeenCalledWith('Failed to clear pending update marker:', clearError);
      warn.mockRestore();
    });
  });

  describe('installUpdate', () => {
    it('re-checks a hydrated pending update before calling quitAndInstall', async () => {
      const mainWindow = makeMainWindow();
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');
      mockAutoUpdater.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: { version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' },
        downloadPromise: Promise.resolve(['installer']),
      });
      new UpdateService(mainWindow, makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      const result = mockIpc.handlers['update:install']();

      expect(result).toEqual({
        status: 'installing',
        info: { version: '1.2.4', releaseDate: undefined },
        progress: { percent: 0, indeterminate: true },
      });
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('update:status', {
        status: 'installing',
        info: { version: '1.2.4', releaseDate: undefined },
        progress: { percent: 0, indeterminate: true },
      });
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

      await flushPromises();
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

      mockAutoUpdater.handlers['update-downloaded']({ version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('keeps installing state when updater emits checking-for-update during startup install', async () => {
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');
      mockAutoUpdater.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: { version: '1.2.4' },
        downloadPromise: Promise.resolve(['installer']),
      });
      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      mockIpc.handlers['update:install']();
      mockAutoUpdater.handlers['checking-for-update']();
      mockAutoUpdater.handlers['update-available']({ version: '1.2.4' });
      mockAutoUpdater.handlers['update-downloaded']({ version: '1.2.4' });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockIpc.handlers['update:getStatus']()).toMatchObject({ status: 'installing' });
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('installs directly when the update was downloaded in the current process', async () => {
      const pendingUpdatePath = makePendingUpdatePath();
      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      mockAutoUpdater.handlers['update-downloaded']({ version: '1.2.4', releaseDate: '2025-01-02T00:00:00Z' });
      const result = mockIpc.handlers['update:install']();

      expect(result).toMatchObject({ status: 'installing', info: { version: '1.2.4' } });
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('clears a pending install timer during dispose', async () => {
      const svc = new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath: makePendingUpdatePath(),
      });

      svc.installUpdate();
      svc.dispose();
      await vi.advanceTimersByTimeAsync(500);

      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('does not quit and install if updater emits an error before the install timer fires', async () => {
      const mainWindow = makeMainWindow();
      const pendingUpdatePath = makePendingUpdatePath();
      writeFileSync(pendingUpdatePath, JSON.stringify({ version: '1.2.4' }), 'utf8');
      new UpdateService(mainWindow, makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      mockIpc.handlers['update:install']();
      mockAutoUpdater.handlers.error(new Error('installer failed'));
      await vi.advanceTimersByTimeAsync(500);

      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(existsSync(pendingUpdatePath)).toBe(false);
      expect(mockIpc.handlers['update:getStatus']()).toEqual({
        status: 'error',
        info: { version: '1.2.4', releaseDate: undefined },
        progress: { percent: 0, indeterminate: true },
        error: 'installer failed',
      });
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('update:status', {
        status: 'error',
        error: 'installer failed',
      });
    });

    it('clears the pending marker if quitAndInstall throws', async () => {
      const pendingUpdatePath = makePendingUpdatePath();
      mockAutoUpdater.quitAndInstall.mockImplementation(() => {
        throw new Error('quit failed');
      });
      new UpdateService(makeMainWindow(), makeSettingsService(), {
        autoUpdater: mockAutoUpdater,
        currentVersion: '1.2.3',
        ipcMain: mockIpc.ipcMain,
        pendingUpdatePath,
      });

      mockAutoUpdater.handlers['update-downloaded']({ version: '1.2.4' });
      mockIpc.handlers['update:install']();
      await vi.advanceTimersByTimeAsync(500);

      expect(existsSync(pendingUpdatePath)).toBe(false);
      expect(mockIpc.handlers['update:getStatus']()).toEqual({
        status: 'error',
        info: { version: '1.2.4', releaseDate: undefined },
        progress: { percent: 0, indeterminate: true },
        error: 'quit failed',
      });
    });
  });

  describe('dispose', () => {
    it('clears the periodic timer', async () => {
      const svc = new UpdateService(makeMainWindow(), makeSettingsService({ autoUpdateEnabled: true }), { autoUpdater: mockAutoUpdater, ipcMain: mockIpc.ipcMain });
      await svc.checkOnStartup();
      // Flush the 5s startup timeout so it doesn't interfere
      await vi.advanceTimersByTimeAsync(6000);
      mockAutoUpdater.checkForUpdates.mockClear();

      svc.dispose();
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });
});
