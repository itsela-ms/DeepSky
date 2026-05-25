const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

const os = require('os');
const { isValidSessionId } = require('./app-support');

// Default to node-pty, but allow injection for testing
let defaultPty;
try { defaultPty = require('node-pty'); } catch { defaultPty = null; }

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
// The Copilot CLI normally creates its session-state folder within ~1–3s on a
// healthy machine. Under load (other Electron apps running, slow disk,
// antivirus scanning the spawn) cold-start can comfortably exceed 10s and
// users would see "Failed to discover session ID after CLI spawn: Timed out".
// 30s gives the CLI plenty of room without hanging the UI forever when the
// spawn truly fails.
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;
const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 100;

class PtyManager extends EventEmitter {
  constructor(copilotPath, settingsService, ptyModule, options = {}) {
    super();
    this.copilotPath = copilotPath;
    this.sessions = new Map();
    this.settingsService = settingsService;
    this._pty = ptyModule || defaultPty;

    // On Windows, .cmd files must be spawned via cmd.exe
    this._useCmd = process.platform === 'win32' &&
      copilotPath.toLowerCase().endsWith('.cmd');
    this._standby = null;

    // Pre-CLI-1.0.49, passing `--resume <fresh-uuid>` made the CLI silently
    // create a brand-new session at that exact UUID, which DeepSky relied on
    // so it could track the session by its self-generated ID. CLI 1.0.49+
    // rejects unknown IDs ("Error: No session, task, or name matched ...") so
    // DeepSky now spawns new sessions WITHOUT `--resume` and discovers the
    // CLI-assigned session ID by diffing this directory. The discovery is
    // injectable for tests.
    this._sessionStateDir = options.sessionStateDir || DEFAULT_SESSION_STATE_DIR;
    this._discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this._sessionIdDiscoverer = options.sessionIdDiscoverer
      || ((before, pty) => this._defaultDiscoverer(before, pty));

    // Serialize concurrent spawn+discover sequences so two parallel
    // newSession/warmUp calls can't race on the folder-diff snapshot.
    this._spawnLock = Promise.resolve();
  }

  _resolveLauncher(launcher) {
    if (launcher === 'agency' || launcher === 'copilot') return launcher;
    return this.settingsService?.get().useAgencyCopilot ? 'agency' : 'copilot';
  }

  _spawnArgs(extraArgs, launcher) {
    const resolvedLauncher = this._resolveLauncher(launcher);
    if (resolvedLauncher === 'agency') {
      if (process.platform === 'win32') {
        return { file: 'cmd.exe', args: ['/c', 'agency', 'copilot', ...extraArgs], launcher: resolvedLauncher };
      }
      return { file: 'agency', args: ['copilot', ...extraArgs], launcher: resolvedLauncher };
    }
    if (this._useCmd) {
      return { file: 'cmd.exe', args: ['/c', this.copilotPath, ...extraArgs], launcher: resolvedLauncher };
    }
    return { file: this.copilotPath, args: extraArgs, launcher: resolvedLauncher };
  }

  get maxConcurrent() {
    return this.settingsService?.get().maxConcurrent || 5;
  }

