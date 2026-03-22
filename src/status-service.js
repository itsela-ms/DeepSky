const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MAX_NEXT_STEP_WORDS = 6;
const MAX_SUMMARY_CHARS = 320;
const MAX_SUMMARY_SEGMENTS = 3;
const TRAILING_FILLER_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

class StatusService {
  constructor(sessionStateDir) {
    this.sessionStateDir = sessionStateDir;
    this.cache = new Map(); // sessionId → { data, mtimeMs }
  }

  invalidate(sessionId) {
    if (sessionId) this.cache.delete(sessionId);
    else this.cache.clear();
  }

  async getSessionStatus(sessionId) {
    const sessionDir = path.join(this.sessionStateDir, sessionId);
    try {
      const statusMtimeMs = await this._getStatusMtime(sessionDir);
      const cached = this.cache.get(sessionId);
      if (cached && statusMtimeMs <= cached.mtimeMs) return cached.data;

      const [intent, summary, nextSteps, files, timeline, notes] = await Promise.all([
        this._readIntent(sessionDir),
        this._readSummary(sessionDir),
        this._readPlan(sessionDir),
        this._readFiles(sessionDir),
        this._readTimeline(sessionDir),
        this._readNotes(sessionDir),
      ]);

      const data = { intent, summary, nextSteps, files, timeline, notes };
      this.cache.set(sessionId, { data, mtimeMs: statusMtimeMs });
      return data;
    } catch {
      return { intent: null, summary: null, nextSteps: [], files: [], timeline: [], notes: [] };
    }
  }

  async _getStatusMtime(sessionDir) {
    const candidatePaths = [
      sessionDir,
      path.join(sessionDir, 'events.jsonl'),
      path.join(sessionDir, 'session-summary.md'),
      path.join(sessionDir, 'plan.md'),
      path.join(sessionDir, 'workspace.yaml'),
      path.join(sessionDir, '.deepsky-notes.json'),
      path.join(sessionDir, 'checkpoints'),
    ];

    const stats = await Promise.all(candidatePaths.map(async (targetPath) => {
      try {
        return await fs.promises.stat(targetPath);
      } catch {
        return null;
      }
    }));

    let latestMtimeMs = stats.reduce((max, stat) => stat ? Math.max(max, stat.mtimeMs) : max, 0);

    try {
      const checkpointDir = path.join(sessionDir, 'checkpoints');
      const entries = await fs.promises.readdir(checkpointDir);
      const markdownFiles = entries.filter(entry => entry.endsWith('.md'));
      if (markdownFiles.length > 0) {
        const checkpointStats = await Promise.all(markdownFiles.map(async (entry) => {
          try {
            return await fs.promises.stat(path.join(checkpointDir, entry));
          } catch {
            return null;
          }
        }));
        latestMtimeMs = checkpointStats.reduce((max, stat) => stat ? Math.max(max, stat.mtimeMs) : max, latestMtimeMs);
      }
    } catch {}

    return latestMtimeMs;
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
   * 1. session-summary.md → ## Summary section
   * 2. Latest checkpoint → <overview> tag
   * 3. workspace.yaml → summary field
   */
  async _readSummary(sessionDir) {
    // 1. session-summary.md
    try {
      const content = await fs.promises.readFile(path.join(sessionDir, 'session-summary.md'), 'utf8');
      const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/);
      if (summaryMatch) {
        const text = this._normalizeSummary(summaryMatch[1]);
        if (text) return { text, source: 'session-summary' };
      }
      // Fallback: use the whole file as summary (minus the title)
      const body = this._normalizeSummary(content.replace(/^#[^\n]*\n/, ''));
      if (body) return { text: body, source: 'session-summary' };
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
          const text = this._normalizeSummary(overviewMatch[1]);
          if (text) return { text, source: 'checkpoint' };
        }
      }
    } catch {}

    // 3. workspace.yaml summary
    try {
      const yaml = await fs.promises.readFile(path.join(sessionDir, 'workspace.yaml'), 'utf8');
      const match = yaml.match(/^summary:\s*(.+)$/m);
      if (match && match[1].trim()) {
        const text = this._normalizeSummary(match[1]);
        if (text) return { text, source: 'workspace' };
      }
    } catch {}

    return null;
  }

