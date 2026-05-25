const fs = require('fs');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readPreferredSessionCwd } = require('./session-cwd');

const MAX_NEXT_STEP_WORDS = 6;
const TRAILING_FILLER_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const STATUS_CACHE_TTL_MS = 2000;

class StatusService {
  constructor(sessionStateDir, deps = {}) {
    this.sessionStateDir = sessionStateDir;
    this.cache = new Map(); // sessionId → { data, mtimeMs, readAt }
    this._execFile = deps.execFile || promisify(execFile);
  }

  invalidateSession(sessionId) {
    this.cache.delete(sessionId);
  }

  async getSessionStatus(sessionId) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId.trim() ||
      path.basename(sessionId) !== sessionId ||
      sessionId.includes('..')
    ) {
      return { intent: null, summary: null, nextSteps: [], files: [], generatedFiles: [], timeline: [] };
    }
    const sessionDir = path.join(this.sessionStateDir, sessionId);
    try {
      const stat = await fs.promises.stat(sessionDir);
      const cached = this.cache.get(sessionId);
      if (cached &&
          stat.mtimeMs <= cached.mtimeMs &&
          (Date.now() - cached.readAt) < STATUS_CACHE_TTL_MS) {
        return cached.data;
      }

      const [intent, summary, nextSteps, files, generatedFiles, timeline] = await Promise.all([
        this._readIntent(sessionDir),
        this._readSummary(sessionDir),
        this._readPlan(sessionDir),
        this._readFiles(sessionDir),
        this._readGeneratedFiles(sessionDir),
        this._readTimeline(sessionDir),
      ]);

      const data = { intent, summary, nextSteps, files, generatedFiles, timeline };
      this.cache.set(sessionId, { data, mtimeMs: stat.mtimeMs, readAt: Date.now() });
      return data;
    } catch {
      return { intent: null, summary: null, nextSteps: [], files: [], generatedFiles: [], timeline: [] };
    }
  }

  /**
   * Read the latest report_intent from the tail of events.jsonl.
   * Scans the last ~100 lines for the most recent tool.execution_complete
   * where detailedContent looks like an intent string (short, from report_intent tool).
   */
  async _readIntent(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return null; }

    // Read tail of file efficiently
    const stat = await fs.promises.stat(eventsPath);
    const readSize = Math.min(stat.size, 64 * 1024); // last 64KB
    const buf = Buffer.alloc(readSize);
    const fh = await fs.promises.open(eventsPath, 'r');
    await fh.read(buf, 0, readSize, stat.size - readSize);
    await fh.close();

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let latestIntent = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === 'tool.execution_complete' && event.data?.result?.detailedContent) {
          const content = event.data.result.detailedContent;
          // report_intent tool always returns "Intent logged" in content,
          // with the actual intent text in detailedContent
          if (event.data.result.content === 'Intent logged') {
            latestIntent = content;
            break;
          }
        }
      } catch { /* skip malformed lines */ }
    }

    return latestIntent;
  }

  /**
   * Read session summary from multiple sources in priority order:
   * 1. session-summary.md → Summary section
   * 2. Latest checkpoint → <overview> tag
   * 3. workspace.yaml → summary field
   */
  async _readSummary(sessionDir) {
    // 1. session-summary.md
    try {
      const content = await fs.promises.readFile(path.join(sessionDir, 'session-summary.md'), 'utf8');
      const extractedSummary = this._extractSummarySection(content);
      const normalizedSummary = this._normalizeSummaryText(extractedSummary);
      if (normalizedSummary) {
        return { text: normalizedSummary, source: 'session-summary' };
      }
    } catch {}

    // 2. Latest checkpoint
    try {
      const checkpointDir = path.join(sessionDir, 'checkpoints');
      const files = await fs.promises.readdir(checkpointDir);
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md').sort();
      if (mdFiles.length > 0) {
        const latest = await fs.promises.readFile(path.join(checkpointDir, mdFiles[mdFiles.length - 1]), 'utf8');
        const overviewMatch = latest.match(/<overview>\s*([\s\S]*?)\s*<\/overview>/);
        if (overviewMatch) {
          const normalizedSummary = this._normalizeSummaryText(overviewMatch[1]);
          if (normalizedSummary) {
            return { text: normalizedSummary, source: 'checkpoint' };
          }
        }
      }
    } catch {}

    // 3. workspace.yaml summary
    try {
      const yaml = await fs.promises.readFile(path.join(sessionDir, 'workspace.yaml'), 'utf8');
      const match = yaml.match(/^summary:\s*(.+)$/m);
      if (match && match[1].trim()) {
        const normalizedSummary = this._normalizeSummaryText(match[1]);
        if (normalizedSummary) {
          return { text: normalizedSummary, source: 'workspace' };
        }
      }
    } catch {}

    return null;
  }

  _extractSummarySection(content) {
    const markdownMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/i);
    if (markdownMatch?.[1]) {
      return markdownMatch[1].trim();
    }

    const labeledMatch = content.match(/^Summary:\s*([\s\S]*?)(?=\n\s*(?:Key Context|Resume Prompt):|\s*$)/i);
    if (labeledMatch?.[1]) {
      return labeledMatch[1].trim();
    }

    const body = content.replace(/^#[^\n]*\n/, '').trim();
    return body;
  }

  _normalizeSummaryText(content) {
    const cleaned = String(content || '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[*-]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '';

    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    const selected = sentences.length > 0 ? sentences.slice(0, 2).join(' ') : cleaned;
    if (selected.length <= 220) {
      return selected;
    }

    const shortened = selected.slice(0, 217).replace(/\s+\S*$/, '').trim();
    if (!shortened) return selected.slice(0, 220).trim();
    return /[.!?]$/.test(shortened) ? shortened : `${shortened}.`;
  }

  /**
   * Parse plan.md for todo items (markdown checkboxes).
   * Returns array of { text, done, current }.
   */
  async _readPlan(sessionDir) {
    try {
      const content = await fs.promises.readFile(path.join(sessionDir, 'plan.md'), 'utf8');
      const items = [];
      const lines = content.split('\n');
      let foundFirstUnchecked = false;

      for (const line of lines) {
        const doneMatch = line.match(/^\s*[-*]\s+\[x\]\s+(.+)/i);
        const todoMatch = line.match(/^\s*[-*]\s+\[\s?\]\s+(.+)/);

        if (doneMatch) {
          const text = this._summarizeNextStep(doneMatch[1]);
          if (text) {
            items.push({ text, done: true, current: false });
          }
        } else if (todoMatch) {
          const text = this._summarizeNextStep(todoMatch[1]);
          if (!text) continue;

          const isCurrent = !foundFirstUnchecked;
          foundFirstUnchecked = true;
          items.push({ text, done: false, current: isCurrent });
        }
      }

      // If no checkboxes found, try numbered list items (1. ... 2. ...)
      if (items.length === 0) {
        const numberedRe = /^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*[-—]?\s*(.*)/;
        for (const line of lines) {
          const m = line.match(numberedRe);
          if (m) {
            const text = this._summarizeNextStep(m[2]);
            if (text) {
              items.push({ text, done: false, current: items.length === 0 });
            }
          }
        }
      }

      return items;
    } catch {
      return [];
    }
  }

  _summarizeNextStep(text) {
    const cleaned = String(text || '')
      .replace(/`+/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '';

    const words = cleaned.split(' ').filter(Boolean);
    if (words.length <= MAX_NEXT_STEP_WORDS) {
      return cleaned;
    }

    const shortened = words.slice(0, MAX_NEXT_STEP_WORDS);
    while (shortened.length > 1 && TRAILING_FILLER_WORDS.has(shortened[shortened.length - 1].toLowerCase())) {
      shortened.pop();
    }

    return shortened.join(' ');
  }

  async _readFiles(sessionDir) {
    const cwd = await this._readSessionCwd(sessionDir);
    if (!cwd) return [];

    try {
      await this._execFile('git', ['rev-parse', '--show-toplevel'], { cwd });
      const { stdout } = await this._execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd });
      const files = String(stdout || '')
        .split(/\r?\n/)
        .map(line => line.trimEnd())
        .filter(Boolean)
        .map(line => this._parseGitStatusLine(line))
        .filter(Boolean);
      return Promise.all(files.map(async (file) => ({
        ...file,
        diff: await this._readFileDiffPreview(cwd, file),
      })));
    } catch {
      return [];
    }
  }

  async _readFileDiffPreview(cwd, file) {
    const normalizedPath = String(file?.path || '').trim();
    if (!normalizedPath) return '';

    const commands = [];
    switch (file.action) {
      case 'A':
        commands.push(['diff', '--no-ext-diff', '--cached', '--', normalizedPath]);
        break;
      case 'R':
        commands.push(['diff', '--no-ext-diff', '--cached', '--find-renames', '--', normalizedPath]);
        commands.push(['diff', '--no-ext-diff', '--find-renames', '--', normalizedPath]);
        break;
      case 'D':
      case 'M':
      default:
        commands.push(['diff', '--no-ext-diff', '--', normalizedPath]);
        commands.push(['diff', '--no-ext-diff', '--cached', '--', normalizedPath]);
        break;
    }

    for (const args of commands) {
      try {
        const { stdout } = await this._execFile('git', args, { cwd, maxBuffer: 1024 * 1024 });
        const preview = this._normalizeDiffPreview(stdout);
        if (preview) return preview;
      } catch {
        // Try the next git diff variant.
      }
    }

    if (file.action === 'A') return 'New file (no diff preview available yet)';
    if (file.action === 'D') return 'Deleted file (no diff preview available)';
    return '';
  }

  _normalizeDiffPreview(diffText) {
    const text = String(diffText || '').trim();
    if (!text) return '';

    const lines = text.split(/\r?\n/);
    const maxLines = 40;
    const maxChars = 4000;
    const clippedLines = lines.slice(0, maxLines);
    let preview = clippedLines.join('\n');
    if (preview.length > maxChars) {
      preview = `${preview.slice(0, maxChars - 1)}…`;
    } else if (lines.length > maxLines) {
      preview += '\n…';
    }
    return preview;
  }

  async _readGeneratedFiles(sessionDir) {
    const filesDir = path.join(sessionDir, 'files');
    try {
      await fs.promises.access(filesDir);
    } catch {
      return [];
    }

    const entries = [];
    const walk = async (dir) => {
      const children = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const child of children) {
        const childPath = path.join(dir, child.name);
        if (child.isSymbolicLink()) {
          continue;
        }
        if (child.isDirectory()) {
          await walk(childPath);
          continue;
        }
        if (!child.isFile()) continue;
        const stat = await fs.promises.stat(childPath);
        const ext = path.extname(child.name).replace(/^\./, '').toLowerCase();
        if (!['html', 'htm', 'pdf'].includes(ext)) continue;
        const relativePath = path.relative(sessionDir, childPath).replace(/\\/g, '/');
        entries.push({
          name: child.name,
          path: relativePath,
          ext,
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size,
        });
      }
    };

    try {
      await walk(filesDir);
    } catch {
      return [];
    }

    const priority = (ext) => {
      if (ext === 'html' || ext === 'htm') return 0;
      if (ext === 'pdf') return 1;
      return 2;
    };

    entries.sort((a, b) => {
      const byPriority = priority(a.ext) - priority(b.ext);
      if (byPriority !== 0) return byPriority;
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    return entries;
  }

  async _readSessionCwd(sessionDir) {
    return readPreferredSessionCwd(sessionDir);
  }

  _parseGitStatusLine(line) {
    if (line.startsWith('?? ')) {
      return { path: line.slice(3), action: 'A' };
    }

    if (line.length < 4) return null;
    const x = line[0];
    const y = line[1];
    const rawPath = line.slice(3).trim();
    const pathText = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;
    const action = this._mapGitAction(x, y);
    if (!pathText || !action) return null;
    return { path: pathText.replace(/\\/g, '/'), action };
  }

  _mapGitAction(x, y) {
    if (x === 'D' || y === 'D') return 'D';
    if (x === 'R' || y === 'R') return 'R';
    if (x === 'A' || y === 'A' || x === '?' || y === '?') return 'A';
    if (x === 'C' || y === 'C') return 'A';
    if (x === 'M' || y === 'M') return 'M';
    return null;
  }

  /**
   * Extract key timeline events from events.jsonl.
   * Returns array of { time, type, text } (newest first, max 20).
   */
  async _readTimeline(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return []; }

    const events = [];

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let userMsgCount = 0;

      rl.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          const ts = event.timestamp;
          if (!ts) return;

          switch (event.type) {
            case 'session.start':
              events.push({ time: ts, type: 'start', text: 'Session started' });
              break;
            case 'session.resume':
              events.push({ time: ts, type: 'resume', text: 'Session resumed' });
              break;
            case 'user.message':
              userMsgCount++;
              if (userMsgCount <= 10) {
                const content = (event.data?.content || '').trim().split('\n')[0];
                const preview = content.length > 60 ? content.substring(0, 57) + '...' : content;
                events.push({ time: ts, type: 'user', text: preview });
              }
              break;
            case 'session.plan_changed':
              events.push({ time: ts, type: 'plan', text: `Plan ${event.data?.operation || 'updated'}` });
              break;
            case 'subagent.started':
              events.push({ time: ts, type: 'agent', text: `Sub-agent started: ${event.data?.description || 'task'}` });
              break;
            case 'subagent.completed':
              events.push({ time: ts, type: 'agent', text: 'Sub-agent completed' });
              break;
          }
        } catch { /* skip */ }
      });

      rl.on('close', () => {
        // Reverse for newest-first, cap at 20
        resolve(events.reverse().slice(0, 20));
      });
      rl.on('error', () => resolve([]));
    });
  }
}

module.exports = StatusService;
