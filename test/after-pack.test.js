import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

const afterPack = require('../scripts/after-pack').default;

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsky-afterpack-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeContext({ platform = 'darwin' } = {}) {
  const appOutDir = tmpDir;
  const appName = 'DeepSky';
  if (platform === 'darwin') {
    fs.mkdirSync(path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources'), { recursive: true });
  } else {
    fs.mkdirSync(path.join(appOutDir, 'resources'), { recursive: true });
  }
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: appName } },
  };
}

function plantHelper(ctx, archDir, mode = 0o644) {
  const base = ctx.electronPlatformName === 'darwin'
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const helperDir = path.join(base, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', archDir);
  fs.mkdirSync(helperDir, { recursive: true });
  const helperPath = path.join(helperDir, 'spawn-helper');
  fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n', { mode });
  fs.chmodSync(helperPath, mode);
  return helperPath;
}

describe('scripts/after-pack', () => {
  it.skipIf(process.platform === 'win32')('restores execute bit on the macOS spawn-helper', async () => {
    const ctx = makeContext({ platform: 'darwin' });
    const helper = plantHelper(ctx, 'darwin-arm64', 0o644);
    expect(fs.statSync(helper).mode & 0o111).toBe(0);

    await afterPack(ctx);

    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('handles multiple architectures', async () => {
    const ctx = makeContext({ platform: 'darwin' });
    const arm = plantHelper(ctx, 'darwin-arm64', 0o644);
    const x64 = plantHelper(ctx, 'darwin-x64', 0o644);

    await afterPack(ctx);

    expect(fs.statSync(arm).mode & 0o111).not.toBe(0);
    expect(fs.statSync(x64).mode & 0o111).not.toBe(0);
  });

  it('is a no-op when prebuilds directory is missing', async () => {
    const ctx = makeContext({ platform: 'darwin' });
    await expect(afterPack(ctx)).resolves.toBeUndefined();
  });

  it('skips work entirely on Windows', async () => {
    const ctx = makeContext({ platform: 'win32' });
    const helper = plantHelper(ctx, 'win32-x64', 0o644);
    await afterPack(ctx);
    // Mode should be unchanged (no chmod attempted)
    expect(fs.statSync(helper).mode & 0o111).toBe(0);
  });
});
