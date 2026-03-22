# Tomer — History

## Project Context
DeepSky: Electron desktop app wrapping GitHub Copilot CLI. Vanilla JS, xterm.js, node-pty, Catppuccin themes.
Owner: Itay Sela. Repo: itsela-ms/DeepSky.

## Learnings
<!-- Append new learnings below -->

### 2026-03-19: Critical security and stability fixes (v0.8.6)
Fixed 3 critical issues from Nir's code review:
1. **Path traversal vulnerability in `file:getDiff`**: Added path validation using `path.resolve()` to normalize paths, reject `..` traversal attempts, and verify files are within git repo boundaries. This prevents arbitrary file reads (CVSS ~7.5).
2. **Race condition in diff popover cache**: Added null guards in both `onFileItemMouseEnter` and `showDiffPopover` to handle the loading state marker. Prevents null-deref crashes when hovering files quickly or during re-renders.
3. **Unsafe array operation in tag-indexer.js**: Replaced `.pop()` with safe array indexing (`parts[parts.length - 1]`) and added empty array guard. Prevents crashes on edge cases with empty names.

All fixes validated: `npm run build` succeeded, all 346 tests passed. Used existing `isSafeSessionId` pattern as reference for path validation approach.
