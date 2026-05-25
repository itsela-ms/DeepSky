const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

class UpdateService {
  constructor(mainWindow, settingsService, deps = {}) {
    this.mainWindow = mainWindow;
    this.settingsService = settingsService;
    this.autoUpdater = deps.autoUpdater || require('electron-updater').autoUpdater;
    this._ipcMain = deps.ipcMain || require('electron').ipcMain;
    this.status = 'idle'; // idle | checking | available | downloading | downloaded | not-available | error
    this.updateInfo = null;
    this.error = null;
    this.progress = null;
    this._checkTimer = null;

    this._applySettings();

    this.autoUpdater.on('checking-for-update', () => {
      this.status = 'checking';
      this._send('update:status', { status: this.status });
    });

    this.autoUpdater.on('update-available', (info) => {
      this.status = 'available';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate, releaseNotes: info.releaseNotes };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    this.autoUpdater.on('update-not-available', (info) => {
      this._handleNotAvailable(info);
    });

    this.autoUpdater.on('download-progress', (progress) => {
      this.status = 'downloading';
      this.progress = { percent: progress.percent, transferred: progress.transferred, total: progress.total };
      this._send('update:status', { status: this.status, progress: this.progress });
    });

    this.autoUpdater.on('update-downloaded', (info) => {
      this.status = 'downloaded';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    this.autoUpdater.on('error', (err) => {
      if (this._isMissingArtifactError(err)) {
        this._handleNotAvailable();
        return;
      }
      this.status = 'error';
      this.error = err?.message || 'Unknown error';
      this._send('update:status', { status: this.status, error: this.error });
    });

    this._registerIpc();
  }

  _isMissingArtifactError(err) {
    if (!err) return false;
    const statusCode = err.statusCode ?? err.status ?? err.code;
    if (statusCode === 404 || statusCode === '404') return true;
    const message = typeof err === 'string' ? err : (err.message || '');
    if (!message) return false;
    return /HttpError:\s*404/i.test(message)
      || /\b404\b[^\d\n]*Not Found/i.test(message)
      || /Cannot find\s+[\w.-]+\.ya?ml/i.test(message);
  }

  _handleNotAvailable(info) {
    this.status = 'not-available';
    const version = info?.version || this._getCurrentVersion();
    this.updateInfo = version ? { version } : null;
    this.error = null;
    this._send('update:status', { status: this.status, info: this.updateInfo });
  }

  _getCurrentVersion() {
    const current = this.autoUpdater?.currentVersion;
    return (current && typeof current === 'object' ? current.version : current) || null;
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
        if (this._isMissingArtifactError(err)) {
          this._handleNotAvailable();
          return { status: this.status, info: this.updateInfo };
        }
        this.status = 'error';
        this.error = err?.message || 'Failed to check for updates';
        this._send('update:status', { status: this.status, error: this.error });
        return { status: 'error', error: this.error };
      }
    });

    this._ipcMain.handle('update:install', () => {
      this.autoUpdater.quitAndInstall(false, true);
    });

    this._ipcMain.handle('update:getStatus', () => {
      return { status: this.status, info: this.updateInfo, progress: this.progress, error: this.error };
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
    this.autoUpdater.autoInstallOnAppQuit = enabled;
    this.autoUpdater.allowPrerelease = isBeta;

    if (!enabled && this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  async checkOnStartup() {
    const settings = this.settingsService.get();
    if (settings.autoUpdateEnabled === false) return;

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

  dispose() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }
}

module.exports = UpdateService;
