const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const readline = require('readline');
const { readPreferredSessionCwd } = require('./session-cwd');
const { HISTORY_SESSION_LIMIT, getHistoryScopeCutoff } = require('./history-limit');
const { parseLauncherArgs } = require('./app-support');
class SessionService {
  constructor(sessionStateDir) {
    this.dir = sessionStateDir;
    this.m_workspaceMetaWrites = new Map();
    // Cache _loadSession results keyed by entry.name.
    // value = { fingerprint, session } where fingerprint encodes per-file
    // {mtimeMs,size} for workspace.yaml, .deepsky-title, .deepsky-cwd,
    // events.jsonl, plus the session dir. Cache hits skip YAML parsing,
    // events.jsonl streaming, and cwd resolution — a meaningful win when
    // pollSessionStatus fires every 3s and most sessions haven't changed.
    this._sessionCache = new Map();
  }

  _invalidateSessionCache(sessionId) {
    if (!sessionId) return;
    this._sessionCache.delete(sessionId);
  }

  _getSessionDir(sessionId) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId.trim() ||
      path.basename(sessionId) !== sessionId ||
      sessionId.includes('..')
    ) {
      throw new Error('Invalid session ID.');
    }
    return path.join(this.dir, sessionId);
  }

  _normalizeLauncher(value) {
    return String(value || '').trim().toLowerCase() === 'agency' ? 'agency' : 'copilot';
  }

  async _readWorkspaceMeta(sessionDir) {
    try {
      const yamlPath = path.join(sessionDir, 'workspace.yaml');
      const yamlContent = await fs.promises.readFile(yamlPath, 'utf8');
      return yaml.load(yamlContent) || {};
    } catch {
      return {};
    }
  }

  async _writeWorkspaceMeta(sessionDir, meta) {
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const yamlPath = path.join(sessionDir, 'workspace.yaml');
    const tempPath = path.join(
      sessionDir,
      `workspace.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    await fs.promises.writeFile(tempPath, yaml.dump(meta, { lineWidth: -1 }), 'utf8');
    await fs.promises.rename(tempPath, yamlPath);
  }

  async _updateWorkspaceMeta(sessionId, updater) {
    const sessionDir = this._getSessionDir(sessionId);
    const previous = this.m_workspaceMetaWrites.get(sessionId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const meta = await this._readWorkspaceMeta(sessionDir);
        const updated = await updater({ ...meta });
        await this._writeWorkspaceMeta(sessionDir, updated);
        this._invalidateSessionCache(sessionId);
        return updated;
      });

    this.m_workspaceMetaWrites.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.m_workspaceMetaWrites.get(sessionId) === next) {
        this.m_workspaceMetaWrites.delete(sessionId);
      }
    }
  }

  _normalizeListScope(options = {}) {
    return String(options?.scope || '').trim().toLowerCase() === 'history' ? 'history' : 'all';
  }

  async _readSessionEntries() {
    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    return entries.filter(e => e.isDirectory());
  }

  async _getSessionLastModifiedHint(entry) {
    const sessionDir = path.join(this.dir, entry.name);
    const candidatePaths = [
      sessionDir,
      path.join(sessionDir, 'workspace.yaml'),
      path.join(sessionDir, 'events.jsonl'),
    ];
    const stats = await Promise.allSettled(candidatePaths.map(filePath => fs.promises.stat(filePath)));
    return stats
      .filter(result => result.status === 'fulfilled')
      .reduce((max, result) => Math.max(max, result.value.mtimeMs), 0);
  }

  // Compute a per-file fingerprint for cache invalidation in _loadSession.
  // Includes {mtimeMs,size} for every file _loadSession reads. Using a tuple
  // (not just max-mtime) means a change to ANY relevant file invalidates the
  // cache, even if another file is newer. Size guards against same-mtime
  // overwrites that can happen at the OS timestamp resolution boundary.
  async _computeSessionFingerprint(sessionDir) {
    const candidates = [
      sessionDir,
      path.join(sessionDir, 'workspace.yaml'),
      path.join(sessionDir, '.deepsky-title'),
      path.join(sessionDir, '.deepsky-cwd'),
      path.join(sessionDir, 'events.jsonl'),
    ];
    const stats = await Promise.allSettled(candidates.map(p => fs.promises.stat(p)));
    return stats
      .map(r => (r.status === 'fulfilled' ? `${r.value.mtimeMs}:${r.value.size}` : '_'))
      .join('|');
  }

  async listSessions(options = {}) {
    const scope = this._normalizeListScope(options);
    const dirs = await this._readSessionEntries();
    let entriesToLoad = dirs.map(entry => ({ entry, lastModifiedHint: 0 }));

    if (scope === 'history') {
      const cutoffMs = getHistoryScopeCutoff().getTime();
      const candidates = await Promise.allSettled(dirs.map(async (entry) => ({
        entry,
        lastModifiedHint: await this._getSessionLastModifiedHint(entry),
      })));

      entriesToLoad = candidates
        .filter(result => result.status === 'fulfilled' && result.value.lastModifiedHint >= cutoffMs)
        .map(result => result.value)
        .sort((a, b) => b.lastModifiedHint - a.lastModifiedHint)
        .slice(0, HISTORY_SESSION_LIMIT);
    }

    const results = await Promise.allSettled(entriesToLoad.map(item => this._loadSession(item.entry, item.lastModifiedHint)));
    let sessions = results
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    // Sort by last modified, newest first
    sessions.sort((a, b) => b.lastModified - a.lastModified);
    if (scope === 'history') {
      const cutoffMs = getHistoryScopeCutoff().getTime();
      sessions = sessions
        .filter((session) => {
          const updatedAtMs = Date.parse(session.updatedAt);
          const effectiveMs = Number.isFinite(updatedAtMs) ? updatedAtMs : session.lastModified;
          return effectiveMs >= cutoffMs;
        })
        .slice(0, HISTORY_SESSION_LIMIT);
    }
    return sessions;
  }

  async searchSessions(query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const dirs = entries.filter(e => e.isDirectory());

    const results = await Promise.allSettled(dirs.map(entry => this._searchSessionOccurrences(entry, needle)));
    return results
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);
  }

  async getLastUserPrompt(sessionId, options = {}) {
    const sessionDir = this._getSessionDir(sessionId);
    return this._extractLastUserPromptFromEvents(sessionDir, options);
  }

  /**
   * Returns true if the LAST `assistant.message` event in events.jsonl
   * contains a Pull Request URL (GitHub `/pull/<id>` or Azure DevOps
   * `/pullrequest/<id>`). Used to drive the "Pending PR" status badge
   * — fires only when the agent's most recent response surfaces a PR,
   * not whenever any historical PR was ever mentioned.
   */
  async _extractLastAssistantHasPRFromEvents(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    let stat;
    try {
      stat = await fs.promises.stat(eventsPath);
    } catch {
      return false;
    }
    if (!stat.size) return false;

    const TAIL_BYTES = 256 * 1024; // 256KB tail covers most assistant messages
    const PR_URL_RE = /\/pull\/\d+|\/pullrequest\/\d+/;
    let scanLines = await this._readEventsTailLines(eventsPath, stat.size, TAIL_BYTES);

    // If we never found a single assistant.message in the tail, widen to whole file
    // (cheap fallback — events.jsonl is normally a few MB).
    let widened = false;
    while (true) {
      for (let i = scanLines.length - 1; i >= 0; i--) {
        let event;
        try { event = JSON.parse(scanLines[i]); } catch { continue; }
        if (event?.type !== 'assistant.message') continue;
        // Found the last assistant message — check it (and only it) for PR URLs.
        const texts = [];
        this._collectVisibleAssistantTexts(event.data, (t) => texts.push(String(t || '')));
        const blob = texts.join('\n');
        return PR_URL_RE.test(blob);
      }
      if (widened) return false;
      // Tail didn't contain any assistant.message — try reading the full file.
      widened = true;
      try {
        const full = await fs.promises.readFile(eventsPath, 'utf8');
        scanLines = full.split('\n').filter(Boolean);
      } catch {
        return false;
      }
    }
  }

  async _readEventsTailLines(eventsPath, fileSize, tailBytes) {
    const readSize = Math.min(fileSize, tailBytes);
    const buf = Buffer.alloc(readSize);
    const fh = await fs.promises.open(eventsPath, 'r');
    try {
      await fh.read(buf, 0, readSize, fileSize - readSize);
    } finally {
      await fh.close();
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // If we started mid-file, the first line is almost certainly partial — drop it.
    if (fileSize > tailBytes && lines.length > 1) lines.shift();
    return lines.filter(Boolean);
  }

  async _loadSession(entry, lastModifiedHint = 0) {
    const sessionDir = path.join(this.dir, entry.name);
    const yamlPath = path.join(sessionDir, 'workspace.yaml');

    // Fast path: if the fingerprint matches the cached one, none of the files
    // _loadSession reads have changed, so we can reuse the previous result.
    const fingerprint = await this._computeSessionFingerprint(sessionDir).catch(() => null);
    if (fingerprint) {
      const cached = this._sessionCache.get(entry.name);
      if (cached && cached.fingerprint === fingerprint) {
        const hint = Number(lastModifiedHint) || 0;
        if (hint > cached.session.lastModified) {
          return { ...cached.session, lastModified: hint };
        }
        return cached.session;
      }
    }

    try {
      const [yamlContent, yamlStat] = await Promise.all([
        fs.promises.readFile(yamlPath, 'utf8'),
        fs.promises.stat(yamlPath),
      ]);
      const meta = yaml.load(yamlContent) || {};

      let title = null;
      let isCustomTitle = false;
      let customTitleMtimeMs = 0;

      const customTitlePath = path.join(sessionDir, '.deepsky-title');
      try {
        const [customTitle, customTitleStat] = await Promise.all([
          fs.promises.readFile(customTitlePath, 'utf8'),
          fs.promises.stat(customTitlePath),
        ]);
        title = customTitle.trim();
        isCustomTitle = !!title;
        customTitleMtimeMs = customTitleStat.mtimeMs;
      } catch {
        // No legacy custom title — fall through to workspace metadata
      }

      if (!title || (typeof meta.name === 'string' && meta.name.trim() && customTitleMtimeMs < yamlStat.mtimeMs)) {
        title = typeof meta.name === 'string' && meta.name.trim()
          ? meta.name.trim()
          : null;
        if (title) isCustomTitle = false;
      }

      if (!title) {
        title = typeof meta.summary === 'string' && meta.summary.trim()
          ? meta.summary.trim()
          : null;
      }

      // If no workspace title, try to extract from first user message in events.jsonl
      if (!title) {
        title = await this._extractTitleFromEvents(sessionDir);
      }

      if (!title) {
        title = `Session ${entry.name.substring(0, 8)}`;
      }

      if (!isCustomTitle) {
        // Clean up titles that are raw prompts (quoted strings from knowledge queries)
        if (title.startsWith('"')) {
          title = title.replace(/^"/, '').replace(/"$/, '');
          if (title.startsWith("Use the 'knowledge-based-answer'")) {
            const match = title.match(/answer:\s*(.+)/);
            title = match ? match[1].substring(0, 60) : title.substring(0, 60);
          }
          if (title.startsWith('Follow the workflow')) {
            title = title.substring(0, 60);
          }
        }

        // Truncate long titles
        if (title.length > 70) {
          title = title.substring(0, 67) + '...';
        }
      }

      const cwd = await readPreferredSessionCwd(sessionDir);

      // Cheap because events.jsonl mtime+size are already in the fingerprint
      // above, so this only re-runs when new events land.
      const lastAssistantHasPR = await this._extractLastAssistantHasPRFromEvents(sessionDir).catch(() => false);

      const stat = await fs.promises.stat(sessionDir);
      const lastModified = Math.max(stat.mtimeMs, yamlStat.mtimeMs, Number(lastModifiedHint) || 0);
      const session = {
        id: entry.name,
        title,
        cwd,
        lastAssistantHasPR,
        createdAt: meta.created_at || stat.birthtime.toISOString(),
        updatedAt: meta.updated_at || new Date(lastModified).toISOString(),
        lastModified,
      };
      if (fingerprint) {
        this._sessionCache.set(entry.name, { fingerprint, session });
      }
      return session;
    } catch {
      // Skip sessions with unreadable metadata
      this._sessionCache.delete(entry.name);
      return null;
    }
  }

  async _searchSessionOccurrences(entry, needle) {
    const sessionDir = path.join(this.dir, entry.name);

    try {
      const occurrences = await this._searchEventsForOccurrences(sessionDir, needle);
      return occurrences.length ? { id: entry.name, occurrences, preview: occurrences[0].preview } : null;
    } catch {
      return null;
    }
  }

  async _readOptionalTrimmedFile(filePath) {
    try {
      return (await fs.promises.readFile(filePath, 'utf8')).trim();
    } catch {
      return '';
    }
  }

  _buildSearchPreview(value, needle) {
    if (!value || !needle) return '';
    return this._collectMatchesFromText(value, needle, { maxMatches: 1 })[0]?.preview || '';
  }

  _buildSearchPreviewFromMatch(text, matchIndex, matchLength) {
    const radius = 42;
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(text.length, matchIndex + matchLength + radius);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  _normalizeSearchText(value) {
    if (!value) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  _buildSearchMatch(text, matchIndex, matchLength) {
    const previewRadius = 42;
    const contextRadius = 28;
    const previewStart = Math.max(0, matchIndex - previewRadius);
    const previewEnd = Math.min(text.length, matchIndex + matchLength + previewRadius);
    const contextStart = Math.max(0, matchIndex - contextRadius);
    const contextEnd = Math.min(text.length, matchIndex + matchLength + contextRadius);

    return {
      preview: `${previewStart > 0 ? '…' : ''}${text.slice(previewStart, previewEnd)}${previewEnd < text.length ? '…' : ''}`,
      beforeText: text.slice(contextStart, matchIndex),
      matchText: text.slice(matchIndex, matchIndex + matchLength),
      afterText: text.slice(matchIndex + matchLength, contextEnd)
    };
  }

  _collectMatchesFromText(value, needle, { sourceLabel = '', maxMatches = Infinity } = {}) {
    const text = this._normalizeSearchText(value);
    if (!text || !needle || maxMatches <= 0) return [];

    const matches = [];
    const lower = text.toLowerCase();
    let from = 0;
    while (from <= lower.length - needle.length && matches.length < maxMatches) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      matches.push({
        ...this._buildSearchMatch(text, idx, needle.length),
        sourceLabel
      });
      from = idx + Math.max(needle.length, 1);
    }
    return matches;
  }

  _extractVisibleEventTexts(event) {
    const texts = [];
    const push = (text, sourceLabel) => {
      const normalized = this._normalizeSearchText(text);
      if (normalized) texts.push({ text: normalized, sourceLabel });
    };

    switch (event.type) {
      case 'user.message':
        push(event.data?.content || event.data?.transformedContent, 'User');
        break;
      case 'assistant.message':
        this._collectVisibleAssistantTexts(event.data, (text) => push(text, 'Assistant'));
        break;
      case 'tool.execution_complete':
        push(event.data?.result?.content, 'Tool');
        push(event.data?.result?.detailedContent, 'Tool');
        break;
      default:
        break;
    }

    return texts;
  }

  _collectVisibleAssistantTexts(data, push) {
    if (!data) return;

    if (typeof data.content === 'string' && data.content.trim()) {
      push(data.content);
    }

    this._collectRenderableStrings(data.sections, push);
    this._collectRenderableStrings(data.parts, push);
    this._collectRenderableStrings(data.blocks, push);
  }

  _collectRenderableStrings(value, push, keyHint = '') {
    if (!value) return;

    const visibleKeys = new Set(['content', 'text', 'body', 'title', 'summary', 'markdown', 'message']);
    if (typeof value === 'string') {
      if (!keyHint || visibleKeys.has(keyHint)) push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this._collectRenderableStrings(item, push, keyHint);
      return;
    }

    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        this._collectRenderableStrings(nested, push, key);
      }
    }
  }

  _collectSearchableStrings(value, output) {
    if (!value) return;

    if (typeof value === 'string') {
      const text = value.replace(/\s+/g, ' ').trim();
      if (text) output.push(text);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this._collectSearchableStrings(item, output);
      return;
    }

    if (typeof value === 'object') {
      for (const nested of Object.values(value)) this._collectSearchableStrings(nested, output);
    }
  }

  _getEventSourceLabel(eventType) {
    switch (eventType) {
      case 'user.message':
        return 'User';
      case 'assistant.message':
        return 'Assistant';
      case 'tool.execution_complete':
        return 'Tool';
      default:
        return '';
    }
  }

  async _searchEventsForOccurrences(sessionDir, needle, maxOccurrences = 3) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try {
      await fs.promises.access(eventsPath);
    } catch {
      return [];
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      const occurrences = [];
      let finished = false;

      const finish = (value = occurrences) => {
        if (finished) return;
        finished = true;
        resolve(value);
        rl.close();
        stream.destroy();
      };

      rl.on('line', (line) => {
        if (finished) return;
        try {
          const event = JSON.parse(line);
          const texts = this._extractVisibleEventTexts(event);
          for (const entry of texts) {
            const remaining = maxOccurrences - occurrences.length;
            if (remaining <= 0) {
              finish();
              return;
            }
            occurrences.push(...this._collectMatchesFromText(entry.text, needle, { sourceLabel: entry.sourceLabel, maxMatches: remaining }));
            if (occurrences.length >= maxOccurrences) {
              finish();
              return;
            }
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        if (!finished) resolve(occurrences);
      });
      rl.on('error', () => finish([]));
      stream.on('error', () => finish([]));
    });
  }

  async _extractTitleFromEvents(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try {
      await fs.promises.access(eventsPath);
    } catch {
      return null;
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let found = false;

      rl.on('line', (line) => {
        if (found) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'user.message' && event.data?.content) {
            found = true;
            let content = event.data.content;
            // Strip leading whitespace and take first line
            content = content.trim().split('\n')[0];
            // Truncate
            if (content.length > 70) {
              content = content.substring(0, 67) + '...';
            }
            resolve(content);
            rl.close();
            stream.destroy();
          }
        } catch {
          // skip malformed lines
        }
      });

      rl.on('close', () => {
        if (!found) resolve(null);
      });
    });
  }

  async _extractLastUserPromptFromEvents(sessionDir, { full = false } = {}) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try {
      await fs.promises.access(eventsPath);
    } catch {
      return '';
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lastPrompt = '';

      rl.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type !== 'user.message') return;
          const prompt = this._normalizeSearchText(event.data?.content || event.data?.transformedContent);
          if (!prompt) return;
          lastPrompt = (!full && prompt.length > 160) ? `${prompt.slice(0, 157)}...` : prompt;
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => resolve(lastPrompt));
      rl.on('error', () => resolve(lastPrompt));
      stream.on('error', () => resolve(lastPrompt));
    });
  }

  async cleanEmptySessions() {
    const entries = await fs.promises.readdir(this.dir, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    let cleaned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(this.dir, entry.name);
      const eventsPath = path.join(sessionDir, 'events.jsonl');

      try {
        const eventsExist = await fs.promises.access(eventsPath).then(() => true).catch(() => false);

        if (!eventsExist) {
          // No events file at all — check if workspace.yaml has a summary
          const yamlPath = path.join(sessionDir, 'workspace.yaml');
          try {
            const yamlContent = await fs.promises.readFile(yamlPath, 'utf8');
            const meta = yaml.load(yamlContent);
            if (!meta.summary) {
              await fs.promises.rm(sessionDir, { recursive: true, force: true });
              this._invalidateSessionCache(entry.name);
              cleaned++;
            }
          } catch {
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
            this._invalidateSessionCache(entry.name);
            cleaned++;
          }
          continue;
        }

        // Events file exists but may be empty
        const stat = await fs.promises.stat(eventsPath);
        if (stat.size === 0) {
          const yamlPath = path.join(sessionDir, 'workspace.yaml');
          try {
            const yamlContent = await fs.promises.readFile(yamlPath, 'utf8');
            const meta = yaml.load(yamlContent);
            if (!meta.summary) {
              await fs.promises.rm(sessionDir, { recursive: true, force: true });
              this._invalidateSessionCache(entry.name);
              cleaned++;
            }
          } catch {
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
            this._invalidateSessionCache(entry.name);
            cleaned++;
          }
        }
      } catch {
        // Skip errors
      }
    }

    console.log(`Cleaned ${cleaned} empty sessions`);
    return cleaned;
  }
  async saveCwd(sessionId, cwd) {
    const sessionDir = this._getSessionDir(sessionId);
    await this._updateWorkspaceMeta(sessionId, (meta) => ({
      ...meta,
      cwd: cwd.trim(),
    }));
    await fs.promises.rm(path.join(sessionDir, '.deepsky-cwd'), { force: true }).catch(() => {});
    this._invalidateSessionCache(sessionId);
  }

  async clearCwd(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    await this._updateWorkspaceMeta(sessionId, (meta) => {
      delete meta.cwd;
      return meta;
    });
    try {
      await fs.promises.rm(path.join(sessionDir, '.deepsky-cwd'), { force: true });
    } catch {}
    this._invalidateSessionCache(sessionId);
  }

  async getCwd(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    return readPreferredSessionCwd(sessionDir);
  }

  async saveLauncher(sessionId, launcher) {
    const sessionDir = this._getSessionDir(sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sessionDir, '.deepsky-launcher'),
      this._normalizeLauncher(launcher),
      'utf8'
    );
  }

  async saveLauncherArgs(sessionId, argsText) {
    const sessionDir = this._getSessionDir(sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sessionDir, '.deepsky-launcher-args'),
      typeof argsText === 'string' ? argsText.trim() : '',
      'utf8'
    );
  }

  async getLauncher(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    try {
      const launcher = await fs.promises.readFile(path.join(sessionDir, '.deepsky-launcher'), 'utf8');
      return this._normalizeLauncher(launcher);
    } catch {}
    return 'copilot';
  }

  async getLauncherArgs(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    const argsPath = path.join(sessionDir, '.deepsky-launcher-args');
    let argsText;
    try {
      argsText = (await fs.promises.readFile(argsPath, 'utf8')).trim();
    } catch (error) {
      return '';
    }
    try {
      parseLauncherArgs(argsText);
      return argsText;
    } catch {
      await fs.promises.rm(argsPath, { force: true }).catch(() => {});
    }
    return '';
  }

  async renameSession(sessionId, title) {
    const sessionDir = this._getSessionDir(sessionId);
    await this._updateWorkspaceMeta(sessionId, (meta) => ({
      ...meta,
      name: title.trim(),
    }));
    await fs.promises.rm(path.join(sessionDir, '.deepsky-title'), { force: true }).catch(() => {});
    this._invalidateSessionCache(sessionId);
  }

  async deleteSession(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    this._invalidateSessionCache(sessionId);
  }
}

module.exports = SessionService;
