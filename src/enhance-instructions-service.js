const fs = require('fs');
const path = require('path');
const os = require('os');

const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const INSTRUCTIONS_FILE = path.join(COPILOT_DIR, 'copilot-instructions.md');
const PLAYBOOKS_DIR = path.join(COPILOT_DIR, 'playbooks');
const BACKUPS_ROOT = path.join(COPILOT_DIR, 'instruction-backups');
const PROPOSALS_ROOT = path.join(COPILOT_DIR, 'instruction-proposals');
const PROPOSED_SUBDIR = 'proposed';
const APPLIED_MARKER = 'applied.json';
const CHANGES_HTML = 'changes.html';
const PROMPT_FILE = 'enhance-prompt.md';

/**
 * Layout:
 *   ~/.copilot/instruction-backups/<timestamp>/   ← immutable snapshot
 *     copilot-instructions.md
 *     playbooks/*.md
 *     manifest.json
 *
 *   ~/.copilot/instruction-proposals/<timestamp>/ ← agent writes here
 *     proposed/copilot-instructions.md
 *     proposed/playbooks/*.md
 *     changes.html       (the diff/report DeepSky shows in the review modal)
 *     enhance-prompt.md  (the full prompt the agent was given)
 *     applied.json       (written when user clicks Apply — enables Rollback)
 *
 * The two folders share a timestamp so they pair 1:1. Backups are NEVER touched
 * after creation. The proposals folder is the only writable area for the agent.
 */

/**
 * Format Date as a filesystem-safe timestamp: YYYY-MM-DD_HHmmssSSS
 * Includes milliseconds to avoid same-second collisions.
 */
function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('') + pad(date.getMilliseconds(), 3);
}

/**
 * Snapshot the current instructions + playbooks to a timestamped backup folder.
 * MUST succeed before any enhancement workflow proceeds.
 *
 * Layout:
 *   ~/.copilot/instruction-backups/<timestamp>/
 *     copilot-instructions.md
 *     playbooks/*.md
 *     manifest.json   (records what was backed up)
 */
