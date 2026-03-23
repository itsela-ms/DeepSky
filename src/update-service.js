const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

class UpdateService {
  constructor(mainWindow, settingsService) {
    this.mainWindow = mainWindow;
    this.settingsService = settingsService;
    this.status = 'idle'; // idle | checking | available | downloading | downloaded | not-available | error
    this.updateInfo = null;
    this.error = null;
    this.progress = null;
    this._checkTimer = null;

    // Read settings to configure
    const settings = settingsService.get();
    autoUpdater.allowPrerelease = (settings.updateChannel === 'beta');
    autoUpdater.autoDownload = settings.autoUpdateEnabled;
    autoUpdater.autoInstallOnAppQuit = settings.autoUpdateEnabled;

    autoUpdater.on('checking-for-update', () => {
      this.status = 'checking';
      this._send('update:status', { status: this.status });
    });

    autoUpdater.on('update-available', (info) => {
      this.status = 'available';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate, releaseNotes: info.releaseNotes };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    autoUpdater.on('update-not-available', (info) => {
      this.status = 'not-available';
      this.updateInfo = { version: info.version };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.status = 'downloading';
      this.progress = { percent: progress.percent, transferred: progress.transferred, total: progress.total };
      this._send('update:status', { status: this.status, progress: this.progress });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.status = 'downloaded';
      this.updateInfo = { version: info.version, releaseDate: info.releaseDate };
      this._send('update:status', { status: this.status, info: this.updateInfo });
    });

    autoUpdater.on('error', (err) => {
      this.status = 'error';
      this.error = err?.message || 'Unknown error';
      this._send('update:status', { status: this.status, error: this.error });
    });

    this._registerIpc();
  }

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  _registerIpc() {
    ipcMain.handle('update:check', async () => {
      try {
        return await autoUpdater.checkForUpdates();
      } catch (err) {
        this.status = 'error';
        this.error = err?.message || 'Failed to check for updates';
        this._send('update:status', { status: this.status, error: this.error });
        return { status: 'error', error: this.error };
      }
    });

    ipcMain.handle('update:install', () => {
      autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('update:getStatus', () => {
      return { status: this.status, info: this.updateInfo, progress: this.progress, error: this.error };
    });

    ipcMain.handle('update:applySettings', () => {
      this.applySettings();
    });
  }

  async checkOnStartup() {
    const settings = this.settingsService.get();
    if (!settings.autoUpdateEnabled) return; // respect opt-out

    // Delay startup check by 5 seconds to not block app launch
    setTimeout(async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch {
        // Silent fail on startup — user can check manually
      }
    }, 5000);

    this._startPeriodicCheck();
  }

  _startPeriodicCheck() {
    if (this._checkTimer) clearInterval(this._checkTimer);
    this._checkTimer = setInterval(async () => {
      const settings = this.settingsService.get();
      if (!settings.autoUpdateEnabled) return;
      if (this.status === 'downloaded' || this.status === 'downloading') return;
      try {
        await autoUpdater.checkForUpdates();
      } catch {
        // Silent fail — next interval will retry
      }
    }, CHECK_INTERVAL_MS);
  }

  applySettings() {
    const settings = this.settingsService.get();
    autoUpdater.allowPrerelease = (settings.updateChannel === 'beta');
    autoUpdater.autoDownload = settings.autoUpdateEnabled;
    autoUpdater.autoInstallOnAppQuit = settings.autoUpdateEnabled;

    if (!settings.autoUpdateEnabled) {
      this.dispose(); // stop timer
      this.status = 'idle';
      this._send('update:status', { status: 'idle' });
    } else if (!this._checkTimer) {
      this._startPeriodicCheck();
    }
  }

  dispose() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }
}

module.exports = UpdateService;
