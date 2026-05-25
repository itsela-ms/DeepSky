const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { buildAugmentedPath, isValidSessionId } = require('./app-support');
const { NOOP_LOG } = require('./logger');

// Default to node-pty, but allow injection for testing
let defaultPty;
try { defaultPty = require('node-pty'); } catch { defaultPty = null; }

const PTY_DEFAULTS = { name: 'xterm-256color', cols: 120, rows: 40 };
const EARLY_EXIT_MS = 3000;            // exits faster than this get a `warn` with output snippet
const EARLY_OUTPUT_CAP = 16 * 1024;    // bytes buffered for the early-exit diagnostic
const IDLE_RESET_MS = 5000;            // burst counter reset after this much silence
const SNIPPET_MAX_LEN = 1500;          // hard cap on sanitized snippet length in log line

// Folder that the Copilot CLI creates per session. CLI 1.0.49+ rejects
// `--resume <unknown-uuid>`, so for newSession/warmUp we let the CLI assign
// the id and discover it by diffing this directory.
const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10000;
const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 100;

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// On macOS/Linux GUI launches (Finder/Dock), PATH is minimal and excludes
// common bin directories like /opt/homebrew/bin. Augment it so that
// `copilot` and its child processes (git, node, etc.) resolve correctly.
function buildSpawnEnv(baseEnv) {
  const env = { ...baseEnv, TERM: 'xterm-256color' };
  if (process.platform === 'win32') return env;
  env.PATH = buildAugmentedPath(env.PATH || '');
  return env;
}

