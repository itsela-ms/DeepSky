# Efrat — History

## Project Context
DeepSky: Electron desktop app wrapping GitHub Copilot CLI. Vanilla JS, xterm.js, node-pty, Catppuccin themes.
Owner: Itay Sela. Repo: itsela-ms/DeepSky.

## Learnings

### v0.8.6 Brochure Verification (2026-03-19)
Verified brochure against CHANGELOG.md for v0.8.6 release. Found 2 issues:
1. **"Session Comments" label is incorrect** — CHANGELOG lists "Session notes" (plural) with multi-note system. Brochure says "Session Comments" (singular, old terminology).
2. **Info bar missing from interactive mock** — CHANGELOG 0.8.6 "Fixed" section mentions info bar fixes, but interactive preview doesn't show this UI element below terminal.

All other items verified:
- Download URL correct (v0.8.6)
- Button text correct (⬇ Download v0.8.6)
- Keyboard shortcuts complete (Ctrl+X cut, Ctrl+Shift+Home select all)
- File Diff Popovers listed in What's New
- macOS support mentioned
- No stale "comments" references (except the Session Comments label itself)
- Status panel switching possible via mock session list clicks
- No "old comments feature" references
