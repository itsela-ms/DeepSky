import { describe, it, expect, vi } from 'vitest';

const {
  calculateNotificationPosition,
  isValidSessionId,
  pickNotificationDisplay,
  resolveCommandPath,
  resolveAgencyInfo,
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
});