// Strip ANSI escape sequences and clamp length so an early-exit PTY snippet
// is readable in the log file (otherwise it's an unreadable mess of \x1b[...).
function sanitizeForLog(s) {
  if (!s) return '';
  let out = String(s)
    .replace(ANSI_RE, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')   // strip control chars (keep \n, \t)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > SNIPPET_MAX_LEN) out = out.slice(0, SNIPPET_MAX_LEN) + '…(truncated)';
  return out;
}

class PtyManager extends EventEmitter {
  // options: { logger, agencyPath, sessionStateDir, discoveryTimeoutMs, sessionIdDiscoverer }
  constructor(copilotPath, settingsService, ptyModule, options = {}) {
    super();
    this.copilotPath = copilotPath;
    // Absolute path to the `agency` binary (resolved via app-support.resolveAgencyInfo)
    // when provided; otherwise fall back to bare 'agency' and rely on PATH lookup.
    this.agencyPath = options.agencyPath || 'agency';
    this.sessions = new Map();
    this.settingsService = settingsService;
    this._pty = ptyModule || defaultPty;
    this.log = options.logger || NOOP_LOG;
    // On Windows, .cmd files must be spawned via cmd.exe
    this._useCmd = process.platform === 'win32' && copilotPath.toLowerCase().endsWith('.cmd');
    this._standby = null;

    if (!this._pty) {
      this.log.error('node-pty module failed to load — PTY operations will throw.');
    } else {
      this.log.info(`pty-manager ready: copilotPath=${copilotPath} agencyPath=${this.agencyPath} useCmd=${this._useCmd}`);
    }

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
        return { file: 'cmd.exe', args: ['/c', this.agencyPath, 'copilot', ...extraArgs], launcher: resolvedLauncher };
      }
      return { file: this.agencyPath, args: ['copilot', ...extraArgs], launcher: resolvedLauncher };
    }
    if (this._useCmd) {
      return { file: 'cmd.exe', args: ['/c', this.copilotPath, ...extraArgs], launcher: resolvedLauncher };
    }
    return { file: this.copilotPath, args: extraArgs, launcher: resolvedLauncher };
  }

  get maxConcurrent() {
    return this.settingsService?.get().maxConcurrent || 5;
  }

  // Low-level spawn — applies PTY_DEFAULTS and the augmented env.
  _spawnRaw(file, args, cwd) {
    return this._pty.spawn(file, args, { ...PTY_DEFAULTS, cwd, env: buildSpawnEnv(process.env) });
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


  // Try to spawn at `requestedCwd`; on failure with a non-homedir cwd, retry at homedir.
  // Returns { ptyProcess, resolvedLauncher, spawnCwd }.
  // Throws (with descriptive message) if both attempts fail.
  _spawnWithHomedirFallback(extraArgs, launcher, requestedCwd, sessionId, label) {
    const homedir = os.homedir();
    const spawnCwd = requestedCwd || homedir;
    const { file, args, launcher: resolvedLauncher } = this._spawnArgs(extraArgs, launcher);
    this.log.info(`${label} spawn id=${sessionId} file=${file} args=${JSON.stringify(args)} cwd=${spawnCwd} launcher=${resolvedLauncher}`);
    try {
      return { ptyProcess: this._spawnRaw(file, args, spawnCwd), resolvedLauncher, spawnCwd };
    } catch (err) {
      this.log.error(`${label} spawn FAILED id=${sessionId} cwd=${spawnCwd}: ${err?.message || err}`);
      if (spawnCwd === homedir) {
        throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err.message}`);
      }
      this.log.warn(`${label} retry id=${sessionId} with homedir cwd=${homedir}`);
      try {
        return { ptyProcess: this._spawnRaw(file, args, homedir), resolvedLauncher, spawnCwd: homedir };
      } catch (err2) {
        this.log.error(`${label} retry FAILED id=${sessionId}: ${err2?.message || err2}`);
        throw new Error(`Failed to spawn PTY for session ${sessionId}: ${err2.message}`);
      }
    }
  }

  _createSessionEntry(ptyProcess, spawnCwd, resolvedLauncher) {
    return {
      pty: ptyProcess,
      alive: true,
      openedAt: Date.now(),
      lastDataAt: null,
      dataBytesSinceIdle: 0,
      cwd: spawnCwd,
      launcher: resolvedLauncher,
      // Diagnostic: buffer the first chunk of output so an early exit can be
      // explained in the log (e.g. "unknown flag", "command not found").
      earlyOutput: '',
      earlyOutputCap: EARLY_OUTPUT_CAP,
    };
  }

  // Wire data + exit handlers for an open/new session. `label` ("openSession"
  // or "newSession") prefixes the exit log line.
  _attachSessionHandlers(sessionId, entry, label) {
    entry.pty.onData((data) => {
      if (!entry.alive) return;
      const now = Date.now();
      // Reset burst counter after IDLE_RESET_MS of silence (new burst = new activity)
      if (entry.lastDataAt && (now - entry.lastDataAt) > IDLE_RESET_MS) {
        entry.dataBytesSinceIdle = 0;
      }
      entry.lastDataAt = now;
      entry.dataBytesSinceIdle += data.length;
      if (entry.earlyOutput.length < entry.earlyOutputCap) {
        entry.earlyOutput += data;
      }
      this.emit('data', sessionId, data);
    });

    entry.pty.onExit(({ exitCode }) => {
      if (!entry.alive) return;
      entry.alive = false;
      const aliveMs = Date.now() - entry.openedAt;
      if (aliveMs < EARLY_EXIT_MS) {
        const snippet = sanitizeForLog(entry.earlyOutput);
        this.log.warn(`${label} PTY exit (early) id=${sessionId} exitCode=${exitCode} aliveMs=${aliveMs} launcher=${entry.launcher} cwd=${entry.cwd} output=<<<${snippet}>>>`);
      } else {
        this.log.info(`${label} PTY exit id=${sessionId} exitCode=${exitCode} aliveMs=${aliveMs}`);
      }
      this.emit('exit', sessionId, exitCode);
      // Only remove from map if this is still the current entry (avoids
      // racing with a kill+respawn that already swapped in a new entry).
      if (this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
      }
    });
  }

  openSession(sessionId, cwd, launcher) {
    if (this.sessions.has(sessionId) && this.sessions.get(sessionId).alive) {
      this.log.debug(`openSession id=${sessionId} already alive — reusing`);
      return sessionId;
    }
    // Bug #26: clean up dead entry before respawning
    this.sessions.delete(sessionId);
    this._evictIfNeeded();

    const { ptyProcess, resolvedLauncher, spawnCwd } = this._spawnWithHomedirFallback(
      ['--resume', sessionId, '--yolo'], launcher, cwd, sessionId, 'openSession'
    );
    const entry = this._createSessionEntry(ptyProcess, spawnCwd, resolvedLauncher);
    this._attachSessionHandlers(sessionId, entry, 'openSession');
    this.sessions.set(sessionId, entry);
    return sessionId;
  }

  newSession(cwd, launcher, extraArgs = []) {
    return this._serializeSpawn(() => this._newSessionImpl(cwd, launcher, extraArgs));
  }

  // CLI 1.0.49+ rejects --resume <unknown-uuid>, so we spawn without --resume
  // and discover the CLI-assigned id by diffing ~/.copilot/session-state/
  // (or whatever `sessionStateDir` was injected). The whole sequence runs
  // under `_serializeSpawn` so concurrent newSession/warmUp calls can't race
  // on that folder-snapshot diff.
  async _newSessionImpl(cwd, launcher, extraArgs = []) {
    this._evictIfNeeded();
    const beforeSnapshot = await this._snapshotSessionFolders();

    const { ptyProcess, resolvedLauncher, spawnCwd } = this._spawnWithHomedirFallback(
      ['--yolo', ...extraArgs], launcher, cwd, '<pending>', 'newSession'
    );

    let sessionId;
    try {
      sessionId = await this._sessionIdDiscoverer(beforeSnapshot, ptyProcess);
    } catch (err) {
      this.log.error(`newSession id-discovery FAILED: ${err?.message || err}`);
      try { ptyProcess.kill(); } catch {}
      throw new Error(`Failed to discover session ID after CLI spawn: ${err.message}`);
    }
    this.log.info(`newSession discovered id=${sessionId} launcher=${resolvedLauncher}`);

    const entry = this._createSessionEntry(ptyProcess, spawnCwd, resolvedLauncher);
    this._attachSessionHandlers(sessionId, entry, 'newSession');
    this.sessions.set(sessionId, entry);
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
      const { file, args, launcher: resolvedLauncher } = spawnConfig;
      this.log.debug(`warmUp spawn file=${file} args=${JSON.stringify(args)} cwd=${spawnCwd} launcher=${resolvedLauncher}`);
      ptyProcess = this._spawnRaw(file, args, spawnCwd);
    } catch (err) {
      // Pre-warm failed — cold start will still work
      this.log.warn(`warmUp spawn failed cwd=${spawnCwd}: ${err?.message || err}`);
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

    const sessionEntry = this._createSessionEntry(standby.pty, standby.cwd, standby.launcher);
    // Buffered output is handed back to the caller; mark lastDataAt so
    // getBusySessions/killIdle treat this session as recently active.
    if (standby.bufferedData.length > 0) {
      sessionEntry.lastDataAt = Date.now();
    }
    this._attachSessionHandlers(standby.id, sessionEntry, 'claimStandby');
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
    const alive = [...this.sessions.entries()]
      .filter(([, e]) => e.alive)
      .sort((a, b) => a[1].openedAt - b[1].openedAt);
    while (alive.length >= this.maxConcurrent) {
      const [oldestId, oldestEntry] = alive.shift();
      oldestEntry.alive = false;
      this.emit('evicted', oldestId);
      try { oldestEntry.pty.kill(); } catch {}
      this.sessions.delete(oldestId);
    }
  }
}

module.exports = PtyManager;
module.exports.buildSpawnEnv = buildSpawnEnv;
