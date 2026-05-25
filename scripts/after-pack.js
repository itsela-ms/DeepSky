// electron-builder afterPack hook.
// Restores the execute bit on node-pty's `spawn-helper` binary on macOS/Linux.
// Without this, node-pty's posix_spawnp(helperPath) fails with EACCES,
// surfacing as "posix_spawnp failed" when opening a session.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName === 'win32') return;

  const productFilename = packager.appInfo.productFilename;
  const resourcesPath = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');

  const unpackedRoot = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(unpackedRoot)) return;

  for (const dir of fs.readdirSync(unpackedRoot)) {
    const helper = path.join(unpackedRoot, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      try {
        fs.chmodSync(helper, 0o755);
        console.log(`[afterPack] chmod +x ${helper}`);
      } catch (err) {
        console.warn(`[afterPack] failed to chmod ${helper}: ${err.message}`);
      }
    }
  }
};
