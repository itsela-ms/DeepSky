import { describe, it, expect, vi } from 'vitest';

const {
  augmentProcessPath,
  buildAugmentedPath,
  calculateNotificationPosition,
  getUnixPathExtras,
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
      const path = require('path');
      const appData = 'C:\\Users\\dev\\AppData\\Roaming';
      const expectedPath = path.join(appData, 'agency', 'CurrentVersion', 'agency.exe');
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn((file) => file === expectedPath);
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        env: { APPDATA: appData },
      });
      expect(info).toEqual({
        path: expectedPath,
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

  // The brochure tests hard-code Windows-style paths (e.g. 'C:\\Docs') and
  // expect backslash-joined outputs. Node's path.join on darwin/linux uses '/'
  // as the separator, so the mocked existsSync never matches and the assertions
  // can only be meaningfully evaluated on Windows hosts.
  describe.skipIf(process.platform !== 'win32')('resolveBrochureInfo', () => {
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

  describe('getUnixPathExtras', () => {
    it('returns the standard mac/linux bin directories using the supplied home', () => {
      const extras = getUnixPathExtras('/home/jane');
      expect(extras).toContain('/opt/homebrew/bin');
      expect(extras).toContain('/usr/local/bin');
      expect(extras).toContain('/home/jane/.local/bin');
      expect(extras).toContain('/home/jane/.npm-global/bin');
      expect(extras).toContain('/home/jane/.cargo/bin');
    });
  });

  describe('buildAugmentedPath', () => {
    it('appends mac extras to an existing PATH on darwin/linux', () => {
      const result = buildAugmentedPath('/usr/bin:/bin', { platform: 'darwin', homeDir: '/Users/jane' });
      const segments = result.split(':');
      expect(segments[0]).toBe('/usr/bin');
      expect(segments[1]).toBe('/bin');
      expect(segments).toContain('/opt/homebrew/bin');
      expect(segments).toContain('/Users/jane/.local/bin');
    });

    it('does not duplicate entries already on PATH', () => {
      const result = buildAugmentedPath('/opt/homebrew/bin:/usr/bin', { platform: 'darwin', homeDir: '/h' });
      const occurrences = result.split(':').filter((p) => p === '/opt/homebrew/bin').length;
      expect(occurrences).toBe(1);
    });

    it('returns the original PATH unchanged on win32', () => {
      const before = 'C:\\Windows\\System32;C:\\Tools';
      expect(buildAugmentedPath(before, { platform: 'win32', homeDir: 'C:\\Users\\jane' })).toBe(before);
    });

    it('handles an empty PATH gracefully', () => {
      const result = buildAugmentedPath('', { platform: 'linux', homeDir: '/h' });
      expect(result.split(':')).toContain('/usr/local/bin');
    });
  });

  describe('augmentProcessPath', () => {
    it.skipIf(process.platform === 'win32')('mutates the supplied env object on darwin/linux', () => {
      const env = { PATH: '/usr/bin' };
      const result = augmentProcessPath(env);
      expect(env.PATH).toBe(result);
      expect(env.PATH.split(':')).toContain('/opt/homebrew/bin');
    });

    it.skipIf(process.platform === 'win32')('is idempotent on darwin/linux', () => {
      const env = { PATH: '/usr/bin' };
      augmentProcessPath(env);
      const after = env.PATH;
      augmentProcessPath(env);
      expect(env.PATH).toBe(after);
    });

    it.skipIf(process.platform !== 'win32')('leaves PATH alone on win32', () => {
      const before = process.env.PATH;
      const result = augmentProcessPath({ PATH: before });
      expect(result).toBe(before);
    });
  });

  describe('resolveCommandPath platform behavior', () => {
    it('uses `command -v` and strips .exe/.cmd on non-Windows', () => {
      const calls = [];
      const execSync = vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd === 'command -v copilot') return '/opt/homebrew/bin/copilot\n';
        throw new Error('not found');
      });
      const existsSync = vi.fn((file) => file === '/opt/homebrew/bin/copilot');
      const result = resolveCommandPath({
        names: ['copilot.exe', 'copilot.cmd'],
        candidates: [],
        fallbackCommand: 'copilot',
        execSyncImpl: execSync,
        existsSync,
        platform: 'darwin',
        env: { HOME: '/Users/x' },
      });
      expect(result).toEqual({ path: '/opt/homebrew/bin/copilot', found: true });
      expect(calls.some((c) => c.startsWith('command -v'))).toBe(true);
      // .exe/.cmd should have been stripped to a single 'copilot' lookup
      expect(calls.filter((c) => c.includes('copilot.exe')).length).toBe(0);
    });

    it('uses `where` and keeps .exe/.cmd on win32', () => {
      const calls = [];
      const execSync = vi.fn((cmd) => {
        calls.push(cmd);
        if (cmd === 'where copilot.exe') return 'C:\\Tools\\copilot.exe\r\n';
        throw new Error('not found');
      });
      const existsSync = vi.fn((file) => file === 'C:\\Tools\\copilot.exe');
      const result = resolveCommandPath({
        names: ['copilot.exe', 'copilot.cmd'],
        candidates: [],
        fallbackCommand: 'copilot',
        execSyncImpl: execSync,
        existsSync,
        platform: 'win32',
        env: {},
      });
      expect(result).toEqual({ path: 'C:\\Tools\\copilot.exe', found: true });
      expect(calls).toContain('where copilot.exe');
    });

    it('falls back to mac/linux candidate paths when `command -v` fails', () => {
      const execSync = vi.fn(() => { throw new Error('not found'); });
      const existsSync = vi.fn((file) => file === '/opt/homebrew/bin/agency');
      const result = resolveCommandPath({
        names: ['agency.exe'],
        candidates: [],
        fallbackCommand: 'agency',
        execSyncImpl: execSync,
        existsSync,
        platform: 'darwin',
        env: { HOME: '/Users/x' },
      });
      expect(result).toEqual({ path: '/opt/homebrew/bin/agency', found: true });
    });
  });

  describe('resolveAgencyInfo on macOS', () => {
    it('finds agency at /opt/homebrew/bin', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn((file) => file === '/opt/homebrew/bin/agency');
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        platform: 'darwin',
        env: { HOME: '/Users/dev' },
      });
      expect(info).toEqual({ path: '/opt/homebrew/bin/agency', found: true });
    });

    it('finds agency at ~/.local/bin', () => {
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn((file) => file === '/Users/dev/.local/bin/agency');
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        platform: 'darwin',
        env: { HOME: '/Users/dev' },
      });
      expect(info).toEqual({ path: '/Users/dev/.local/bin/agency', found: true });
    });

    it('finds agency at the per-user ~/.config/agency/CurrentVersion install location', () => {
      const path = require('path');
      const expectedPath = path.posix.join('/Users/dev', '.config', 'agency', 'CurrentVersion', 'agency');
      const execSync = vi.fn(() => { throw new Error('missing'); });
      const existsSync = vi.fn((file) => file === expectedPath);
      const info = resolveAgencyInfo({
        execSync,
        existsSync,
        platform: 'darwin',
        env: { HOME: '/Users/dev' },
      });
      expect(info).toEqual({ path: expectedPath, found: true });
    });
  });
});
