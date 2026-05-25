// DeepSky logger
// ---------------------------------------------------------------------------
// Thin wrapper around electron-log (https://github.com/megahertz/electron-log)
// which is the de-facto Electron logging library: structured logs, automatic
// daily rotation, renderer→main bridging, and a known on-disk layout.
//
//   * File name format:   logs/main-YYYY-MM-DD.log   (one file per day)
//   * Log directory:      <userData>/logs            (revealed from UI)
//   * Scoped loggers:     scoped('pty-manager').info(...)
//   * Renderer bridge:    capture console + uncaught errors from the window
//
// To keep `require('./logger')` cheap and side-effect-free (so unit tests
// can import sibling modules without Electron), `electron-log/main` is loaded
// lazily — call `initLogger(app)` once from main.js when the app is ready.

const path = require('path');
const fs = require('fs');
const os = require('os');

const noop = () => {};
const NOOP_LOG = Object.freeze({
  error: noop, warn: noop, info: noop, debug: noop, verbose: noop, silly: noop,
});

let log = null;
let initialised = false;

function ensureLog() {
  if (log) return log;
  try { log = require('electron-log/main'); } catch { log = null; }
  return log;
}

function getLogsDir(app) {
  // userData differs per OS:
  //   macOS:   ~/Library/Application Support/deepsky/logs
  //   Windows: %APPDATA%\deepsky\logs
  //   Linux:   ~/.config/deepsky/logs
  const userData = app?.getPath ? app.getPath('userData') : path.join(os.homedir(), '.deepsky');
  return path.join(userData, 'logs');
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function initLogger(app, { level = 'info', maxSize = 5 * 1024 * 1024 } = {}) {
  if (initialised) return log;
  const logger = ensureLog();
  if (!logger) return null;

  const logsDir = getLogsDir(app);
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}

  // electron-log rotates the file when it grows past `maxSize` (rotated copy
  // gets `.old` suffixed) so the daily naming stays clean.
  logger.transports.file.resolvePathFn = () => path.join(logsDir, `main-${todayStamp()}.log`);
  logger.transports.file.level = level;
  logger.transports.file.maxSize = maxSize;
  logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}';

  logger.transports.console.level = process.env.DEEPSKY_LOG_CONSOLE === '1' ? level : false;

  // Pipe renderer-side console.* and unhandled errors through IPC into the
  // file transport. Renderer opts in via `require('electron-log/renderer')`.
  try { logger.initialize?.({ preload: true, spyRendererConsole: true }); } catch {}
  try { logger.errorHandler?.startCatching?.({ showDialog: false }); } catch {}

  initialised = true;
  logger.scope('logger').info(`initialised → ${logger.transports.file.getFile()?.path || logsDir}`);
  return logger;
}

function scoped(area) {
  const logger = ensureLog();
  // electron-log's scope() is safe to call before initLogger — it just won't
  // write to disk yet (fine for unit tests).
  return logger ? logger.scope(area) : NOOP_LOG;
}

function getCurrentLogPath(app) {
  const fromTransport = ensureLog()?.transports?.file?.getFile?.()?.path;
  return fromTransport || path.join(getLogsDir(app), `main-${todayStamp()}.log`);
}

module.exports = {
  initLogger,
  scoped,
  getCurrentLogPath,
  getLogsDirectory: getLogsDir,
  NOOP_LOG,
};
