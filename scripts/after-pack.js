'use strict';

// electron-builder afterPack hook.
//
// Why this exists:
//   node-pty ships a small `spawn-helper` binary in its prebuilds folder. On
//   macOS/Linux node-pty MUST be able to exec this helper to spin up a PTY —
//   without it node-pty falls back to `posix_spawnp` failures / EACCES and
//   every session spawn dies the moment a user opens a tab.
//
//   Two things go wrong when packaging:
//     1. Files inside `app.asar` cannot be exec'd → we must `asarUnpack`
//        node-pty (handled in package.json).
//     2. electron-builder copies files but strips the executable bit. So even
//        with `app.asar.unpacked/node_modules/node-pty/prebuilds/<arch>/spawn-helper`
//        present, `stat -x` returns 0o644 and execve refuses.
//
//   This hook walks every `prebuilds/*/spawn-helper` under the unpacked
//   node-pty directory and chmod's it back to 0o755. It is a no-op on
//   Windows (where node-pty uses ConPTY and ships no spawn-helper).
//
// Exports: an async function with the electron-builder afterPack signature.
//   context: { appOutDir, electronPlatformName, arch, packager, ... }
// The hook is also exported as `chmodSpawnHelper(context, deps)` so tests
// can inject fs without touching disk.

const fs = require('fs');
const path = require('path');

function findUnpackedNodePty(appOutDir, platform) {
  // electron-builder packages produce different folder layouts per platform:
  //   macOS  → <appOutDir>/<ProductName>.app/Contents/Resources/app.asar.unpacked
  //   Linux  → <appOutDir>/resources/app.asar.unpacked
  // We search for any *.app on darwin, otherwise the linux layout.
  if (platform === 'darwin') {
    let entries = [];
    try { entries = fs.readdirSync(appOutDir); } catch { return null; }
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) return null;
    return path.join(
      appOutDir, appBundle, 'Contents', 'Resources', 'app.asar.unpacked',
      'node_modules', 'node-pty'
    );
  }
  return path.join(
    appOutDir, 'resources', 'app.asar.unpacked',
    'node_modules', 'node-pty'
  );
}

function chmodSpawnHelper(context, deps = {}) {
  const log = deps.log || ((msg) => console.log(`[afterPack] ${msg}`));
  const platform = context.electronPlatformName || process.platform;
  if (platform === 'win32') {
    log('skip: win32 has no spawn-helper');
    return { skipped: true, chmodded: [] };
  }

  const fsLayer = deps.fs || fs;
  const nodePtyDir = (deps.findUnpackedNodePty || findUnpackedNodePty)(
    context.appOutDir, platform
  );
  if (!nodePtyDir) {
    throw new Error(`[afterPack] could not locate unpacked node-pty under ${context.appOutDir}`);
  }

  const prebuildsDir = path.join(nodePtyDir, 'prebuilds');
  let archDirs;
  try {
    archDirs = fsLayer.readdirSync(prebuildsDir);
  } catch (err) {
    throw new Error(`[afterPack] cannot read ${prebuildsDir}: ${err.message}`);
  }

  const chmodded = [];
  for (const archDir of archDirs) {
    const helper = path.join(prebuildsDir, archDir, 'spawn-helper');
    let stat;
    try { stat = fsLayer.statSync(helper); } catch { continue; }
    if (!stat || !stat.isFile()) continue;
    fsLayer.chmodSync(helper, 0o755);
    log(`chmod +x ${helper}`);
    chmodded.push(helper);
  }

  if (chmodded.length === 0) {
    throw new Error(`[afterPack] found no spawn-helper under ${prebuildsDir} — node-pty PTY sessions will fail to spawn`);
  }

  return { skipped: false, chmodded };
}

module.exports = async function afterPack(context) {
  return chmodSpawnHelper(context);
};

module.exports.chmodSpawnHelper = chmodSpawnHelper;
module.exports.findUnpackedNodePty = findUnpackedNodePty;
