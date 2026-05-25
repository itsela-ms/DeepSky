const fs = require('fs');
const path = require('path');
const os = require('os');
const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9._-]+$/;

// Common Unix install locations that GUI launches on macOS/Linux miss because
// Finder/Dock starts the app with a minimal PATH like `/usr/bin:/bin`.
function getUnixPathExtras(homeDir = os.homedir()) {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.posix.join(homeDir, '.local', 'bin'),
    path.posix.join(homeDir, '.npm-global', 'bin'),
    path.posix.join(homeDir, '.cargo', 'bin'),
    path.posix.join(homeDir, 'node_modules', '.bin'),
  ];
}

// Returns a PATH string with the Unix extras appended. On Windows returns the
// existing PATH unchanged (Windows GUI launches inherit the user PATH).
function buildAugmentedPath(currentPath = '', { platform = process.platform, homeDir = os.homedir() } = {}) {
  if (platform === 'win32') return currentPath;
  const sep = ':';
  const existing = (currentPath || '').split(sep).filter(Boolean);
  const seen = new Set(existing);
  for (const extra of getUnixPathExtras(homeDir)) {
    if (!seen.has(extra)) {
      existing.push(extra);
      seen.add(extra);
    }
  }
  return existing.join(sep);
}

// Mutates process.env.PATH so all child processes (including execSync
// `command -v` lookups) see the augmented PATH. Idempotent.
function augmentProcessPath(env = process.env) {
  if (process.platform === 'win32') return env.PATH;
  const next = buildAugmentedPath(env.PATH);
  env.PATH = next;
  return next;
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId);
}

function resolveCommandPath({
  names,
  candidates,
  fallbackCommand,
  execSyncImpl,
  existsSync = fs.existsSync,
  platform = process.platform,
  env = process.env,
}) {
  const isWin = platform === 'win32';
  const lookupCmd = isWin ? 'where' : 'command -v';
  const lookupNames = isWin
    ? names
    : Array.from(new Set(names.map(n => n.replace(/\.(exe|cmd)$/i, ''))));
  for (const bin of lookupNames) {
    if (!SAFE_COMMAND_NAME_RE.test(bin)) continue;
    try {
      const result = execSyncImpl(`${lookupCmd} ${bin}`, { encoding: 'utf8', timeout: 5000 }).trim();
      const firstMatch = result.split(/\r?\n/)[0];
      if (firstMatch && existsSync(firstMatch)) {
        return { path: firstMatch, found: true };
      }
    } catch {}
  }

  const allCandidates = isWin ? candidates : [
    ...candidates,
    '/usr/local/bin/' + fallbackCommand,
    '/opt/homebrew/bin/' + fallbackCommand,
    '/usr/bin/' + fallbackCommand,
    path.posix.join(env.HOME || '', '.local', 'bin', fallbackCommand),
    path.posix.join(env.HOME || '', '.npm-global', 'bin', fallbackCommand),
    path.posix.join(env.HOME || '', 'node_modules', '.bin', fallbackCommand),
  ];
  for (const candidate of allCandidates) {
    if (candidate && existsSync(candidate)) {
      return { path: candidate, found: true };
    }
  }

  return { path: fallbackCommand, found: false };
}

function resolveCopilotPath(deps = {}) {
  return resolveCopilotInfo(deps).path;
}

function resolveCopilotInfo(deps = {}) {
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  return resolveCommandPath({
    names: ['copilot.exe', 'copilot.cmd'],
    candidates: [
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
      path.join(env.LOCALAPPDATA || '', 'Programs', 'copilot-cli', 'copilot.exe'),
      path.join(env.PROGRAMFILES || '', 'GitHub Copilot CLI', 'copilot.exe'),
    ],
    fallbackCommand: 'copilot',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
    platform: deps.platform,
  });
}

function resolveAgencyInfo(deps = {}) {
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  const home = env.HOME || os.homedir();
  return resolveCommandPath({
    names: ['agency.exe', 'agency.cmd'],
    candidates: [
      path.join(env.APPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
      path.join(env.LOCALAPPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
      // macOS / Linux common locations
      path.posix.join(home, '.config', 'agency', 'CurrentVersion', 'agency'),
      '/opt/homebrew/bin/agency',
      '/usr/local/bin/agency',
      '/usr/bin/agency',
      path.posix.join(home, '.local', 'bin', 'agency'),
      path.posix.join(home, '.npm-global', 'bin', 'agency'),
      path.posix.join(home, '.cargo', 'bin', 'agency'),
      path.posix.join(home, 'node_modules', '.bin', 'agency'),
    ],
    fallbackCommand: 'agency',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
    platform: deps.platform,
  });
}

function resolveBrochureInfo(deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || env.USERPROFILE || env.HOME || '';
  const documentsPath = deps.documentsPath || '';
  const appPath = deps.appPath || '';
  const candidates = [
    appPath ? path.join(appPath, 'deepsky-brochure.html') : '',
    documentsPath ? path.join(documentsPath, 'deepsky-brochure.html') : '',
    homeDir ? path.join(homeDir, 'OneDrive - Microsoft', 'Documents', 'deepsky-brochure.html') : '',
    homeDir ? path.join(homeDir, 'Documents', 'deepsky-brochure.html') : '',
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) {
      return { path: candidate, found: true };
    }
  }

  return {
    path: candidates[0] || null,
    found: false,
  };
}

function pickNotificationDisplay(displays, mainWindowBounds) {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  if (!mainWindowBounds) return displays[0];

  const centerX = mainWindowBounds.x + (mainWindowBounds.width / 2);
  const centerY = mainWindowBounds.y + (mainWindowBounds.height / 2);

  const containing = displays.find((display) => {
    const bounds = display?.bounds || display?.workArea;
    if (!bounds) return false;
    return centerX >= bounds.x &&
      centerX < (bounds.x + bounds.width) &&
      centerY >= bounds.y &&
      centerY < (bounds.y + bounds.height);
  });
  if (containing) return containing;

  let best = displays[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const bounds = display?.bounds || display?.workArea;
    if (!bounds) continue;
    const displayCenterX = bounds.x + (bounds.width / 2);
    const displayCenterY = bounds.y + (bounds.height / 2);
    const distance = Math.hypot(displayCenterX - centerX, displayCenterY - centerY);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }

  return best;
}

function calculateNotificationPosition(workArea, activeCount) {
  const NOTIF_WIDTH = 360;
  const NOTIF_HEIGHT = 100;
  const PADDING = 20;
  const STACK_GAP = 8;
  const stackOffset = activeCount * (NOTIF_HEIGHT + STACK_GAP);
  return {
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT,
    x: Math.round(workArea.x + workArea.width - NOTIF_WIDTH - PADDING),
    y: Math.round(workArea.y + workArea.height - NOTIF_HEIGHT - PADDING - stackOffset),
  };
}

module.exports = {
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
};
