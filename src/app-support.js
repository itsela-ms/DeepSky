const fs = require('fs');
const path = require('path');
const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9._-]+$/;

// Module-level cache for CLI path probes. resolveAgency/Copilot are called
// on every settings:get, every session creation, and every warm-up — which
// fires from pty:kill, so each Ctrl+W used to run 2x execSync('where ...').
// Beyond the perf cost (~30–60ms per shellout on Windows), the synchronous
// `where` child can EPIPE if its stdin pipe closes before Node finishes
// closing the parent end, surfacing as an "Uncaught Exception" dialog.
// These paths essentially never change while the app is running, so cache
// the result for the process lifetime. Test paths inject `deps`, which
// bypasses the cache entirely.
const _commandPathCache = new Map();
function _clearCommandPathCache() { _commandPathCache.clear(); }

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId);
}

function resolveCommandPath({
  names,
  candidates,
  fallbackCommand,
  execSyncImpl,
  existsSync = fs.existsSync,
}) {
  for (const bin of names) {
    if (!SAFE_COMMAND_NAME_RE.test(bin)) continue;
    try {
      // stdio: ['ignore', 'pipe', 'ignore'] removes the stdin pipe entirely,
      // which is what was EPIPE-ing on Windows when cmd.exe closed before
      // Node's parent-side cleanup wrote its end-of-stream marker. The empty
      // try/catch above only catches synchronous throws — the EPIPE was
      // surfacing as an Electron uncaughtException dialog.
      const result = execSyncImpl(`where ${bin}`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const firstMatch = result.split(/\r?\n/)[0];
      if (firstMatch && existsSync(firstMatch)) {
        return { path: firstMatch, found: true };
      }
    } catch {}
  }

  for (const candidate of candidates) {
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
  const cacheable = !deps.execSync && !deps.existsSync && !deps.env;
  if (cacheable && _commandPathCache.has('copilot')) {
    return _commandPathCache.get('copilot');
  }
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  const result = resolveCommandPath({
    names: ['copilot.exe', 'copilot.cmd'],
    candidates: [
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'),
      path.join(env.LOCALAPPDATA || '', 'Programs', 'copilot-cli', 'copilot.exe'),
      path.join(env.PROGRAMFILES || '', 'GitHub Copilot CLI', 'copilot.exe'),
    ],
    fallbackCommand: 'copilot',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
  });
  if (cacheable) _commandPathCache.set('copilot', result);
  return result;
}

function resolveAgencyInfo(deps = {}) {
  const cacheable = !deps.execSync && !deps.existsSync && !deps.env;
  if (cacheable && _commandPathCache.has('agency')) {
    return _commandPathCache.get('agency');
  }
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  const result = resolveCommandPath({
    names: ['agency.exe', 'agency.cmd'],
    candidates: [
      path.join(env.APPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
      path.join(env.LOCALAPPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
    ],
    fallbackCommand: 'agency',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
  });
  if (cacheable) _commandPathCache.set('agency', result);
  return result;
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
  calculateNotificationPosition,
  isValidSessionId,
  pickNotificationDisplay,
  resolveCommandPath,
  resolveAgencyInfo,
  resolveBrochureInfo,
  resolveCopilotInfo,
  resolveCopilotPath,
  _clearCommandPathCache,
};
