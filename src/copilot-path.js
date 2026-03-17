const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function getBinaryNames(platform) {
  return platform === 'win32' ? ['copilot.exe', 'copilot.cmd'] : ['copilot'];
}

function getLookupCommand(platform) {
  return platform === 'win32' ? 'where' : 'which';
}

function getFallbackCommand(platform) {
  return platform === 'win32' ? 'copilot.cmd' : 'copilot';
}

function getKnownInstallLocations(platform, env, homedir) {
  if (platform === 'win32') {
    return [
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
      path.join(env.LOCALAPPDATA || '', 'Programs', 'copilot-cli', 'copilot.exe'),
      path.join(env.PROGRAMFILES || '', 'GitHub Copilot CLI', 'copilot.exe'),
      path.join(env.APPDATA || '', 'npm', 'copilot.cmd'),
    ];
  }

  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      path.join(homedir, '.local', 'bin', 'copilot'),
    ];
  }

  return [
    '/home/linuxbrew/.linuxbrew/bin/copilot',
    '/usr/local/bin/copilot',
    '/usr/bin/copilot',
    path.join(homedir, '.local', 'bin', 'copilot'),
  ];
}

function resolveCopilotPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const fsImpl = options.fs || fs;
  const execSyncImpl = options.execSync || execSync;
  const lookupCommand = getLookupCommand(platform);

  for (const bin of getBinaryNames(platform)) {
    try {
      const result = execSyncImpl(`${lookupCommand} ${bin}`, { encoding: 'utf8', timeout: 5000 }).trim();
      const firstMatch = result.split(/\r?\n/)[0];
      if (firstMatch && fsImpl.existsSync(firstMatch)) return firstMatch;
    } catch {}
  }

  for (const candidate of getKnownInstallLocations(platform, env, homedir)) {
    if (candidate && fsImpl.existsSync(candidate)) return candidate;
  }

  return getFallbackCommand(platform);
}

module.exports = {
  resolveCopilotPath,
  getKnownInstallLocations,
};
