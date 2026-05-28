import { describe, it, expect, vi } from 'vitest';

const path = require('path');
const { chmodSpawnHelper } = require('../scripts/after-pack');

function makeFs({ archs = ['darwin-arm64'], statThrowsFor = [] } = {}) {
  const chmodCalls = [];
  return {
    chmodCalls,
    fs: {
      readdirSync: vi.fn((p) => {
        if (p.endsWith('prebuilds')) return archs;
        throw new Error(`unexpected readdirSync(${p})`);
      }),
      statSync: vi.fn((p) => {
        if (statThrowsFor.some((s) => p.includes(s))) {
          throw new Error('ENOENT');
        }
        return { isFile: () => true };
      }),
      chmodSync: vi.fn((p, mode) => {
        chmodCalls.push({ path: p, mode });
      }),
    },
  };
}

describe('after-pack chmodSpawnHelper', () => {
  it('is a no-op on win32 (no spawn-helper exists)', () => {
    const log = vi.fn();
    const result = chmodSpawnHelper(
      { appOutDir: 'C:\\release\\win-unpacked', electronPlatformName: 'win32' },
      { log }
    );
    expect(result.skipped).toBe(true);
    expect(result.chmodded).toEqual([]);
  });

  it('chmods every spawn-helper under prebuilds/*/ to 0o755 on darwin', () => {
    const { fs: fsMock, chmodCalls } = makeFs({ archs: ['darwin-arm64', 'darwin-x64'] });
    const log = vi.fn();
    // We bypass real disk walking by injecting findUnpackedNodePty so the test
    // is platform-agnostic (this suite runs on Windows CI).
    const ptyDir = '/tmp/DeepSky.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty';
    const result = chmodSpawnHelper(
      { appOutDir: '/tmp', electronPlatformName: 'darwin' },
      { fs: fsMock, log, findUnpackedNodePty: () => ptyDir }
    );
    expect(result.skipped).toBe(false);
    expect(result.chmodded).toHaveLength(2);
    expect(chmodCalls).toEqual([
      { path: path.join(ptyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper'), mode: 0o755 },
      { path: path.join(ptyDir, 'prebuilds', 'darwin-x64', 'spawn-helper'), mode: 0o755 },
    ]);
  });

  it('throws when zero spawn-helpers were chmodded (loud failure beats silent broken build)', () => {
    // Every arch dir is missing its spawn-helper → must throw, because the
    // packaged app would ship a broken node-pty that fails on every session.
    const { fs: fsMock } = makeFs({ archs: ['darwin-arm64'], statThrowsFor: ['spawn-helper'] });
    const ptyDir = '/tmp/DeepSky.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty';
    expect(() => chmodSpawnHelper(
      { appOutDir: '/tmp', electronPlatformName: 'darwin' },
      { fs: fsMock, log: () => {}, findUnpackedNodePty: () => ptyDir }
    )).toThrow(/found no spawn-helper/);
  });

  it('throws a descriptive error when prebuilds dir cannot be read', () => {
    const fsMock = {
      readdirSync: vi.fn(() => { throw new Error('ENOENT'); }),
      statSync: vi.fn(),
      chmodSync: vi.fn(),
    };
    expect(() => chmodSpawnHelper(
      { appOutDir: '/tmp', electronPlatformName: 'darwin' },
      { fs: fsMock, log: () => {}, findUnpackedNodePty: () => '/tmp/node-pty' }
    )).toThrow(/cannot read .*prebuilds/);
  });
});