  _normalizeSummary(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    if (!raw.trim()) return '';

    const chunks = [];
    let paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      chunks.push(paragraph.join(' ').trim());
      paragraph = [];
    };

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        flushParagraph();
        continue;
      }

      const isListItem = /^([-*]|\d+\.)\s+/.test(trimmed);
      const cleaned = trimmed
        .replace(/^#+\s+/, '')
        .replace(/^([-*]|\d+\.)\s+/, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleaned) continue;

      if (isListItem) {
        flushParagraph();
        chunks.push(cleaned);
        continue;
      }

      paragraph.push(cleaned);
    }

    flushParagraph();
    if (!chunks.length) return '';

    const joinChunks = (items) => items.reduce((acc, chunk) => {
      if (!acc) return chunk;
      return `${acc}${/[.!?]$/.test(acc) ? ' ' : '. '}${chunk}`;
    }, '');

    const fullText = joinChunks(chunks);
    if (fullText.length <= MAX_SUMMARY_CHARS) {
      return fullText;
    }

    const kept = [];
    for (const chunk of chunks) {
      if (kept.length >= MAX_SUMMARY_SEGMENTS) break;
      const candidate = joinChunks([...kept, chunk]);
      if (candidate.length > MAX_SUMMARY_CHARS) break;
      kept.push(chunk);
    }

    const bounded = kept.length ? joinChunks(kept) : this._truncateAtWord(chunks[0], MAX_SUMMARY_CHARS);
    if (bounded.length >= fullText.length) return bounded;

    return `${this._truncateAtWord(bounded, MAX_SUMMARY_CHARS - 3).replace(/[,:;\-–—.\s]+$/u, '')}...`;
  }

  _truncateAtWord(text, maxLength) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    const truncated = normalized.slice(0, Math.max(0, maxLength)).trimEnd();
    const boundary = truncated.lastIndexOf(' ');
    if (boundary >= Math.max(1, Math.floor(maxLength * 0.6))) {
      return truncated.slice(0, boundary).trimEnd();
    }
    return truncated;
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

  async _readNotes(sessionDir) {
    const notesPath = path.join(sessionDir, '.deepsky-notes.json');
    const commentPath = path.join(sessionDir, '.deepsky-comment');
    try {
      const raw = await fs.promises.readFile(notesPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      // Migrate from legacy .deepsky-comment if it exists
      try {
        const comment = (await fs.promises.readFile(commentPath, 'utf8')).replace(/\r\n/g, '\n').trim();
        if (comment) {
          const now = new Date().toISOString();
          const notes = [{ id: Date.now().toString(36), text: comment, createdAt: now, updatedAt: now }];
          await fs.promises.writeFile(notesPath, JSON.stringify(notes, null, 2), 'utf8');
          await fs.promises.rm(commentPath, { force: true });
          return notes;
        }
      } catch {}
      return [];
    }
  }

  /**
   * Extract file paths from edit/create tool events in events.jsonl.
   * Returns array of { path, action } (action: 'edit' | 'create').
   */
  async _readFiles(sessionDir) {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try { await fs.promises.access(eventsPath); } catch { return []; }

    const files = new Map(); // shortPath → { fullPath, action }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type !== 'tool.execution_start') return;

          const toolName = event.data?.toolName;
          if (toolName !== 'edit' && toolName !== 'create') return;

          // Extract file path from tool arguments
          const args = event.data?.arguments;
          if (!args) return;

          let filePath = null;
          if (typeof args === 'string') {
            const m = args.match(/"path"\s*:\s*"([^"]+)"/);
            if (m) filePath = m[1];
          } else if (typeof args === 'object') {
            filePath = args.path;
          }

          if (filePath) {
            const normalizedFull = filePath.replace(/\\/g, '/');
            const shortPath = normalizedFull.split('/').slice(-2).join('/');
            const action = toolName === 'create' ? 'A' : 'M';
            files.set(shortPath, { fullPath: normalizedFull, action });
          }
        } catch { /* skip */ }
      });

      rl.on('close', () => {
        resolve([...files].map(([p, { fullPath, action }]) => ({ path: p, fullPath, action })));
      });
      rl.on('error', () => resolve([]));
    });
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
