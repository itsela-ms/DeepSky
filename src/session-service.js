const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const readline = require('readline');
const { readPreferredSessionCwd } = require('./session-cwd');
const { NOOP_LOG } = require('./logger');
const { HISTORY_SESSION_LIMIT, getHistoryScopeCutoff } = require('./history-limit');

class SessionService {
  constructor(sessionStateDir, logger = NOOP_LOG) {
    this.dir = sessionStateDir;
    this.log = logger;
    this.m_workspaceMetaWrites = new Map();
    this._lastListSignature = null;
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
    try {
      await fs.promises.writeFile(tempPath, yaml.dump(meta, { lineWidth: -1 }), 'utf8');
      await fs.promises.rename(tempPath, yamlPath);
      this.log.debug(`_writeWorkspaceMeta: ${yamlPath}`);
    } catch (err) {
      this.log.error(`_writeWorkspaceMeta failed for ${yamlPath}: ${err?.message || err}`);
      // Best-effort cleanup of the orphaned temp file.
      try { await fs.promises.rm(tempPath, { force: true }); } catch {}
      throw err;
    }
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
      if (error?.code === 'ENOENT') {
        this.log.warn(`listSessions: dir missing at ${this.dir} (ENOENT) — returning empty list`);
        return [];
      }
      this.log.error(`listSessions: readdir failed at ${this.dir}: ${error?.message || error}`);
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

    // Bucket results so we can emit one summary line per cycle instead of one
    // warn per Copilot-native session (the ~/.copilot/session-state dir is
    // shared with the Copilot CLI, which writes session dirs without our
    // workspace.yaml metadata — those aren't bugs, just not DeepSky sessions).
    let loadedCount = 0;
    let nonDeepskyCount = 0;
    const errors = [];
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(r.reason);
        continue;
      }
      const v = r.value;
      if (v && typeof v === 'object' && v.__skipReason === 'no-workspace-yaml') {
        nonDeepskyCount++;
      } else if (v && typeof v === 'object' && v.__skipReason) {
        errors.push(new Error(`${v.__skipReason}: ${v.__detail || ''}`));
      } else if (v) {
        loadedCount++;
      }
    }

    let sessions = results
      .filter(r => r.status === 'fulfilled' && r.value && !r.value.__skipReason)
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

    // Throttle the summary line so we don't write it on every poll if nothing
    // changed (renderer polls listSessions every few seconds).
    const signature = `${dirs.length}|${loadedCount}|${nonDeepskyCount}|${errors.length}`;
    if (signature !== this._lastListSignature) {
      this._lastListSignature = signature;
      this.log.info(`listSessions: loaded=${loadedCount} non_deepsky=${nonDeepskyCount} errors=${errors.length} raw=${dirs.length}`);
      if (errors.length) {
        this.log.warn(`listSessions: ${errors.length} corrupt/unreadable session(s)`);
        for (const e of errors.slice(0, 5)) {
          this.log.warn(`listSessions corrupt: ${e?.message || e}`);
        }
      }
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

  async getLastUserPrompt(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    return this._extractLastUserPromptFromEvents(sessionDir);
  }

  async _loadSession(entry, lastModifiedHint = 0) {
    const sessionDir = path.join(this.dir, entry.name);
    const yamlPath = path.join(sessionDir, 'workspace.yaml');

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

      const stat = await fs.promises.stat(sessionDir);
      const lastModified = Math.max(stat.mtimeMs, yamlStat.mtimeMs, Number(lastModifiedHint) || 0);
      return {
        id: entry.name,
        title,
        cwd,
        createdAt: meta.created_at || stat.birthtime.toISOString(),
        updatedAt: meta.updated_at || new Date(lastModified).toISOString(),
        lastModified,
      };
    } catch (err) {
      // ENOENT on workspace.yaml is expected for plain Copilot CLI sessions
      // (they share ~/.copilot/session-state but never write our metadata).
      // Tag those separately so listSessions can aggregate instead of warning
      // once per session per poll cycle.
      if (err?.code === 'ENOENT' && typeof err?.path === 'string' && err.path.endsWith('workspace.yaml')) {
        return { __skipReason: 'no-workspace-yaml', id: entry.name };
      }
      // Real corruption — surface it so we can debug "session not appearing
      // in sidebar" reports.
      this.log.warn(`_loadSession: skipped ${entry.name}: ${err?.message || err}`);
      return { __skipReason: 'load-error', id: entry.name, __detail: err?.message || String(err) };
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

  async _extractLastUserPromptFromEvents(sessionDir) {
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
          lastPrompt = prompt.length > 160 ? `${prompt.slice(0, 157)}...` : prompt;
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
              this.log.info(`cleanEmptySessions: removing ${entry.name} (no events, no summary)`);
              await fs.promises.rm(sessionDir, { recursive: true, force: true });
              cleaned++;
            }
          } catch {
            this.log.info(`cleanEmptySessions: removing ${entry.name} (no events, unreadable workspace.yaml)`);
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
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
              this.log.info(`cleanEmptySessions: removing ${entry.name} (events empty, no summary)`);
              await fs.promises.rm(sessionDir, { recursive: true, force: true });
              cleaned++;
            }
          } catch {
            this.log.info(`cleanEmptySessions: removing ${entry.name} (events empty, unreadable workspace.yaml)`);
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
            cleaned++;
          }
        }
      } catch (err) {
        this.log.warn(`cleanEmptySessions: scan failed for ${entry.name}: ${err?.message || err}`);
      }
    }

    this.log.info(`cleanEmptySessions removed=${cleaned} (scanned dir=${this.dir})`);
    return cleaned;
  }
  async saveCwd(sessionId, cwd) {
    const sessionDir = this._getSessionDir(sessionId);
    this.log.info(`saveCwd id=${sessionId} cwd=${cwd}`);
    await this._updateWorkspaceMeta(sessionId, (meta) => ({
      ...meta,
      cwd: cwd.trim(),
    }));
    await fs.promises.rm(path.join(sessionDir, '.deepsky-cwd'), { force: true }).catch((err) => {
      this.log.debug(`saveCwd cleanup .deepsky-cwd id=${sessionId}: ${err?.message || err}`);
    });
  }

  async clearCwd(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    this.log.info(`clearCwd id=${sessionId}`);
    await this._updateWorkspaceMeta(sessionId, (meta) => {
      delete meta.cwd;
      return meta;
    });
    try {
      await fs.promises.rm(path.join(sessionDir, '.deepsky-cwd'), { force: true });
    } catch {}
  }

  async getCwd(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    const value = await readPreferredSessionCwd(sessionDir);
    this.log.debug(`getCwd id=${sessionId} → ${value || '<none>'}`);
    return value;
  }

  async saveLauncher(sessionId, launcher) {
    const sessionDir = this._getSessionDir(sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const normalised = this._normalizeLauncher(launcher);
    this.log.info(`saveLauncher id=${sessionId} launcher=${normalised}`);
    await fs.promises.writeFile(
      path.join(sessionDir, '.deepsky-launcher'),
      normalised,
      'utf8'
    );
  }

  async getLauncher(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    try {
      const launcher = await fs.promises.readFile(path.join(sessionDir, '.deepsky-launcher'), 'utf8');
      return this._normalizeLauncher(launcher);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.log.debug(`getLauncher id=${sessionId} read failed: ${err?.message || err}`);
      }
    }
    return 'copilot';
  }

  async renameSession(sessionId, title) {
    const sessionDir = this._getSessionDir(sessionId);
    await this._updateWorkspaceMeta(sessionId, (meta) => ({
      ...meta,
      name: title.trim(),
    }));
    await fs.promises.rm(path.join(sessionDir, '.deepsky-title'), { force: true }).catch(() => {});
  }

  async deleteSession(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    this.log.info(`deleteSession id=${sessionId} dir=${sessionDir}`);
    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      this.log.debug(`deleteSession id=${sessionId} removed`);
    } catch (err) {
      this.log.error(`deleteSession id=${sessionId} FAILED: ${err?.message || err}`);
      throw err;
    }
  }
}

module.exports = SessionService;