  // Serialize spawn+discover sequences so concurrent newSession/warmUp
  // calls don't race on the folder-snapshot diff used for ID discovery.
  async _serializeSpawn(fn) {
    const prev = this._spawnLock;
    let resolveOurs;
    this._spawnLock = new Promise(r => { resolveOurs = r; });
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      resolveOurs();
    }
  }

  async _snapshotSessionFolders() {
    try {
      const entries = await fs.promises.readdir(this._sessionStateDir, { withFileTypes: true });
      return new Set(entries.filter(e => e.isDirectory()).map(e => e.name).filter(isValidSessionId));
    } catch {
      // Directory might not exist yet; treat as empty snapshot
      return new Set();
    }
  }

  // Default discoverer: poll session-state dir until a folder not present in
  // `beforeSnapshot` shows up. Folder appears within ~3s in practice; we wait
  // up to `_discoveryTimeoutMs` (10s default) before giving up.
  async _defaultDiscoverer(beforeSnapshot /* , ptyProcess */) {
    const start = Date.now();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    while (Date.now() - start < this._discoveryTimeoutMs) {
      let entries;
      try {
        entries = await fs.promises.readdir(this._sessionStateDir, { withFileTypes: true });
      } catch {
        await sleep(DEFAULT_DISCOVERY_POLL_INTERVAL_MS);
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && isValidSessionId(e.name) && !beforeSnapshot.has(e.name)) {
          return e.name;
        }
      }
      await sleep(DEFAULT_DISCOVERY_POLL_INTERVAL_MS);
    }
    throw new Error('Timed out waiting for CLI session-state folder to appear');
  }

  openSession(sessionId, cwd, launcher) {
    // If already alive, just return the id
    if (this.sessions.has(sessionId) && this.sessions.get(sessionId).alive) {
      return sessionId;
    }

    // Bug #26: clean up dead entry before respawning
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
    }

    // Evict oldest if at max capacity
    this._evictIfNeeded();

    const spawnCwd = cwd || os.homedir();
    let ptyProcess;
    try {
      const spawnConfig = this._spawnArgs(['--resume', sessionId, '--yolo'], launcher);
      launcher = spawnConfig.launcher;
      const { file, args } = spawnConfig;
      ptyProcess = this._pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spawnCwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (err) {
      // If spawn fails with given cwd, retry with homedir
      if (cwd && cwd !== os.homedir()) {
        try {
          const spawnConfig = this._spawnArgs(['--resume', sessionId, '--yolo'], launcher);
          launcher = spawnConfig.launcher;
          const { file, args } = spawnConfig;
          ptyProcess = this._pty.spawn(file, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: os.homedir(),
            env: { ...process.env, TERM: 'xterm-256color' }
          });
        } catch (err2) {
          throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err2.message}`);
        }
      } else {
        throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err.message}`);
      }
    }

    // Capture entry reference directly so exit/data handlers don't
    // accidentally operate on a NEW entry after kill+respawn
    const sessionEntry = {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: null,
      dataBytesSinceIdle: 0,
      cwd: spawnCwd,
      launcher: this._resolveLauncher(launcher)
    };

    ptyProcess.onData((data) => {
      if (sessionEntry.alive) {
        const now = Date.now();
        // Reset burst counter after 5s of silence (new burst = new activity)
        if (sessionEntry.lastDataAt && (now - sessionEntry.lastDataAt) > 5000) {
          sessionEntry.dataBytesSinceIdle = 0;
        }
        sessionEntry.lastDataAt = now;
        sessionEntry.dataBytesSinceIdle += data.length;
        this.emit('data', sessionId, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (sessionEntry.alive) {
        sessionEntry.alive = false;
        this.emit('exit', sessionId, exitCode);
        // Only remove from map if this is still the current entry
        if (this.sessions.get(sessionId) === sessionEntry) {
          this.sessions.delete(sessionId);
        }
      }
    });

    this.sessions.set(sessionId, sessionEntry);
    return sessionId;
  }

  newSession(cwd, launcher, extraArgs = []) {
    return this._serializeSpawn(() => this._newSessionImpl(cwd, launcher, extraArgs));
  }

  async _newSessionImpl(cwd, launcher, extraArgs = []) {
    this._evictIfNeeded();

    const spawnCwd = cwd || os.homedir();
    // Snapshot BEFORE spawn so the post-spawn diff reveals the folder the CLI
    // creates for this new session. We avoid passing --resume/--name because
    // CLI 1.0.49+ rejects unknown IDs.
    const beforeSnapshot = await this._snapshotSessionFolders();
    const buildArgs = ['--yolo', ...extraArgs];
    let ptyProcess;
    let resolvedLauncher;
    try {
      const spawnConfig = this._spawnArgs(buildArgs, launcher);
      resolvedLauncher = spawnConfig.launcher;
      const { file, args } = spawnConfig;
      ptyProcess = this._pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spawnCwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (err) {
      if (cwd && cwd !== os.homedir()) {
        try {
          const spawnConfig = this._spawnArgs(buildArgs, launcher);
          resolvedLauncher = spawnConfig.launcher;
          const { file, args } = spawnConfig;
          ptyProcess = this._pty.spawn(file, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: os.homedir(),
            env: { ...process.env, TERM: 'xterm-256color' }
          });
        } catch (err2) {
          throw new Error(`Failed to spawn PTY: ${err2.message}`);
        }
      } else {
        throw new Error(`Failed to spawn PTY: ${err.message}`);
      }
    }

    let sessionId;
    try {
      sessionId = await this._sessionIdDiscoverer(beforeSnapshot, ptyProcess);
    } catch (err) {
      try { ptyProcess.kill(); } catch {}
      throw new Error(`Failed to discover session ID after CLI spawn: ${err.message}`);
    }

    const sessionEntry = {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: null,
      dataBytesSinceIdle: 0,
      cwd: spawnCwd,
      launcher: resolvedLauncher
    };

    ptyProcess.onData((data) => {
      if (sessionEntry.alive) {
        const now = Date.now();
        if (sessionEntry.lastDataAt && (now - sessionEntry.lastDataAt) > 5000) {
          sessionEntry.dataBytesSinceIdle = 0;
        }
        sessionEntry.lastDataAt = now;
        sessionEntry.dataBytesSinceIdle += data.length;
        this.emit('data', sessionId, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (sessionEntry.alive) {
        sessionEntry.alive = false;
        this.emit('exit', sessionId, exitCode);
        if (this.sessions.get(sessionId) === sessionEntry) {
          this.sessions.delete(sessionId);
        }
      }
    });

    this.sessions.set(sessionId, sessionEntry);
    return sessionId;
  }

  write(sessionId, data) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.alive) {
      entry.pty.write(data);
    }
  }

  resize(sessionId, cols, rows) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.alive) {
      entry.pty.resize(cols, rows);
    }
  }

  kill(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.alive) {
      entry.pty.kill();
      entry.alive = false;
    }
    this.sessions.delete(sessionId);
  }

  warmUp(cwd, launcher) {
    return this._serializeSpawn(() => this._warmUpImpl(cwd, launcher));
  }

  async _warmUpImpl(cwd, launcher) {
    if (this._standby && this._standby.alive) return;
    this._standby = null;

    // Don't warm if at capacity
    const aliveCount = [...this.sessions.values()].filter(e => e.alive).length;
    if (aliveCount >= this.maxConcurrent) return;

    const spawnCwd = cwd || os.homedir();
    const beforeSnapshot = await this._snapshotSessionFolders();
    let ptyProcess;
    let spawnConfig;
    try {
      spawnConfig = this._spawnArgs(['--yolo'], launcher);
      const { file, args } = spawnConfig;
      ptyProcess = this._pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: spawnCwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch {
      // Pre-warm failed — cold start will still work
      return;
    }

    let sessionId;
    try {
      sessionId = await this._sessionIdDiscoverer(beforeSnapshot, ptyProcess);
    } catch {
      // Couldn't determine the CLI's session ID; abandon the standby so a
      // cold newSession() does the work instead.
      try { ptyProcess.kill(); } catch {}
      return;
    }

    const entry = {
      id: sessionId,
      pty: ptyProcess,
      cwd: spawnCwd,
      launcher: spawnConfig.launcher,
      bufferedData: [],
      alive: true,
      claimed: false
    };

    ptyProcess.onData((data) => {
      if (!entry.claimed && entry.alive) {
        entry.bufferedData.push(data);
      }
    });

    ptyProcess.onExit(() => {
      if (!entry.claimed) {
        entry.alive = false;
        if (this._standby === entry) this._standby = null;
      }
    });

    this._standby = entry;
  }

  claimStandby(cwd, launcher) {
    const standby = this._standby;
    if (!standby || !standby.alive) return null;

    const spawnCwd = cwd || os.homedir();
    const resolvedLauncher = this._resolveLauncher(launcher);
    if (standby.cwd !== spawnCwd || standby.launcher !== resolvedLauncher) {
      // CWD mismatch — discard standby
      try { standby.pty.kill(); } catch {}
      standby.alive = false;
      this._standby = null;
      return null;
    }

    standby.claimed = true;
    this._standby = null;

    this._evictIfNeeded();

    const sessionEntry = {
      pty: standby.pty,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: standby.bufferedData.length > 0 ? Date.now() : null,
      dataBytesSinceIdle: 0,
      cwd: standby.cwd,
      launcher: standby.launcher
    };

    standby.pty.onData((data) => {
      if (sessionEntry.alive) {
        const now = Date.now();
        if (sessionEntry.lastDataAt && (now - sessionEntry.lastDataAt) > 5000) {
          sessionEntry.dataBytesSinceIdle = 0;
        }
        sessionEntry.lastDataAt = now;
        sessionEntry.dataBytesSinceIdle += data.length;
        this.emit('data', standby.id, data);
      }
    });

    standby.pty.onExit(({ exitCode }) => {
      if (sessionEntry.alive) {
        sessionEntry.alive = false;
        this.emit('exit', standby.id, exitCode);
        if (this.sessions.get(standby.id) === sessionEntry) {
          this.sessions.delete(standby.id);
        }
      }
    });

    this.sessions.set(standby.id, sessionEntry);
    return { id: standby.id, bufferedData: standby.bufferedData };
  }

  killAll() {
    if (this._standby && this._standby.alive) {
      try { this._standby.pty.kill(); } catch {}
      this._standby.alive = false;
      this._standby = null;
    }
    for (const [id, entry] of this.sessions) {
      if (entry.alive) {
        try { entry.pty.kill(); } catch {}
      }
    }
    this.sessions.clear();
  }

  getActiveSessions() {
    const result = [];
    for (const [id, entry] of this.sessions) {
      if (entry.alive) {
        result.push({ id, openedAt: entry.openedAt, lastDataAt: entry.lastDataAt || 0 });
      }
    }
    return result;
  }

  /**
   * Returns sessions that are actively producing significant output.
   * A session is "busy" only if it received output within `thresholdMs` AND
   * the current output burst has substantial volume (>500 bytes), which
   * distinguishes AI-generated content from a prompt/cursor redraw.
   */
  getBusySessions(thresholdMs = 5000) {
    const now = Date.now();
    const MIN_BUSY_BYTES = 500;
    const result = [];
    for (const [id, entry] of this.sessions) {
      if (entry.alive && entry.lastDataAt &&
          (now - entry.lastDataAt) < thresholdMs &&
          entry.dataBytesSinceIdle >= MIN_BUSY_BYTES) {
        result.push(id);
      }
    }
    return result;
  }

  /**
   * Kill sessions that haven't produced output within `thresholdMs`.
   * Returns the IDs of sessions that were killed.
   */
  killIdle(thresholdMs = 5000) {
    const now = Date.now();
    const killed = [];
    for (const [id, entry] of this.sessions) {
      if (entry.alive && (!entry.lastDataAt || (now - entry.lastDataAt) >= thresholdMs)) {
        try { entry.pty.kill(); } catch {}
        entry.alive = false;
        this.sessions.delete(id);
        killed.push(id);
      }
    }
    return killed;
  }

  updateSettings(settings) {
    const standby = this._standby;
    if (!standby || !standby.alive) return;

    if (settings?.promptForWorkdir) {
      try { standby.pty.kill(); } catch {}
      standby.alive = false;
      this._standby = null;
      return;
    }

    const expectedLauncher = this._resolveLauncher(settings?.useAgencyCopilot ? 'agency' : 'copilot');
    const expectedCwd = settings?.defaultWorkdir || os.homedir();
    if (standby.launcher !== expectedLauncher || standby.cwd !== expectedCwd) {
      try { standby.pty.kill(); } catch {}
      standby.alive = false;
      this._standby = null;
    }
  }

  _evictIfNeeded() {
    let alive = [...this.sessions.entries()].filter(([, e]) => e.alive);
    alive.sort((a, b) => a[1].openedAt - b[1].openedAt);
    let i = 0;
    while (alive.length - i >= this.maxConcurrent) {
      const [oldestId, oldestEntry] = alive[i];
      oldestEntry.alive = false;
      this.emit('evicted', oldestId);
      try { oldestEntry.pty.kill(); } catch {}
      this.sessions.delete(oldestId);
      i++;
    }
  }
}

module.exports = PtyManager;
