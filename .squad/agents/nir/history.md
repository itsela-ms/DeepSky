# Nir — History

## Project Context
DeepSky: Electron desktop app wrapping GitHub Copilot CLI. Vanilla JS, xterm.js, node-pty, Catppuccin themes.
Owner: Itay Sela. Repo: itsela-ms/DeepSky.

## Learnings
<!-- Append new learnings below -->

### 2026-03-19 — v0.8.6 Release Review
- **Scope:** 19 files changed (session notes, file diffs, keyboard shortcuts, tag filtering, CI updates)
- **Critical findings:** Path traversal in `file:getDiff` IPC (no validation), null-deref race in diff popover cache, unsafe `pop()` on empty array in tag filter
- **Positive:** Strong test coverage (72 new tests), clean migration path for notes, good template URL filtering
- **Decision:** HOLD release until criticals fixed
- **Pattern:** IPC handlers need consistent validation and error wrapping — renderer can send arbitrary data