async function createBackup(deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  const now = deps.now || new Date();

  // Reuse the most recent backup if its contents exactly match the current state
  // AND its proposal hasn't been applied yet (i.e. there's nothing pending to forget).
  try {
    const existing = await listBackups({ fs: fsImpl });
    if (existing.length > 0) {
      const latest = existing[0];
      if (!latest.applied && await backupMatchesCurrentState(latest.backupDir, { fs: fsImpl })) {
        await fsImpl.rm(latest.proposalDir, { recursive: true, force: true });
        await fsImpl.mkdir(latest.proposalDir, { recursive: true });
        return {
          timestamp: latest.timestamp,
          backupDir: latest.backupDir,
          proposalDir: latest.proposalDir,
          fileCount: latest.fileCount,
          reused: true,
        };
      }
    }
  } catch {
    // If anything goes wrong evaluating reuse, fall through and create a fresh backup.
  }

  const timestamp = formatTimestamp(now);
  const backupDir = path.join(BACKUPS_ROOT, timestamp);
  const proposalDir = path.join(PROPOSALS_ROOT, timestamp);

  await fsImpl.mkdir(backupDir, { recursive: true });
  await fsImpl.mkdir(proposalDir, { recursive: true });

  const manifest = {
    timestamp,
    createdAt: now.toISOString(),
    files: [],
  };

  // Backup instructions file (if it exists)
  try {
    const content = await fsImpl.readFile(INSTRUCTIONS_FILE, 'utf8');
    await fsImpl.writeFile(path.join(backupDir, 'copilot-instructions.md'), content, 'utf8');
    manifest.files.push({ source: INSTRUCTIONS_FILE, name: 'copilot-instructions.md' });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Backup playbooks (if any)
  try {
    const playbookEntries = await fsImpl.readdir(PLAYBOOKS_DIR, { withFileTypes: true });
    const playbookBackupDir = path.join(backupDir, 'playbooks');
    let playbookCount = 0;
    for (const entry of playbookEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (playbookCount === 0) {
        await fsImpl.mkdir(playbookBackupDir, { recursive: true });
      }
      const sourcePath = path.join(PLAYBOOKS_DIR, entry.name);
      const content = await fsImpl.readFile(sourcePath, 'utf8');
      await fsImpl.writeFile(path.join(playbookBackupDir, entry.name), content, 'utf8');
      manifest.files.push({ source: sourcePath, name: `playbooks/${entry.name}` });
      playbookCount++;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fsImpl.writeFile(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  return { timestamp, backupDir, proposalDir, fileCount: manifest.files.length, reused: false };
}

/**
 * Compare a backup directory against the current live instructions + playbooks.
 * Returns true only if every file in current state has an identical byte-for-byte
 * twin in the backup AND the backup has no extra files that current state lacks.
 */
async function backupMatchesCurrentState(backupDir, deps = {}) {
  const fsImpl = deps.fs || fs.promises;

  const currentInstructions = await safeRead(fsImpl, INSTRUCTIONS_FILE);
  const backupInstructions = await safeRead(fsImpl, path.join(backupDir, 'copilot-instructions.md'));
  if (currentInstructions !== backupInstructions) return false;

  const currentPlaybooks = await readPlaybookContents(fsImpl, PLAYBOOKS_DIR);
  const backupPlaybooks = await readPlaybookContents(fsImpl, path.join(backupDir, 'playbooks'));

  const allNames = new Set([...Object.keys(currentPlaybooks), ...Object.keys(backupPlaybooks)]);
  for (const name of allNames) {
    if (currentPlaybooks[name] !== backupPlaybooks[name]) return false;
  }
  return true;
}

async function safeRead(fsImpl, filePath) {
  try {
    return await fsImpl.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readPlaybookContents(fsImpl, dir) {
  const out = {};
  let entries;
  try {
    entries = await fsImpl.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    out[entry.name] = await fsImpl.readFile(path.join(dir, entry.name), 'utf8');
  }
  return out;
}

/**
 * List backups newest-first. Each entry indicates whether the agent has staged
 * proposed changes (`hasProposed`), whether they've been applied (`applied`),
 * and whether the changes.html report exists.
 */
async function listBackups(deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  let entries;
  try {
    entries = await fsImpl.readdir(BACKUPS_ROOT, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidTimestamp(entry.name)) continue;
    const backupDir = path.join(BACKUPS_ROOT, entry.name);
    const proposalDir = path.join(PROPOSALS_ROOT, entry.name);
    let manifest = null;
    try {
      const raw = await fsImpl.readFile(path.join(backupDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw);
    } catch {
      // Skip corrupt or missing manifest; still surface the folder
    }
    let hasChangesHtml = false;
    try {
      await fsImpl.access(path.join(proposalDir, CHANGES_HTML));
      hasChangesHtml = true;
    } catch { /* not present */ }

    let hasProposed = false;
    try {
      const proposedEntries = await fsImpl.readdir(path.join(proposalDir, PROPOSED_SUBDIR));
      hasProposed = proposedEntries.length > 0;
    } catch { /* no proposed yet */ }

    let applied = false;
    let appliedAt = null;
    try {
      const raw = await fsImpl.readFile(path.join(proposalDir, APPLIED_MARKER), 'utf8');
      const parsed = JSON.parse(raw);
      applied = true;
      appliedAt = parsed.appliedAt || null;
    } catch { /* not applied yet */ }

    backups.push({
      timestamp: entry.name,
      backupDir,
      proposalDir,
      createdAt: manifest?.createdAt || null,
      fileCount: manifest?.files?.length || 0,
      hasChangesHtml,
      hasProposed,
      applied,
      appliedAt,
    });
  }

  backups.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return backups;
}

/**
 * Apply staged proposed changes from the proposal folder into ~/.copilot/.
 * Records the apply timestamp in `applied.json` so the UI can surface a
 * Rollback option afterwards. The backup snapshot itself is never touched —
 * it remains as the rollback source of truth.
 */
async function applyProposed(timestamp, deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  const now = deps.now || new Date();
  if (!isValidTimestamp(timestamp)) {
    throw new Error('Invalid backup timestamp.');
  }
  const proposalDir = path.join(PROPOSALS_ROOT, timestamp);
  const proposedDir = path.join(proposalDir, PROPOSED_SUBDIR);

  // Verify proposed dir exists with at least one file
  let proposedEntries;
  try {
    proposedEntries = await fsImpl.readdir(proposedDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No proposed changes found for backup ${timestamp}.`);
    }
    throw err;
  }
  if (proposedEntries.length === 0) {
    throw new Error(`No proposed changes found for backup ${timestamp}.`);
  }

  const applied = [];

  // Apply instructions file (if present in proposed)
  const proposedInstructions = path.join(proposedDir, 'copilot-instructions.md');
  try {
    const content = await fsImpl.readFile(proposedInstructions, 'utf8');
    await fsImpl.mkdir(COPILOT_DIR, { recursive: true });
    await fsImpl.writeFile(INSTRUCTIONS_FILE, content, 'utf8');
    applied.push('copilot-instructions.md');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Apply playbooks (and remove any existing ones not in the proposed set)
  const proposedPlaybooksDir = path.join(proposedDir, 'playbooks');
  let proposedPlaybookNames = [];
  try {
    const entries = await fsImpl.readdir(proposedPlaybooksDir, { withFileTypes: true });
    proposedPlaybookNames = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (proposedPlaybookNames.length > 0) {
    await fsImpl.mkdir(PLAYBOOKS_DIR, { recursive: true });

    // Remove current playbooks not in the proposed set
    try {
      const currentEntries = await fsImpl.readdir(PLAYBOOKS_DIR, { withFileTypes: true });
      for (const entry of currentEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (!proposedPlaybookNames.includes(entry.name)) {
          await fsImpl.unlink(path.join(PLAYBOOKS_DIR, entry.name));
          applied.push(`removed: playbooks/${entry.name}`);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    for (const name of proposedPlaybookNames) {
      const content = await fsImpl.readFile(path.join(proposedPlaybooksDir, name), 'utf8');
      await fsImpl.writeFile(path.join(PLAYBOOKS_DIR, name), content, 'utf8');
      applied.push(`playbooks/${name}`);
    }
  }

  await fsImpl.writeFile(
    path.join(proposalDir, APPLIED_MARKER),
    JSON.stringify({ appliedAt: now.toISOString(), files: applied }, null, 2),
    'utf8'
  );

  return { timestamp, applied };
}

/**
 * Discard staged proposed changes. Removes the entire proposal folder so the
 * next Enhance run starts fresh. The backup snapshot is left intact.
 */
async function discardProposed(timestamp, deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  if (!isValidTimestamp(timestamp)) {
    throw new Error('Invalid backup timestamp.');
  }
  const proposalDir = path.join(PROPOSALS_ROOT, timestamp);
  try {
    await fsImpl.rm(proposalDir, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { timestamp };
}

async function writeEnhancePrompt(backupDir, proposalDir, deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  const promptFilePath = path.join(proposalDir, PROMPT_FILE);
  const fullPrompt = buildEnhancePrompt(backupDir, proposalDir);

  await fsImpl.mkdir(proposalDir, { recursive: true });
  await fsImpl.mkdir(path.join(proposalDir, PROPOSED_SUBDIR, 'playbooks'), { recursive: true });
  try {
    await fsImpl.writeFile(promptFilePath, fullPrompt, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fsImpl.mkdir(proposalDir, { recursive: true });
    await fsImpl.mkdir(path.join(proposalDir, PROPOSED_SUBDIR, 'playbooks'), { recursive: true });
    await fsImpl.writeFile(promptFilePath, fullPrompt, 'utf8');
  }

  return { promptFilePath };
}

/**
 * Read the changes.html report for a backup, if present.
 */
async function getBackupHtml(timestamp, deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  if (!isValidTimestamp(timestamp)) {
    throw new Error('Invalid backup timestamp.');
  }
  const htmlPath = path.join(PROPOSALS_ROOT, timestamp, CHANGES_HTML);
  try {
    return await fsImpl.readFile(htmlPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Restore instructions + playbooks from a specific backup.
 * Overwrites current files. Removes any playbooks NOT present in the backup
 * (so a rollback is a true revert, not a merge).
 */
async function rollback(timestamp, deps = {}) {
  const fsImpl = deps.fs || fs.promises;
  if (!isValidTimestamp(timestamp)) {
    throw new Error('Invalid backup timestamp.');
  }
  const backupDir = path.join(BACKUPS_ROOT, timestamp);
  const manifestPath = path.join(backupDir, 'manifest.json');

  let manifest;
  try {
    const raw = await fsImpl.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Backup manifest missing or invalid: ${err.message}`);
  }

  const restored = [];
  const backedUpNames = new Set((manifest.files || []).map(f => f.name));

  // Restore instructions (or remove it if backup didn't have one)
  const backupInstructions = path.join(backupDir, 'copilot-instructions.md');
  if (backedUpNames.has('copilot-instructions.md')) {
    const content = await fsImpl.readFile(backupInstructions, 'utf8');
    await fsImpl.mkdir(COPILOT_DIR, { recursive: true });
    await fsImpl.writeFile(INSTRUCTIONS_FILE, content, 'utf8');
    restored.push('copilot-instructions.md');
  } else {
    try {
      await fsImpl.unlink(INSTRUCTIONS_FILE);
      restored.push('removed: copilot-instructions.md');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // Restore playbooks (and remove any extras not in backup)
  const backupPlaybooksDir = path.join(backupDir, 'playbooks');
  let backupPlaybookNames = [];
  try {
    const entries = await fsImpl.readdir(backupPlaybooksDir, { withFileTypes: true });
    backupPlaybookNames = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fsImpl.mkdir(PLAYBOOKS_DIR, { recursive: true });

  // Remove current playbooks not in the backup
  try {
    const currentEntries = await fsImpl.readdir(PLAYBOOKS_DIR, { withFileTypes: true });
    for (const entry of currentEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (!backupPlaybookNames.includes(entry.name)) {
        await fsImpl.unlink(path.join(PLAYBOOKS_DIR, entry.name));
        restored.push(`removed: playbooks/${entry.name}`);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Restore each playbook from backup
  for (const name of backupPlaybookNames) {
    const content = await fsImpl.readFile(path.join(backupPlaybooksDir, name), 'utf8');
    await fsImpl.writeFile(path.join(PLAYBOOKS_DIR, name), content, 'utf8');
    restored.push(`playbooks/${name}`);
  }

  // Clear the applied marker so the proposal goes back to "review pending" state.
  // The proposal folder itself is left intact in case the user wants to re-apply.
  try {
    await fsImpl.unlink(path.join(PROPOSALS_ROOT, timestamp, APPLIED_MARKER));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  return { timestamp, restored, manifest };
}

function isValidTimestamp(timestamp) {
  return typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}_\d{9}$/.test(timestamp);
}

/**
 * Build the predefined enhancement prompt.
 * Model-agnostic: refers to "current frontier coding models" rather than naming any.
 * The backup path is baked in so the agent knows where to write changes.html.
 */
function buildEnhancePrompt(backupDir, proposalDir) {
  const backupForwardSlash = backupDir.replace(/\\/g, '/');
  const proposalForwardSlash = proposalDir.replace(/\\/g, '/');
  const proposedDir = path.join(proposalDir, PROPOSED_SUBDIR).replace(/\\/g, '/');
  const proposedInstructions = path.join(proposalDir, PROPOSED_SUBDIR, 'copilot-instructions.md').replace(/\\/g, '/');
  const proposedPlaybooks = path.join(proposalDir, PROPOSED_SUBDIR, 'playbooks').replace(/\\/g, '/');
  const changesHtmlPath = path.join(proposalDir, CHANGES_HTML).replace(/\\/g, '/');
  return `Enhance my global Copilot instructions and playbooks based on the latest context-engineering and agent-skill best practices for current frontier coding/architecture models.

## How this works (read carefully)

This is a **propose-then-apply** flow with strict folder roles. You do NOT modify anything in \`~/.copilot/copilot-instructions.md\` or \`~/.copilot/playbooks/\` directly. You write proposals to a separate folder; DeepSky shows them to the user; the user clicks Apply or Discard.

There are TWO folders involved:

1. **Backup snapshot — STRICTLY READ-ONLY:**
   ${backupForwardSlash}
   Contains \`copilot-instructions.md\`, \`playbooks/*.md\`, and \`manifest.json\` as they existed before this run. Treat as immutable. Use only for reading / diffing context. Never write here for any reason.

2. **Proposal folder — YOUR WRITABLE WORKSPACE:**
   ${proposalForwardSlash}
   Everything you produce goes here. Specifically:
   - Proposed new instructions → \`${proposedInstructions}\`
   - Proposed new playbooks → \`${proposedPlaybooks}/<name>.md\` (one per playbook)
   - Diff / report HTML → \`${changesHtmlPath}\`

   The proposed playbook set must be the **complete** intended new state. Anything not present here will be removed when the user clicks Apply. To keep an existing playbook unchanged, copy it as-is into \`${proposedPlaybooks}/\`.

## Steps

1. **Read current state** (read-only):
   - \`~/.copilot/copilot-instructions.md\`
   - All files in \`~/.copilot/playbooks/\`
   You may also diff against the snapshot at \`${backupForwardSlash}\` for context.

2. **Research the latest context-engineering and Anthropic-style Skills best practices** for current frontier coding/architecture models. Focus on:
   - System-prompt structure (stable prefix, lazy loading, XML delimiters)
   - Token-budget discipline / context-rot mitigation
   - Skills format (YAML frontmatter — name + description triggers)
   - Anti-patterns and failure modes (poisoning, distraction, confusion, clash)
   - Sub-agent isolation patterns

3. **Audit the current instructions** for gaps, redundancy, weak structure, missing dispatch routing, missing anti-patterns, or context-hygiene issues.

4. **Write the proposed new versions** to the proposal folder paths listed above. Do NOT write anywhere under \`~/.copilot/\` other than into \`${proposalForwardSlash}\`.

5. **Write the report** to:
   ${changesHtmlPath}

   The report should:
   - Have a layered structure (TL;DR → file-by-file diff → principles → before/after → deeper rationale)
   - Show exactly what changed in each proposed file and why
   - End with a footer noting the user can Apply or Discard via DeepSky's review modal
   - **Theme:** Use Catppuccin Mocha as the dark default (DeepSky will override colors at render time, but design with Mocha so it looks right standalone too). If an artifact-skill mandates a different theme, follow that skill instead of blocking.
   - **Diffs:** For every changed line, use semantic markup so DeepSky can color it. Wrap added lines in \`<ins>...</ins>\` and removed lines in \`<del>...</del>\`, OR use \`<span class="diff-add">\` / \`<span class="diff-remove">\` if you need block-level styling. Do NOT rely on color alone in raw \`<pre>\` blocks — DeepSky will not colorize unmarked diff text.

6. **Validate token budget** with a single conservative heuristic: \`tokens ≈ characters / 4\`. The active context for a typical task (global instructions + worst-case dispatched playbook) should stay under ~3000 tokens. If you exceed that, compress.

## Constraints
- Do NOT pin to specific model names or version numbers — refer to current frontier model classes generically.
- Do NOT write outside \`${proposalForwardSlash}\`.
- Do NOT touch the backup snapshot at \`${backupForwardSlash}\` — it is the rollback source of truth.
- Do NOT touch \`~/.copilot/copilot-instructions.md\` or \`~/.copilot/playbooks/\`. DeepSky will replace those atomically only after the user clicks Apply.
- Use the manager-mode pattern from your playbooks if the work decomposes naturally.

When done, write a notification to \`~/.copilot/notifications/\` with type "task-done" titled "Instructions enhancement ready — review in DeepSky".`;
}

module.exports = {
  createBackup,
  listBackups,
  getBackupHtml,
  rollback,
  applyProposed,
  discardProposed,
  writeEnhancePrompt,
  buildEnhancePrompt,
  formatTimestamp,
  isValidTimestamp,
  // Exported for tests
  _paths: { COPILOT_DIR, INSTRUCTIONS_FILE, PLAYBOOKS_DIR, BACKUPS_ROOT, PROPOSALS_ROOT, PROPOSED_SUBDIR, PROMPT_FILE },
};
