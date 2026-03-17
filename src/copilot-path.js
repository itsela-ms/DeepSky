const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function getPathDelimiter(platform) {
  return platform === 'win32' ? ';' : ':';
}

function joinForPlatform(platform, ...parts) {
  return (platform === 'win32' ? path.win32 : path.posix).join(...parts);
}

function getBinaryNames(platform) {
  return platform === 'win32' ? ['copilot.exe', 'copilot.cmd'] : ['copilot'];
}

function getLookupCommand(platform) {
  return platform === 'win32' ? 'where' : 'which';
}

function getFallbackCommand(platform) {
  return platform === 'win32' ? 'copilot.cmd' : 'copilot';
}

function getPreferredPathEntries(platform, homedir, executablePath) {
  const entries = [];

  if (executablePath && path.isAbsolute(executablePath)) {
    entries.push(path.dirname(executablePath));
  }

  if (platform === 'darwin') {
    entries.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      joinForPlatform(platform, homedir, '.local', 'bin'),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    );
  } else if (platform !== 'win32') {
    entries.push(
      '/home/linuxbrew/.linuxbrew/bin',
      '/home/linuxbrew/.linuxbrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      joinForPlatform(platform, homedir, '.local', 'bin'),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    );
  }

  return entries;
}

function buildCopilotLaunchEnv(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const executablePath = options.executablePath || '';
  const extraEnv = options.extraEnv || {};

  if (platform === 'win32') {
    return { ...env, ...extraEnv };
  }

  const delimiter = getPathDelimiter(platform);
  const currentPathEntries = String(env.PATH || '')
    .split(delimiter)
    .filter(Boolean);
  const preferredEntries = getPreferredPathEntries(platform, homedir, executablePath)
    .filter(Boolean);

  return {
    ...env,
    PATH: [...new Set([...preferredEntries, ...currentPathEntries])].join(delimiter),
    ...extraEnv,
  };
}

function getKnownInstallLocations(platform, env, homedir) {
  if (platform === 'win32') {
    return [
      joinForPlatform(platform, env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
      joinForPlatform(platform, env.LOCALAPPDATA || '', 'Programs', 'copilot-cli', 'copilot.exe'),
      joinForPlatform(platform, env.PROGRAMFILES || '', 'GitHub Copilot CLI', 'copilot.exe'),
      joinForPlatform(platform, env.APPDATA || '', 'npm', 'copilot.cmd'),
    ];
  }

  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      joinForPlatform(platform, homedir, '.local', 'bin', 'copilot'),
    ];
  }

  return [
    '/home/linuxbrew/.linuxbrew/bin/copilot',
    '/usr/local/bin/copilot',
    '/usr/bin/copilot',
    joinForPlatform(platform, homedir, '.local', 'bin', 'copilot'),
  ];
}

function resolveCopilotPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const fsImpl = options.fs || fs;
  const execSyncImpl = options.execSync || execSync;
  const lookupCommand = getLookupCommand(platform);
  const launchEnv = buildCopilotLaunchEnv({ platform, env, homedir });

  for (const bin of getBinaryNames(platform)) {
    try {
      const result = execSyncImpl(`${lookupCommand} ${bin}`, {
        encoding: 'utf8',
        timeout: 5000,
        env: launchEnv,
      }).trim();
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
  buildCopilotLaunchEnv,
  resolveCopilotPath,
  getKnownInstallLocations,
};
