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

### 2026-03-19 — Critical Fixes Review (v0.8.6 Unblock)
- **Reviewed:** Tomer's fixes for 3 critical issues blocking release
- **Results:** 2/3 approved (race condition, tag filter), 1 rejected (path traversal)
- **Path traversal issue:** `normalized.includes('..')` check happens AFTER `path.resolve()`, making it logically dead — `path.resolve()` already normalizes away `..` segments, so the check never triggers. Security relies entirely on git root validation (which works, but the misleading check is a maintenance hazard).
- **Race condition fix:** Solid defense-in-depth with null guards at both call site and function entry. Redundant `!cached || cached === null` check is harmless.
- **Tag filter fix:** Comprehensive edge case handling with proper guards for null match results and empty arrays.
- **Learning:** Security theater is worse than no check — if a check looks like it provides defense but is logically ineffective, it creates false confidence and confuses maintainers. Better to remove misleading checks or fix the logic order.
- **Decision:** BLOCKED release until path traversal fix is revised (check for `..` before `path.resolve()`, or remove the check and document reliance on git root validation)
