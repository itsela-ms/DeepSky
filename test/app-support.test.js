import { describe, it, expect, vi } from 'vitest';

const {
  calculateNotificationPosition,
  isValidSessionId,
  pickNotificationDisplay,
  resolveCommandPath,
  resolveAgencyInfo,
  resolveBrochureInfo,
  resolveCopilotInfo,
  resolveCopilotPath,
} = require('../src/app-support');

describe('app-support', () => {
  describe('resolveCopilotPath', () => {
    it('falls back to bare copilot command when nothing is found', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn(() => false);
      expect(resolveCopilotPath({ execSync, existsSync, env: {} })).toBe('copilot');
    });

    it('returns the first PATH hit when available', () => {
      const execSync = vi.fn(() => 'C:\\Tools\\copilot.exe\r\n');
      const existsSync = vi.fn((file) => file === 'C:\\Tools\\copilot.exe');
      expect(resolveCopilotPath({ execSync, existsSync, env: {} })).toBe('C:\\Tools\\copilot.exe');
    });
  });

  describe('resolveCopilotInfo', () => {
    it('reports Copilot CLI as unavailable when not found', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn(() => false);
      expect(resolveCopilotInfo({ execSync, existsSync, env: {} })).toEqual({
        path: 'copilot',
        found: false,
      });
    });
  });

  describe('resolveAgencyInfo', () => {
    it('detects agency from a known install location', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn((file) => file === 'C:\\Users\\dev\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe');
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
      });
      expect(info).toEqual({
        path: 'C:\\Users\\dev\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe',
        found: true,
      });
    });

    it('reports agency as unavailable when not found', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn(() => false);
      expect(resolveAgencyInfo({ execSync, existsSync, env: {} })).toEqual({
        path: 'agency',
        found: false,
      });
    });
  });

  describe('resolveBrochureInfo', () => {
    it('prefers the documents brochure when present', () => {
      const existsSync = vi.fn((file) => file === 'C:\\Docs\\deepsky-brochure.html');
      expect(resolveBrochureInfo({
        appPath: 'C:\\DeepSky',
        documentsPath: 'C:\\Docs',
        homeDir: 'C:\\Users\\dev',
        existsSync,
      })).toEqual({
        path: 'C:\\Docs\\deepsky-brochure.html',
        found: true,
      });
    });

    it('falls back to the known OneDrive documents path when needed', () => {
      const existsSync = vi.fn((file) => file === 'C:\\Users\\dev\\OneDrive - Microsoft\\Documents\\deepsky-brochure.html');
      expect(resolveBrochureInfo({
        appPath: 'C:\\DeepSky',
        documentsPath: 'C:\\Users\\dev\\Documents',
        homeDir: 'C:\\Users\\dev',
        existsSync,
      })).toEqual({
        path: 'C:\\Users\\dev\\OneDrive - Microsoft\\Documents\\deepsky-brochure.html',
        found: true,
      });
    });

    it('reports brochure as unavailable when no candidate exists', () => {
      const existsSync = vi.fn(() => false);
      expect(resolveBrochureInfo({
        appPath: 'C:\\DeepSky',
        documentsPath: 'C:\\Docs',
        homeDir: 'C:\\Users\\dev',
        existsSync,
      })).toEqual({
        path: 'C:\\DeepSky\\deepsky-brochure.html',
        found: false,
      });
    });
  });

  describe('resolveCommandPath', () => {
    it('ignores unsafe command names instead of interpolating them into where', () => {
      const execSync = vi.fn(() => 'should not run');
      const existsSync = vi.fn(() => false);

      const result = resolveCommandPath({
        names: ['agency.exe & whoami'],
        candidates: [],
        fallbackCommand: 'agency',
        execSyncImpl: execSync,
        existsSync,
      });

      expect(result).toEqual({ path: 'agency', found: false });
      expect(execSync).not.toHaveBeenCalled();
    });

    it('passes stdio that detaches child stdin so where cannot EPIPE the parent', () => {
      const execSync = vi.fn(() => 'C:\\Tools\\copilot.exe\r\n');
      const existsSync = vi.fn(() => true);
      resolveCommandPath({
        names: ['copilot.exe'],
        candidates: [],
        fallbackCommand: 'copilot',
        execSyncImpl: execSync,
        existsSync,
      });
      expect(execSync).toHaveBeenCalledTimes(1);
      const [, opts] = execSync.mock.calls[0];
      expect(opts).toMatchObject({ stdio: ['ignore', 'pipe', 'ignore'] });
    });
  });

  describe('command-path caching', () => {
    const { _clearCommandPathCache } = require('../src/app-support');

    it('caches resolveCopilotInfo across calls so Ctrl+W does not shell out per close', () => {
      _clearCommandPathCache();
      // First call uses the real (uninjected) execSync — we exercise the
      // cacheable production path. The probe is run and the result memoized;
      // a second call returns the SAME reference without re-probing.
      const first = resolveCopilotInfo();
      const second = resolveCopilotInfo();
      expect(second).toBe(first);
    });

    it('caches resolveAgencyInfo across calls', () => {
      _clearCommandPathCache();
      const first = resolveAgencyInfo();
      const second = resolveAgencyInfo();
      expect(second).toBe(first);
    });

    it('bypasses the cache when deps are injected so tests stay isolated', () => {
      _clearCommandPathCache();
      // Warm the production cache.
      resolveCopilotInfo();
      // Inject a deterministic execSync — the cache must NOT be returned.
      const execSync = vi.fn(() => { throw new Error('nope'); });
      const existsSync = vi.fn(() => false);
      const injected = resolveCopilotInfo({ execSync, existsSync, env: {} });
      expect(injected).toEqual({ path: 'copilot', found: false });
      // Subsequent uncached call still returns the production-cached value,
      // confirming the injected call did not overwrite or replace it.
      const reCached = resolveCopilotInfo();
      expect(reCached).not.toBe(injected);
    });
  });

  describe('session id validation', () => {
    it('accepts UUID session ids', () => {
      expect(isValidSessionId('376fedd7-eec9-429e-a4b9-5fb252880d42')).toBe(true);
    });

    it('rejects path-like session ids', () => {
      expect(isValidSessionId('..\\..\\oops')).toBe(false);
    });
  });

  describe('notification placement', () => {
    it('anchors notifications to the display containing the app window', () => {
      const displays = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
        { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
      ];
      const display = pickNotificationDisplay(displays, { x: 2200, y: 200, width: 1200, height: 900 });
      expect(display.workArea).toEqual({ x: 1920, y: 0, width: 2560, height: 1400 });
    });

    it('calculates stacked bottom-right popup positions', () => {
      expect(calculateNotificationPosition({ x: 1920, y: 0, width: 2560, height: 1400 }, 1)).toEqual({
        width: 360,
        height: 100,
        x: 4100,
        y: 1172,
      });
    });
  });
});
