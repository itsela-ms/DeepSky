# Eden — History

## Project Context
DeepSky: Electron desktop app wrapping GitHub Copilot CLI. Vanilla JS, xterm.js, node-pty, Catppuccin themes.
Owner: Itay Sela. Repo: itsela-ms/DeepSky.

## Learnings
<!-- Append new learnings below -->

### 2026-03-19: v0.8.6 QA Validation
**Context:** First structured QA gate check for DeepSky release. Validated build, tests, version consistency, stale reference cleanup, and new feature code paths.

**Key Findings:**
- All 316 tests passed cleanly
- Version consistency across package.json, CHANGELOG.md, and brochure verified
- Old features (saveSessionComment, btn-check-update) properly removed
- New features (notes API, keyboard shortcuts, resource filtering, tag validation) all have code paths

**Process Improvements:**
- Established programmatic validation before manual checklist — catches regressions early
- Version consistency check across external brochure prevents documentation drift
- Stale reference search prevents dead code accumulation

**Result:** v0.8.6 passed all automated checks. Ready for manual validation checklist.
