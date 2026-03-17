import { describe, it, expect, vi } from 'vitest';

const { resolveCopilotPath } = require('../src/copilot-path');

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
});
