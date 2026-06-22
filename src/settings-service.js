const fs = require('fs');
const path = require('path');
const { parseLauncherArgs } = require('./app-support');

const DEFAULTS = {
  maxConcurrent: 5,
  sidebarWidth: 280,
  sidebarCollapsed: false,
  sidebarHidden: false,
  lastActiveTab: 'active', // 'active' or 'history'
  theme: 'mocha', // 'mocha' or 'latte'
  copilotPath: '', // auto-detect if empty; override with full path to copilot binary
  openTabs: [], // session IDs of tabs to restore on startup
  activeSessions: [], // session IDs that should be resumed as active on startup
  activeTab: null, // session ID of the last active tab
  tabGroups: [], // Array of { id, name, color, collapsed, tabIds }
  sessionOrder: [], // Manual ordering of active session IDs in sidebar
  statusPanelSections: null, // persisted expand/collapse state for status panel sections
  zoomFactor: 1.0, // 0.75 – 1.5
  promptForWorkdir: false, // show directory picker when creating a new session
  defaultWorkdir: '', // default working directory for new sessions; empty = user home
  useAgencyCopilot: false, // launch new sessions via `agency copilot` instead of the default copilot command
  copilotArgs: '', // extra args passed to the selected launcher for new sessions
  copyOnSelect: true, // automatically copy terminal text to clipboard when selected with the mouse
  autoUpdateEnabled: true, // false = no update checks or downloads
  updateChannel: 'stable', // 'stable' | 'beta'
};

class SettingsService {
  constructor(configDir) {
    this.configPath = path.join(configDir, 'session-gui-settings.json');
    this.settings = { ...DEFAULTS };
  }

  async load() {
    try {
      const data = await fs.promises.readFile(this.configPath, 'utf8');
      const saved = JSON.parse(data);
      this.settings = { ...DEFAULTS, ...saved };
      if (this._normalizeLauncherArgsSettings()) {
        await this.save();
      }
    } catch {
      this.settings = { ...DEFAULTS };
    }
    return this.settings;
  }

  _normalizeLauncherArgsSettings() {
    let changed = false;
    if (typeof this.settings.copilotArgs !== 'string') {
      this.settings.copilotArgs = DEFAULTS.copilotArgs;
      changed = true;
    } else {
      this.settings.copilotArgs = this.settings.copilotArgs.trim();
      try {
        parseLauncherArgs(this.settings.copilotArgs);
      } catch {
        this.settings.copilotArgs = DEFAULTS.copilotArgs;
        changed = true;
      }
    }
    if ('agencyCopilotArgs' in this.settings) {
      delete this.settings.agencyCopilotArgs;
      changed = true;
    }
    return changed;
  }

  async save() {
    try {
      const dir = path.dirname(this.configPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.configPath, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch {}
  }

  get() {
    return { ...this.settings };
  }

  async update(partial) {
    const allowed = Object.keys(DEFAULTS);
    const filtered = {};
    for (const key of allowed) { if (key in partial) filtered[key] = partial[key]; }
    Object.assign(this.settings, filtered);
    await this.save();
    return { ...this.settings };
  }
}

module.exports = SettingsService;
