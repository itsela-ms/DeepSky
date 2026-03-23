# Tomer — History

## Project Context
DeepSky: Electron desktop app wrapping GitHub Copilot CLI. Vanilla JS, xterm.js, node-pty, Catppuccin themes.
Owner: Itay Sela. Repo: itsela-ms/DeepSky.

## Learnings
<!-- Append new learnings below -->

### 2026-03-19: Beta channel & auto-update opt-out implementation
Implemented backend for user-controlled update preferences. Added two settings (`autoUpdateEnabled`, `updateChannel`) to `settings-service.js`. Refactored `update-service.js` to accept `settingsService` in constructor and configure `electron-updater` based on user preferences. Key learnings:

1. **Settings-driven configuration**: Used existing settings service rather than environment variables — keeps all user preferences in one place and makes them runtime-configurable.

2. **Live application without restart**: Added `applySettings()` method that allows frontend to change update behavior immediately (stop/start timer, update electron-updater flags). This is critical for good UX — users shouldn't need to restart to disable updates.

3. **Safe defaults preserve existing behavior**: Both new settings default to current behavior (auto-update enabled, stable channel) — zero breaking changes for existing users.

4. **Multiple defense layers for opt-out**: When `autoUpdateEnabled = false`, we return early from `checkOnStartup()`, skip checks in periodic timer, AND call `dispose()` when settings are applied. Belt-and-suspenders approach ensures no surprise checks.

5. **GitHub release detection pattern**: Used `contains(github.ref_name, 'beta')` in workflow — simple, flexible, and follows semantic versioning conventions (e.g., `v0.9.0-beta.1`).

All changes validated: `npm run build` succeeded, all 338 tests passed. Frontend team (Ziv) needs to implement UI controls for these settings.

### 2026-03-19: Critical security and stability fixes (v0.8.6)
Fixed 3 critical issues from Nir's code review:
1. **Path traversal vulnerability in `file:getDiff`**: Added path validation using `path.resolve()` to normalize paths, reject `..` traversal attempts, and verify files are within git repo boundaries. This prevents arbitrary file reads (CVSS ~7.5).
2. **Race condition in diff popover cache**: Added null guards in both `onFileItemMouseEnter` and `showDiffPopover` to handle the loading state marker. Prevents null-deref crashes when hovering files quickly or during re-renders.
3. **Unsafe array operation in tag-indexer.js**: Replaced `.pop()` with safe array indexing (`parts[parts.length - 1]`) and added empty array guard. Prevents crashes on edge cases with empty names.

All fixes validated: `npm run build` succeeded, all 346 tests passed. Used existing `isSafeSessionId` pattern as reference for path validation approach.
