const { app, BrowserWindow, ipcMain, shell, Menu, dialog, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initLogger, scoped, getCurrentLogPath, getLogsDirectory } = require('./logger');
const SessionService = require('./session-service');
const PtyManager = require('./pty-manager');
const TagIndexer = require('./tag-indexer');
const ResourceIndexer = require('./resource-indexer');
const { parseUrlToResource } = require('./resource-indexer');
const StatusService = require('./status-service');
const SettingsService = require('./settings-service');
const NotificationService = require('./notification-service');
const UpdateService = require('./update-service');
const {
  getSessionDirectoryAvailability,
  resolveGeneratedFilePath,
  resolveSessionDirectory,
  resolveSessionFilesDirectory,
} = require('./session-paths');
const {
  augmentProcessPath,
  calculateNotificationPosition,
  isValidSessionId,
  pickNotificationDisplay,
  resolveAgencyInfo,
  resolveBrochureInfo,
  resolveCopilotInfo,
  resolveCopilotPath,
} = require('./app-support');
const { getNewSessionAvailability } = require('./session-state');

// On macOS/Linux GUI launches, Finder/Dock starts the app with a minimal PATH.
// Augment process.env.PATH so all tool detection (`command -v copilot`,
// `command -v agency`) and child-process spawns can find binaries installed in
// /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, etc.
augmentProcessPath(process.env);

// Initialise file logging as early as possible so we catch the whole startup
// sequence. `app.getPath('userData')` is only valid once the `app` module has
// loaded its core defaults, which has already happened by the time the main
// script runs.
initLogger(app);
const mainLog = scoped('main');
mainLog.info(`startup: deepsky v${app.getVersion()} platform=${process.platform} arch=${process.arch} pid=${process.pid}`);
mainLog.info(`startup: userData=${app.getPath('userData')} home=${os.homedir()} cwd=${process.cwd()}`);
mainLog.info(`startup: PATH=${process.env.PATH}`);

