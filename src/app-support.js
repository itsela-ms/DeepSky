const fs = require('fs');
const path = require('path');
const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9._-]+$/;

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
      const result = execSyncImpl(`where ${bin}`, { encoding: 'utf8', timeout: 5000 }).trim();
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
  }).path;
}

function resolveAgencyInfo(deps = {}) {
  const { execSync } = deps.execSync ? deps : require('child_process');
  const env = deps.env || process.env;
  return resolveCommandPath({
    names: ['agency.exe', 'agency.cmd'],
    candidates: [
      path.join(env.APPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
      path.join(env.LOCALAPPDATA || '', 'agency', 'CurrentVersion', 'agency.exe'),
    ],
    fallbackCommand: 'agency',
    execSyncImpl: execSync,
    existsSync: deps.existsSync || fs.existsSync,
  });
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
  resolveCopilotPath,
};
