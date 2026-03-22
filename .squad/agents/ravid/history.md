# Ravid — History

## Project Context
DeepSky: Electron desktop app wrapping GitHub Copilot CLI. Vanilla JS, xterm.js, node-pty, Catppuccin themes.
Owner: Itay Sela. Repo: itsela-ms/DeepSky.

## Learnings
<!-- Append new learnings below -->

### Path Traversal Validation Ordering (2026-03-19)
**Context:** Fixed `file:getDiff` IPC handler in src/main.js per Nir's security review rejection.

**Issue:** The code checked for `..` path segments AFTER `path.resolve()`, which normalizes them away:
```javascript
const normalized = path.resolve(filePath); // '../../../etc/passwd' → 'C:\etc\passwd'
if (normalized.includes('..')) { ... }     // Never triggers — '..'' already gone
```

**Fix:** Check raw input BEFORE normalization:
```javascript
if (filePath.includes('..')) { return { diff: null, error: 'Invalid file path' }; }
const normalized = path.resolve(filePath);
```

**Lesson:** Path validation must happen on raw input before normalization. After `path.resolve()`, traversal attempts are already sanitized, making checks on the normalized result logically dead code. Always validate → then normalize → then check final result against expected boundaries (git root check still needed as defense-in-depth).