process.on('uncaughtException', (err) => {
  mainLog.error(`uncaughtException: ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  mainLog.error(`unhandledRejection: ${reason?.stack || reason}`);
});

// Prevent Chromium GPU compositing artifacts(rectangular patches of wrong shade on dark backgrounds)
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow;
let updateService;
let lastRestoreTabShortcutAt = 0;

// Active notification popup windows, used for stacking
let activeNotifWindows = [];
// Maps BrowserWindow.id → notification object for click handling
const notifWindowData = new Map();

function showNotificationPopup(notification) {
  const preferredDisplay = pickNotificationDisplay(
    screen.getAllDisplays(),
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null
  ) || screen.getPrimaryDisplay();
  const { workArea } = preferredDisplay;
  const { x, y, width, height } = calculateNotificationPosition(workArea, activeNotifWindows.length);

  const notifWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'notification-popup-preload.js'),
    },
  });

  notifWin.loadFile(path.join(__dirname, 'notification-popup.html'));

  notifWin.webContents.on('did-finish-load', () => {
    const theme = settingsService.get().theme || 'mocha';
    notifWin.webContents.send('notification:show', { ...notification, theme });
    notifWin.showInactive();
  });

  activeNotifWindows.push(notifWin);
  notifWindowData.set(notifWin.id, notification);

  const dismissTimer = setTimeout(() => {
    if (!notifWin.isDestroyed()) notifWin.close();
  }, 6000);

  notifWin.on('closed', () => {
    clearTimeout(dismissTimer);
    activeNotifWindows = activeNotifWindows.filter(w => w !== notifWin);
    notifWindowData.delete(notifWin.id);
  });
}

let sessionService;
let ptyManager;
let tagIndexer;
let resourceIndexer;
let settingsService;
let notificationService;
let statusService;
let ptyFlushTimer = null;
let enhanceStartSessionPromise = null;

const COPILOT_PATH = resolveCopilotPath();
const SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
const COPILOT_CONFIG_DIR = path.join(os.homedir(), '.copilot');
const NOTIFICATIONS_DIR = path.join(COPILOT_CONFIG_DIR, 'notifications');
const INSTRUCTIONS_PATH = path.join(COPILOT_CONFIG_DIR, 'copilot-instructions.md');
const INSTRUCTION_BACKUPS_DIR = path.join(COPILOT_CONFIG_DIR, 'instruction-backups');
const enhanceInstructions = require('./enhance-instructions-service');

function getNewSessionLauncher(settings) {
  return getNewSessionAvailability(getAugmentedSettings(settings)).launcher;
}

function getNewSessionSupport(settings) {
  return getNewSessionAvailability(getAugmentedSettings(settings));
}

function requireValidSessionId(sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID.');
  }
  return sessionId;
}

function getAugmentedSettings(settings) {
  return {
    ...settings,
    agencyAvailable: resolveAgencyInfo().found,
    copilotAvailable: resolveCopilotInfo().found,
  };
}

function dispatchRestoreTabShortcut() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const now = Date.now();
  if (now - lastRestoreTabShortcutAt < 150) {
    return;
  }

  lastRestoreTabShortcutAt = now;
  mainWindow.webContents.send('shortcut:restore-tab');
}

function createWindow() {
  const theme = settingsService.get().theme || 'mocha';
  const bg = theme === 'latte' ? '#eff1f5' : '#1e1e2e';
  const fg = theme === 'latte' ? '#4c4f69' : '#cdd6f4';
  const isMac = process.platform === 'darwin';
  const iconFile = isMac ? 'deepsky.png' : 'deepsky.ico';

  const winOptions = {
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, '..', iconFile),
    backgroundColor: bg,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (isMac) {
    // Native traffic-light buttons inset on the left
    winOptions.titleBarStyle = 'hiddenInset';
    winOptions.trafficLightPosition = { x: 12, y: 10 };
  } else {
    winOptions.titleBarStyle = 'hidden';
    winOptions.titleBarOverlay = { color: bg, symbolColor: fg, height: 36 };
  }

  mainWindow = new BrowserWindow(winOptions);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Restore persisted zoom level
  const zoomFactor = settingsService.get().zoomFactor || 1.0;
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const isRestoreShortcut = (input.control || input.meta) && input.shift && (input.code === 'KeyT' || key === 't');
    if (!isRestoreShortcut || input.type !== 'keyDown') return;
    event.preventDefault();
    dispatchRestoreTabShortcut();
  });

  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  settingsService = new SettingsService(COPILOT_CONFIG_DIR);
  await settingsService.load();
  mainLog.info(`settings loaded: copilotConfigDir=${COPILOT_CONFIG_DIR} sessionStateDir=${SESSION_STATE_DIR}`);

  await fs.promises.mkdir(SESSION_STATE_DIR, { recursive: true });

  const copilotExe = settingsService.get().copilotPath || COPILOT_PATH;
  mainLog.info(`copilot binary resolved to: ${copilotExe} (settingOverride=${!!settingsService.get().copilotPath})`);
  const agencyInfo = resolveAgencyInfo();
  const agencyPath = agencyInfo.found ? agencyInfo.path : null;
  mainLog.info(`agency binary resolved to: ${agencyInfo.path} (found=${agencyInfo.found})`);
  sessionService = new SessionService(SESSION_STATE_DIR, scoped('session-service'));
  ptyManager = new PtyManager(copilotExe, settingsService, undefined, { logger: scoped('pty-manager'), agencyPath });

  tagIndexer = new TagIndexer(SESSION_STATE_DIR);
  await tagIndexer.init();

  resourceIndexer = new ResourceIndexer(SESSION_STATE_DIR);
  await resourceIndexer.init();

  statusService = new StatusService(SESSION_STATE_DIR);

  await sessionService.cleanEmptySessions();

  notificationService = new NotificationService(NOTIFICATIONS_DIR);

  // Forward notifications to renderer + show OS notification
  // Registered before .start() so _scanExisting() events aren't dropped (bug #8)
  notificationService.on('notification', (notification) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notification:new', notification);
    }

    // Show notification popup pinned to primary display
    showNotificationPopup(notification);
  });

  notificationService.start();

  // Custom menu without 'paste' or 'copy' — xterm's custom key handler owns
  // Ctrl+C / Ctrl+V / Cmd+C / Cmd+V.  The default Electron menu fires
  // webContents.copy()/paste() before keydown reaches the renderer, which
  // interferes with xterm's canvas-based selection model.
  const menuTemplate = [];
  menuTemplate.push(
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Restore Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => dispatchRestoreTabShortcut(),
        },
        { type: 'separator' },
        { role: 'selectAll' },
      ]
    },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'reload' }, { role: 'forceReload' }] },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  createWindow();

  updateService = new UpdateService(mainWindow, settingsService);
  mainWindow.webContents.on('did-finish-load', () => {
    updateService.checkOnStartup();
  });

  // IPC: Open/resume a session
  ipcMain.handle('session:open', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    const t0 = Date.now();
    try {
      const [cwd, launcher] = await Promise.all([
        sessionService.getCwd(sessionId),
        sessionService.getLauncher(sessionId),
      ]);
      mainLog.info(`session:open id=${sessionId} cwd=${cwd || '<none>'} launcher=${launcher}`);
      const result = ptyManager.openSession(sessionId, cwd || undefined, launcher);
      mainLog.info(`session:open id=${sessionId} → ok in ${Date.now() - t0}ms`);
      return result;
    } catch (err) {
      mainLog.error(`session:open id=${sessionId} FAILED in ${Date.now() - t0}ms: ${err?.stack || err}`);
      throw err;
    }
  });

  // IPC: Start a new session
  ipcMain.handle('session:new', async (event, cwd) => {
    const t0 = Date.now();
    mainLog.info(`session:new requested cwd=${cwd || '<default>'}`);
    const sessionSupport = getNewSessionSupport(settingsService.get());
    if (!sessionSupport.available) {
      mainLog.warn(`session:new unavailable: ${sessionSupport.reason}`);
      throw new Error(sessionSupport.reason);
    }

    const launcher = sessionSupport.launcher;
    // Try pre-warmed standby for instant startup
    const claimed = ptyManager.claimStandby(cwd || undefined, launcher);
    if (claimed) {
      mainLog.info(`session:new claimed standby id=${claimed.id} launcher=${launcher}`);
      try {
        if (cwd) await sessionService.saveCwd(claimed.id, cwd);
        await sessionService.saveLauncher(claimed.id, launcher);
      } catch (err) {
        mainLog.error(`session:new metadata write failed id=${claimed.id}: ${err?.stack || err}`);
        throw err;
      }
      // Flush buffered startup output to renderer
      if (claimed.bufferedData.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', {
          sessionId: claimed.id,
          data: claimed.bufferedData.join('')
        });
      }
      scheduleWarmUp();
      mainLog.info(`session:new id=${claimed.id} → ok (standby) in ${Date.now() - t0}ms`);
      return claimed.id;
    }

    // Cold start fallback
    try {
      const sessionId = await ptyManager.newSession(cwd || undefined, launcher);
      if (cwd) {
        await sessionService.saveCwd(sessionId, cwd);
      }
      await sessionService.saveLauncher(sessionId, launcher);
      scheduleWarmUp();
      mainLog.info(`session:new id=${sessionId} → ok (cold) in ${Date.now() - t0}ms`);
      return sessionId;
    } catch (err) {
      mainLog.error(`session:new cold-start FAILED in ${Date.now() - t0}ms: ${err?.stack || err}`);
      throw err;
    }
  });

  // IPC: Pick a directory (native OS dialog)
  ipcMain.handle('dialog:pickDirectory', async (event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose working directory',
      defaultPath: defaultPath || os.homedir(),
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // IPC: Change working directory of a session (save + kill + respawn)
  const cwdChangingSessions = new Set();
  ipcMain.handle('session:changeCwd', async (event, sessionId, cwd) => {
    sessionId = requireValidSessionId(sessionId);
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('Invalid working directory.');
    }
    mainLog.info(`session:changeCwd id=${sessionId} newCwd=${cwd}`);
    const previousCwd = await sessionService.getCwd(sessionId);
    const launcher = await sessionService.getLauncher(sessionId);
    await sessionService.saveCwd(sessionId, cwd);
    statusService.invalidateSession(sessionId);
    cwdChangingSessions.add(sessionId);
    try {
      ptyManager.kill(sessionId);
      const result = ptyManager.openSession(sessionId, cwd, launcher);
      mainLog.info(`session:changeCwd id=${sessionId} → ok`);
      return result;
    } catch (error) {
      mainLog.error(`session:changeCwd id=${sessionId} FAILED, attempting rollback to ${previousCwd || '<none>'}: ${error?.message || error}`);
      if (!previousCwd) {
        await sessionService.clearCwd(sessionId);
      } else {
        await sessionService.saveCwd(sessionId, previousCwd);
      }
      statusService.invalidateSession(sessionId);
      try {
        ptyManager.openSession(sessionId, previousCwd, launcher);
      } catch (restoreError) {
        mainLog.error(`session:changeCwd id=${sessionId} rollback FAILED: ${restoreError?.message || restoreError}`);
        error.message = `${error.message} (failed to restore previous session: ${restoreError.message})`;
      }
      throw error;
    } finally {
      cwdChangingSessions.delete(sessionId);
    }
  });

  // IPC: Write to a session's pty
  ipcMain.on('pty:write', (event, { sessionId, data }) => {
    try { ptyManager.write(sessionId, data); } catch {}
  });

  // IPC: Resize a session's pty
  ipcMain.on('pty:resize', (event, { sessionId, cols, rows }) => {
    try { ptyManager.resize(sessionId, cols, rows); } catch {}
  });

  // IPC: Kill a session's pty
  ipcMain.handle('pty:kill', (event, sessionId) => {
    ptyManager.kill(sessionId);
  });

  // IPC: Get settings
  ipcMain.handle('settings:get', async () => {
    return getAugmentedSettings(settingsService.get());
  });

  // IPC: Update settings
  ipcMain.handle('settings:update', async (event, partial) => {
    const sanitized = { ...partial };
    if (sanitized.useAgencyCopilot && !resolveAgencyInfo().found) {
      sanitized.useAgencyCopilot = false;
    }
    const updated = await settingsService.update(sanitized);
    ptyManager.updateSettings(updated);
    if ('useAgencyCopilot' in sanitized || 'defaultWorkdir' in sanitized || 'promptForWorkdir' in sanitized) {
      scheduleWarmUp();
    }

    // Update window chrome for theme changes
    if (sanitized.theme && mainWindow && !mainWindow.isDestroyed()) {
      const bg = sanitized.theme === 'latte' ? '#eff1f5' : '#1e1e2e';
      const fg = sanitized.theme === 'latte' ? '#4c4f69' : '#cdd6f4';
      if (process.platform !== 'darwin' && typeof mainWindow.setTitleBarOverlay === 'function') {
        try { mainWindow.setTitleBarOverlay({ color: bg, symbolColor: fg }); } catch {}
      }
      mainWindow.setBackgroundColor(bg);
    }

    return getAugmentedSettings(updated);
  });

  // IPC: Zoom
  const ZOOM_MIN = 0.75;
  const ZOOM_MAX = 1.5;
  const ZOOM_STEP = 0.05;

  ipcMain.handle('zoom:get', () => mainWindow.webContents.getZoomFactor());

  ipcMain.handle('zoom:set', async (event, direction) => {
    const current = mainWindow.webContents.getZoomFactor();
    let next;
    if (direction === 'in') next = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    else if (direction === 'out') next = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    else if (direction === 'reset') next = 1.0;
    else next = Math.min(Math.max(Number(direction) || 1.0, ZOOM_MIN), ZOOM_MAX);
    next = Math.round(next * 100) / 100;
    mainWindow.webContents.setZoomFactor(next);
    await settingsService.update({ zoomFactor: next });
    return next;
  });

  // IPC: Get active sessions
  ipcMain.handle('pty:active', () => {
    return ptyManager.getActiveSessions();
  });

  // IPC: Read instructions file
  ipcMain.handle('instructions:read', async () => {
    try {
      return await fs.promises.readFile(INSTRUCTIONS_PATH, 'utf8');
    } catch {
      return '';
    }
  });

  // IPC: Write instructions file
  ipcMain.handle('instructions:write', async (event, content) => {
    await fs.promises.writeFile(INSTRUCTIONS_PATH, content, 'utf8');
  });

  // IPC: Enhance instructions — backup-first contract
  // Always snapshot current state BEFORE returning. The renderer must wait
  // for this to succeed before launching the enhancement session.
  ipcMain.handle('enhance:backup', async () => {
    return await enhanceInstructions.createBackup();
  });

  ipcMain.handle('enhance:listBackups', async () => {
    return await enhanceInstructions.listBackups();
  });

  ipcMain.handle('enhance:getBackupHtml', async (_event, timestamp) => {
    return await enhanceInstructions.getBackupHtml(timestamp);
  });

  ipcMain.handle('enhance:rollback', async (_event, timestamp) => {
    return await enhanceInstructions.rollback(timestamp);
  });

  ipcMain.handle('enhance:apply', async (_event, timestamp) => {
    return await enhanceInstructions.applyProposed(timestamp);
  });

  ipcMain.handle('enhance:discard', async (_event, timestamp) => {
    return await enhanceInstructions.discardProposed(timestamp);
  });

  ipcMain.handle('enhance:startSession', async () => {
    // ONE atomic flow:
    //  1. Backup current state (immutable snapshot at instruction-backups/<ts>/)
    //     and create a paired writable proposal folder (instruction-proposals/<ts>/).
    //  2. Write the full multi-kb prompt into the proposal folder.
    //  3. Spawn a NEW Copilot/agency session with `-i "<one-line command>"` baked
    //     into the spawn arguments. The CLI receives the prompt as a process arg —
    //     no PTY-write timing, no escape-sequence assumptions.
    if (enhanceStartSessionPromise) {
      throw new Error('Instructions enhancement is already starting.');
    }

    enhanceStartSessionPromise = (async () => {
      const backup = await enhanceInstructions.createBackup();
      const { promptFilePath } = await enhanceInstructions.writeEnhancePrompt(backup.backupDir, backup.proposalDir);

      const promptFileForwardSlash = promptFilePath.replace(/\\/g, '/');
      const oneLineCommand = `Read the file at ${promptFileForwardSlash} and execute the instructions inside it exactly as written.`;

      const sessionSupport = getNewSessionSupport(settingsService.get());
      if (!sessionSupport.available) {
        throw new Error(sessionSupport.reason);
      }
      const launcher = sessionSupport.launcher;
      const sessionId = await ptyManager.newSession(undefined, launcher, ['-i', oneLineCommand]);
      await sessionService.saveLauncher(sessionId, launcher);
      scheduleWarmUp();

      return { sessionId, backup };
    })();

    try {
      return await enhanceStartSessionPromise;
    } finally {
      enhanceStartSessionPromise = null;
    }
  });

  // IPC: Clipboard (main process owns clipboard — not available in sandboxed preloads)
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_, text) => clipboard.writeText(text));

  // IPC: Open external URL
  ipcMain.handle('shell:openExternal', (event, url) => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
    shell.openExternal(url);
  });

  // IPC: Notifications
  ipcMain.handle('notifications:getAll', () => notificationService.getAll());
  ipcMain.handle('notifications:getUnreadCount', () => notificationService.getUnreadCount());
  ipcMain.handle('notifications:markRead', (event, id) => notificationService.markRead(id));
  ipcMain.handle('notifications:markAllRead', () => notificationService.markAllRead());
  ipcMain.handle('notifications:dismiss', (event, id) => notificationService.dismiss(id));
  ipcMain.handle('notifications:clearAll', () => notificationService.clearAll());

  // IPC: Notification popup interactions
  ipcMain.on('notification-popup:click', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const notification = win ? notifWindowData.get(win.id) : null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      if (notification?.sessionId) {
        mainWindow.webContents.send('notification:click', notification);
      }
    }
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('notification-popup:dismiss', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  // IPC: App info
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getChangelog', () => {
    const candidates = [
      path.join(app.getAppPath(), 'CHANGELOG.md'),
      path.join(__dirname, '..', 'CHANGELOG.md'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf-8');
      } catch {}
    }
    return '';
  });
  ipcMain.handle('app:getBrochureAvailability', () => {
    const brochureInfo = resolveBrochureInfo({
      appPath: app.getAppPath(),
      documentsPath: app.getPath('documents'),
    });
    return { available: brochureInfo.found };
  });
  ipcMain.handle('app:openBrochure', async () => {
    const brochureInfo = resolveBrochureInfo({
      appPath: app.getAppPath(),
      documentsPath: app.getPath('documents'),
    });
    if (!brochureInfo.found || !brochureInfo.path) {
      return { ok: false, error: 'DeepSky brochure was not found on this machine.' };
    }

    const error = await shell.openPath(brochureInfo.path);
    return error ? { ok: false, error } : { ok: true };
  });

  // IPC: Logs — reveal directory and accept renderer-side log lines
  ipcMain.handle('logs:reveal', async () => {
    const logsDir = getLogsDirectory(app);
    try {
      await fs.promises.mkdir(logsDir, { recursive: true });
      const currentFile = getCurrentLogPath(app);
      // Show the file selected in Finder/Explorer when it exists; otherwise
      // fall back to opening the directory.
      if (fs.existsSync(currentFile)) {
        shell.showItemInFolder(currentFile);
      } else {
        await shell.openPath(logsDir);
      }
      return { ok: true, dir: logsDir, file: currentFile };
    } catch (err) {
      mainLog.error(`logs:reveal failed: ${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  const rendererLog = scoped('renderer');
  ipcMain.handle('logs:write', (event, level, message) => {
    const fn = rendererLog[level] || rendererLog.info;
    fn.call(rendererLog, String(message));
  });

  ipcMain.handle('logs:getPath', () => {
    try {
      return { dir: getLogsDirectory(app), file: getCurrentLogPath(app) };
    } catch (err) {
      mainLog.error(`logs:getPath failed: ${err?.message || err}`);
      return { dir: '', file: '' };
    }
  });

  // Auto-notify on session exit
  ptyManager.on('exit', (sessionId, exitCode) => {
    // Suppress exit handling during cwd change (session will be respawned)
    if (cwdChangingSessions.has(sessionId)) return;

    // Flush any remaining buffered data before signalling exit
    if (ptyDataBuffers.has(sessionId) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { sessionId, data: ptyDataBuffers.get(sessionId).join('') });
      ptyDataBuffers.delete(sessionId);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { sessionId, exitCode });
    }
    // Push a notification for session exit
    const session = allSessionsCache.find(s => s.id === sessionId);
    const title = session?.title || sessionId.substring(0, 8);
    notificationService.push({
      type: exitCode === 0 ? 'task-done' : 'error',
      title: exitCode === 0 ? `Session ended: ${title}` : `Session error: ${title}`,
      body: `Exited with code ${exitCode}`,
      sessionId,
    });
  });

  ptyManager.on('evicted', (sessionId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:evicted', sessionId);
    }
  });

  let allSessionsCache = [];
  const mergeSessionsCache = (sessions) => {
    const merged = new Map(allSessionsCache.map(session => [session.id, session]));
    sessions.forEach(session => merged.set(session.id, session));
    allSessionsCache = [...merged.values()];
  };
  const normalizeSessionListScope = (options = {}) => {
    const scope = String(options?.scope || '').trim().toLowerCase();
    if (scope === 'history') return 'history';
    if (scope === 'all') return 'all';
    return 'active';
  };
  const sessionMatchesSidebarSearch = (session, query) => {
    if (session.title?.toLowerCase().includes(query)) return true;
    if (session.cwd?.toLowerCase().includes(query)) return true;
    if (session.tags?.some(tag => tag.toLowerCase().includes(query))) return true;
    if (session.resources?.some(resource =>
      String(resource.id || '').toLowerCase().includes(query) ||
      String(resource.url || '').toLowerCase().includes(query) ||
      String(resource.name || '').toLowerCase().includes(query) ||
      String(resource.repo || '').toLowerCase().includes(query)
    )) {
      return true;
    }
    return false;
  };

  const hydrateSessionsCache = async (options = {}) => {
    const scope = normalizeSessionListScope(options);
    const sessions = await sessionService.listSessions(
      scope === 'history' ? { scope: 'history' } : scope === 'all' ? { scope: 'all' } : undefined
    );
    const hydratedSessions = sessions.map(s => ({
      ...s,
      tags: tagIndexer.getTagsForSession(s.id),
      resources: resourceIndexer.getResourcesForSession(s.id)
    }));

    if (scope === 'history') {
      mergeSessionsCache(hydratedSessions);
      return hydratedSessions;
    }

    allSessionsCache = hydratedSessions;
    return hydratedSessions;
  };

  // IPC: Get session list (with tags and resources) — also caches for notification titles
  ipcMain.handle('sessions:list', hydrateSessionsCache);

  ipcMain.handle('sessions:search', async (event, query) => {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const [sessions, contentMatches] = await Promise.all([
      hydrateSessionsCache(),
      sessionService.searchSessions(needle)
    ]);
    const contentMatchIds = new Set(contentMatches.map(match => match.id));

    return sessions
      .filter(session => contentMatchIds.has(session.id) || sessionMatchesSidebarSearch(session, needle));
  });

  ipcMain.handle('session:getLastUserPrompt', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    return sessionService.getLastUserPrompt(sessionId);
  });

  ipcMain.handle('session:rename', async (event, sessionId, title) => {
    sessionId = requireValidSessionId(sessionId);
    await sessionService.renameSession(sessionId, title);
  });

  ipcMain.handle('session:updateCwdMetadata', async (event, sessionId, cwd) => {
    sessionId = requireValidSessionId(sessionId);
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('Invalid working directory.');
    }
    await sessionService.saveCwd(sessionId, cwd);
    statusService.invalidateSession(sessionId);
  });

  ipcMain.handle('session:delete', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    mainLog.info(`session:delete id=${sessionId}`);
    ptyManager.kill(sessionId);
    statusService.invalidateSession(sessionId);
    try {
      await sessionService.deleteSession(sessionId);
    } catch (err) {
      mainLog.error(`session:delete id=${sessionId} FAILED: ${err?.stack || err}`);
      throw err;
    }
  });

  ipcMain.handle('resource:add', async (event, sessionId, url) => {
    const resource = parseUrlToResource(url);
    return resourceIndexer.addManualResource(sessionId, resource);
  });

  ipcMain.handle('resource:remove', async (event, sessionId, key) => {
    await resourceIndexer.removeResource(sessionId, key);
  });

  // IPC: Get session status (intent, summary, plan, timeline, files)
  ipcMain.handle('session:getStatus', async (event, sessionId) => {
    sessionId = requireValidSessionId(sessionId);
    return statusService.getSessionStatus(sessionId);
  });

  ipcMain.handle('session:getDirectoryAvailability', async (event, sessionId) => (
    getSessionDirectoryAvailability(SESSION_STATE_DIR, sessionId)
  ));

  // Shared helper for the three "reveal a session-owned path in Finder/Explorer"
  // IPC handlers below. `label` is the IPC channel name (used for log prefix
  // and the default error message), `getter` produces the absolute path.
  async function revealPath(label, sessionId, extraTag, getter, missingMsg) {
    const tag = extraTag ? ` ${extraTag}` : '';

    try {
      const target = await getter();
      mainLog.info(`${label} id=${sessionId}${tag} dir=${target}`);
      const error = await shell.openPath(target);
      if (error) mainLog.warn(`${label} id=${sessionId}${tag} shell.openPath error=${error}`);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      mainLog.error(`${label} id=${sessionId}${tag} FAILED: ${error?.message || error}`);
      return { ok: false, error: error.message || missingMsg };
    }
  }

  ipcMain.handle('session:openDirectory', (_event, sessionId) =>
    revealPath('session:openDirectory', sessionId, '',
      () => resolveSessionDirectory(SESSION_STATE_DIR, sessionId),
      'Session directory no longer exists.'));

  ipcMain.handle('session:openFilesDirectory', (_event, sessionId) =>
    revealPath('session:openFilesDirectory', sessionId, '',
      () => resolveSessionFilesDirectory(SESSION_STATE_DIR, sessionId),
      'Session files directory no longer exists.'));

  ipcMain.handle('session:openGeneratedFile', (_event, sessionId, relativePath) =>
    revealPath('session:openGeneratedFile', sessionId, `rel=${relativePath}`,
      () => resolveGeneratedFilePath(SESSION_STATE_DIR, sessionId, relativePath),
      'Generated file no longer exists.'));

  // Forward pty output to renderer — batch at 16ms intervals to prevent IPC flooding
  const ptyDataBuffers = new Map(); // sessionId -> string[]

  function flushPtyData() {
    ptyFlushTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      ptyDataBuffers.clear();
      return;
    }
    for (const [sessionId, chunks] of ptyDataBuffers) {
      mainWindow.webContents.send('pty:data', { sessionId, data: chunks.join('') });
    }
    ptyDataBuffers.clear();
  }

  ptyManager.on('data', (sessionId, data) => {
    if (!ptyDataBuffers.has(sessionId)) ptyDataBuffers.set(sessionId, []);
    ptyDataBuffers.get(sessionId).push(data);
    if (!ptyFlushTimer) {
      ptyFlushTimer = setTimeout(flushPtyData, 16);
    }
  });

  // Pre-warm a standby session for instant new-session creation
  let warmUpTimer = null;
  function scheduleWarmUp() {
    if (warmUpTimer) {
      clearTimeout(warmUpTimer);
    }
    warmUpTimer = setTimeout(() => {
      warmUpTimer = null;
      const settings = settingsService.get();
      if (settings.promptForWorkdir) return;
      const sessionSupport = getNewSessionSupport(settings);
      if (!sessionSupport.available) return;
      const cwd = settings.defaultWorkdir || undefined;
      ptyManager.warmUp(cwd, sessionSupport.launcher);
    }, 3000);
  }
  scheduleWarmUp();
  });

  app.on('window-all-closed', () => {
  tagIndexer.stop();
  resourceIndexer.stop();
  notificationService.stop();
  if (ptyFlushTimer) { clearTimeout(ptyFlushTimer); ptyFlushTimer = null; }
  ptyManager.killAll();
  app.quit();
  });
}
