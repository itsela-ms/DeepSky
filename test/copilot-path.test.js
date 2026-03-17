import { describe, it, expect, vi } from 'vitest';

const { buildCopilotLaunchEnv, resolveCopilotPath } = require('../src/copilot-path');

describe('resolveCopilotPath', () => {
  it('falls back to copilot on macOS when auto-detection finds nothing', () => {
    const fsMock = { existsSync: vi.fn(() => false) };
    const execSyncMock = vi.fn(() => {
      throw new Error('not found');
    });

    expect(resolveCopilotPath({
      platform: 'darwin',
      fs: fsMock,
      execSync: execSyncMock,
      homedir: '/Users/tester',
      env: {},
    })).toBe('copilot');
  });

  it('uses Homebrew install path on macOS when present', () => {
    const fsMock = {
      existsSync: vi.fn((value) => value === '/opt/homebrew/bin/copilot'),
    };
    const execSyncMock = vi.fn(() => {
      throw new Error('not found');
    });

    expect(resolveCopilotPath({
      platform: 'darwin',
      fs: fsMock,
      execSync: execSyncMock,
      homedir: '/Users/tester',
      env: {},
    })).toBe('/opt/homebrew/bin/copilot');
  });

  it('uses an augmented PATH when probing for copilot on macOS', () => {
    const fsMock = { existsSync: vi.fn(() => false) };
    const execSyncMock = vi.fn(() => {
      throw new Error('not found');
    });

    resolveCopilotPath({
      platform: 'darwin',
      fs: fsMock,
      execSync: execSyncMock,
      homedir: '/Users/tester',
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(execSyncMock).toHaveBeenCalledWith('which copilot', expect.objectContaining({
      env: expect.objectContaining({
        PATH: expect.stringContaining('/opt/homebrew/bin'),
      }),
    }));
  });

  it('falls back to copilot.cmd on Windows when no path is found', () => {
    const fsMock = { existsSync: vi.fn(() => false) };
    const execSyncMock = vi.fn(() => {
      throw new Error('not found');
    });

    expect(resolveCopilotPath({
      platform: 'win32',
      fs: fsMock,
      execSync: execSyncMock,
      homedir: 'C:\\Users\\tester',
      env: {},
    })).toBe('copilot.cmd');
  });

  it('builds a launch environment that includes common macOS bin directories', () => {
    const env = buildCopilotLaunchEnv({
      platform: 'darwin',
      homedir: '/Users/tester',
      env: { PATH: '/usr/bin:/bin' },
      executablePath: '/opt/homebrew/bin/copilot',
      extraEnv: { TERM: 'xterm-256color' },
    });

    const parts = env.PATH.split(':');
    expect(parts[0]).toBe('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
    expect(parts).toContain('/Users/tester/.local/bin');
    expect(parts).toContain('/usr/bin');
    expect(env.TERM).toBe('xterm-256color');
  });
});
