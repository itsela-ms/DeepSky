const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STARTUP_INSTALL_DELAY_MS = 500;
const INSTALL_EXIT_WATCHDOG_MS = 10000;

function parseVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

function compareParsedVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }

  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;

  const max = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < max; i += 1) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const diff = comparePrereleaseIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isPendingVersionNewer(pendingVersion, currentVersion) {
  const pending = parseVersion(pendingVersion);
  if (!pending) return false;
  if (!currentVersion) return true;
  const current = parseVersion(currentVersion);
  if (!current) return true;
  return compareParsedVersions(pending, current) > 0;
}

class UpdateService {
  constructor(mainWindow, settingsService, deps = {}) {
    this.mainWindow = mainWindow;
    this.settingsService = settingsService;
    this.autoUpdater = deps.autoUpdater || require('electron-updater').autoUpdater;
    this._ipcMain = deps.ipcMain || require('electron').ipcMain;
    this._fs = deps.fs || require('fs');
    this._path = deps.path || require('path');
    this._app = deps.app || null;
    this.status = 'idle'; // idle | checking | available | downloading | downloaded | pending-install | installing | not-available | error
    this.updateInfo = null;
    this.error = null;
    this.progress = null;
    this.retryable = false;
    this._checkTimer = null;
    this._installTimer = null;
    this._installExitWatchdog = null;
    this._downloadedUpdateReady = false;
    this._installCheckPromise = null;
    this.pendingUpdatePath = deps.pendingUpdatePath || this._resolvePendingUpdatePath();
    this.currentVersion = deps.currentVersion || this._resolveCurrentVersion();

    this._applySettings();
    this._hydratePendingUpdate();

    this.autoUpdater.on('checking-for-update', () => {
      if (this.status === 'installing') {
        this._send('update:status', {
          status: this.status,
          info: this.updateInfo,
          progress: { percent: 5, indeterminate: true },
        });
        return;
      }

      this.retryable = false;
      this.status = 'checking';
      this._send('update:status', { status: this.status });
    });

    this.autoUpdater.on('update-available', (info) => {
      if (this.status === 'installing') {
        this.updateInfo = { version: info.version, releaseDate: info.releaseDate, releaseNotes: info.releaseNotes };
        this._send('update:status', {
          status: this.status,
          info: this.updateInfo,
          progress: { percent: 10, indeterminate: true },
        });
        return;
      }

      this.retryable = false;
      this.status = 'available';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate, releaseNotes: info.releaseNotes };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    this.autoUpdater.on('update-not-available', (info) => {
      if (this.status === 'installing') {
        const versionLabel = this.updateInfo?.version ? `v${this.updateInfo.version}` : 'the pending update';
        this._setInstallError(`${versionLabel} is no longer available.`);
        return;
      }

      this.retryable = false;
      this.status = 'not-available';
      this.updateInfo = { version: info.version };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    this.autoUpdater.on('download-progress', (progress) => {
      if (this.status === 'installing') {
        this.progress = { percent: progress.percent, transferred: progress.transferred, total: progress.total };
        this._send('update:status', { status: this.status, info: this.updateInfo, progress: this.progress });
        return;
      }

      this.retryable = false;
      this.status = 'downloading';
      this.progress = { percent: progress.percent, transferred: progress.transferred, total: progress.total };
      this._send('update:status', { status: this.status, progress: this.progress });
    });

    this.autoUpdater.on('update-downloaded', (info) => {
      const wasInstalling = this.status === 'installing';
      this._downloadedUpdateReady = true;
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate };
      this.progress = null;
      try {
        this._savePendingUpdate(this.updateInfo);
      } catch (err) {
        this._setInstallError(err?.message || 'Failed to save downloaded update state');
        return;
      }

      if (wasInstalling) {
        this.status = 'installing';
        this.progress = { percent: 100, indeterminate: true };
        this._send('update:status', { status: this.status, info: this.updateInfo, progress: this.progress });
        this._scheduleQuitAndInstall();
        return;
      }

      this.retryable = false;
      this.status = 'downloaded';
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    this.autoUpdater.on('error', (err) => {
      const wasInstalling = this.status === 'installing';
      if (this._installTimer) {
        clearTimeout(this._installTimer);
        this._installTimer = null;
      }
      if (this._installExitWatchdog) {
        clearTimeout(this._installExitWatchdog);
        this._installExitWatchdog = null;
      }
      if (wasInstalling) {
        this._clearPendingUpdate();
      }
      this.status = 'error';
      this.retryable = false;
      this.error = err?.message || 'Unknown error';
      this._send('update:status', { status: this.status, error: this.error });
    });

    this._registerIpc();
  }

  _resolveCurrentVersion() {
    if (this._app && typeof this._app.getVersion === 'function') {
      return this._app.getVersion();
    }

    try {
      const { app } = require('electron');
      return typeof app?.getVersion === 'function' ? app.getVersion() : null;
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  _resolvePendingUpdatePath() {
    if (this.settingsService?.configPath) {
      return this._path.join(this._path.dirname(this.settingsService.configPath), 'pending-update.json');
    }

    try {
      const userDataDir = this._app?.getPath?.('userData') || require('electron').app?.getPath?.('userData');
      return userDataDir ? this._path.join(userDataDir, 'pending-update.json') : null;
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  _readPendingUpdate() {
    if (!this.pendingUpdatePath) return null;

    try {
      const parsed = JSON.parse(this._fs.readFileSync(this.pendingUpdatePath, 'utf8'));
      if (!parsed || typeof parsed.version !== 'string' || !parsed.version.trim()) {
        return null;
      }
      return {
        version: parsed.version,
        releaseDate: typeof parsed.releaseDate === 'string' ? parsed.releaseDate : undefined,
        downloadedAt: typeof parsed.downloadedAt === 'string' ? parsed.downloadedAt : undefined,
      };
    } catch {
      return null;
    }
  }

  _savePendingUpdate(info) {
    if (!this.pendingUpdatePath || !info?.version) return;

    const pending = {
      version: info.version,
      releaseDate: info.releaseDate,
      downloadedAt: new Date().toISOString(),
    };
    this._fs.mkdirSync(this._path.dirname(this.pendingUpdatePath), { recursive: true });
    this._fs.writeFileSync(this.pendingUpdatePath, JSON.stringify(pending, null, 2), 'utf8');
  }

  _clearPendingUpdate() {
    if (!this.pendingUpdatePath) return;

    try {
      this._fs.unlinkSync(this.pendingUpdatePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn('Failed to clear pending update marker:', err);
      }
    }
  }

  _hydratePendingUpdate() {
    const pending = this._readPendingUpdate();
    if (!pending) return;

    if (!isPendingVersionNewer(pending.version, this.currentVersion)) {
      this._clearPendingUpdate();
      return;
    }

    this.updateInfo = { version: pending.version, releaseDate: pending.releaseDate };
    this.progress = { percent: 0, indeterminate: true };
    this.status = this.settingsService.get().autoUpdateEnabled === false ? 'downloaded' : 'pending-install';
  }

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  _registerIpc() {
    this._ipcMain.handle('update:check', async () => {
      try {
        return await this.autoUpdater.checkForUpdates();
      } catch (err) {
        this.status = 'error';
        this.retryable = false;
        this.error = err?.message || 'Failed to check for updates';
        this._send('update:status', { status: this.status, error: this.error });
        return { status: 'error', error: this.error };
      }
    });

    this._ipcMain.handle('update:install', () => {
      return this.installUpdate();
    });

    this._ipcMain.handle('update:getStatus', () => {
      const status = { status: this.status, info: this.updateInfo, progress: this.progress, error: this.error };
      if (this.retryable) status.retryable = true;
      return status;
    });

    this._ipcMain.handle('update:applySettings', () => {
      this._applySettings();
    });
  }

  _applySettings() {
    const settings = this.settingsService.get();
    const enabled = settings.autoUpdateEnabled !== false;
    const isBeta = settings.updateChannel === 'beta';

    this.autoUpdater.autoDownload = enabled;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = isBeta;

    if (!enabled && this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  async checkOnStartup() {
    const settings = this.settingsService.get();
    if (settings.autoUpdateEnabled === false) return;
    if (this.status === 'pending-install' || this.status === 'installing') return;

    // Delay startup check by 5 seconds to not block app launch
    setTimeout(async () => {
      try {
        await this.autoUpdater.checkForUpdates();
      } catch {
        // Silent fail on startup — user can check manually
      }
    }, 5000);

    this._startPeriodicCheck();
  }

  _startPeriodicCheck() {
    const settings = this.settingsService.get();
    if (settings.autoUpdateEnabled === false) return;
    if (this.status === 'pending-install' || this.status === 'installing') return;

    if (this._checkTimer) clearInterval(this._checkTimer);
    this._checkTimer = setInterval(async () => {
      if (this.status === 'downloaded' || this.status === 'downloading') return;
      try {
        await this.autoUpdater.checkForUpdates();
      } catch {
        // Silent fail — next interval will retry
      }
    }, CHECK_INTERVAL_MS);
  }

  installUpdate() {
    if (this.status === 'installing') {
      return { status: this.status, info: this.updateInfo, progress: this.progress };
    }

    if (!this.updateInfo?.version) {
      this._setInstallError('No downloaded update is available to install.');
      return { status: this.status, info: this.updateInfo, progress: this.progress, error: this.error };
    }

    this.status = 'installing';
    this.retryable = false;
    this.progress = { percent: 0, indeterminate: true };
    this.error = null;
    this._send('update:status', { status: this.status, info: this.updateInfo, progress: this.progress });

    if (this._downloadedUpdateReady) {
      this._scheduleQuitAndInstall();
    } else {
      this._checkAndDownloadPendingUpdate();
    }

    return { status: this.status, info: this.updateInfo, progress: this.progress };
  }

  _checkAndDownloadPendingUpdate() {
    if (this._installCheckPromise) return;

    const expectedVersion = this.updateInfo?.version;
    this.autoUpdater.autoDownload = true;
    this._installCheckPromise = Promise.resolve()
      .then(() => this.autoUpdater.checkForUpdates())
      .then((result) => {
        if (this.status !== 'installing') return;
        if (result === null) {
          this._setInstallError('Update checks are unavailable for this build.');
          return;
        }
        if (result?.updateInfo?.version) {
          this.updateInfo = {
            version: result.updateInfo.version,
            releaseDate: result.updateInfo.releaseDate,
          };
        }
        if (expectedVersion && result?.updateInfo?.version && result.updateInfo.version !== expectedVersion) {
          this._savePendingUpdate(this.updateInfo);
        }
        if (this._downloadedUpdateReady) return;
        if (result?.downloadPromise) {
          result.downloadPromise.catch((err) => {
            if (this.status === 'installing') {
              this._setInstallError(err?.message || 'Failed to download the update installer.');
            }
          });
          return;
        }
        if (!result?.isUpdateAvailable || !result?.downloadPromise) {
          const versionLabel = expectedVersion ? `v${expectedVersion}` : 'The pending update';
          this._setInstallError(`${versionLabel} is no longer available.`);
        }
      })
      .catch((err) => {
        if (this.status === 'installing') {
          this._setInstallError(err?.message || 'Failed to prepare the update installer.');
        }
      })
      .finally(() => {
        this._installCheckPromise = null;
      });
  }

  _scheduleQuitAndInstall() {
    if (this._installTimer) {
      clearTimeout(this._installTimer);
    }

    this._installTimer = setTimeout(() => {
      this._installTimer = null;
      if (this.status !== 'installing') return;
      try {
        this.autoUpdater.quitAndInstall(false, true);
        this._installExitWatchdog = setTimeout(() => {
          this._installExitWatchdog = null;
          if (this.status === 'installing') {
            this._setInstallError('DeepSky started the update installer, but the app did not exit. Please try Restart now again.', {
              clearPending: false,
              retryable: true,
            });
          }
        }, INSTALL_EXIT_WATCHDOG_MS);
      } catch (err) {
        this._clearPendingUpdate();
        this._applySettings();
        this.status = 'error';
        this.retryable = false;
        this.error = err?.message || 'Failed to install update';
        this._send('update:status', { status: this.status, error: this.error });
      }
    }, STARTUP_INSTALL_DELAY_MS);
  }

  _setInstallError(message, { clearPending = true, retryable = false } = {}) {
    if (this._installTimer) {
      clearTimeout(this._installTimer);
      this._installTimer = null;
    }
    if (this._installExitWatchdog) {
      clearTimeout(this._installExitWatchdog);
      this._installExitWatchdog = null;
    }
    if (clearPending) {
      this._clearPendingUpdate();
    }
    this.status = 'error';
    this.retryable = retryable;
    this.error = message || 'Failed to install update';
    const status = {
      status: this.status,
      info: this.updateInfo,
      progress: this.progress,
      error: this.error,
    };
    if (retryable) status.retryable = true;
    this._send('update:status', status);
  }

  dispose() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    if (this._installTimer) {
      clearTimeout(this._installTimer);
      this._installTimer = null;
    }
    if (this._installExitWatchdog) {
      clearTimeout(this._installExitWatchdog);
      this._installExitWatchdog = null;
    }
    this._installCheckPromise = null;
  }
}

module.exports = UpdateService;
