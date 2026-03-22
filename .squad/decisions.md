# Decisions

<!-- Append-only. Scribe merges from .squad/decisions/inbox/ -->

## 2026-03-19: v0.8.6 QA Validation → PASS

**Agents:** Eden (QA), George (Tester), Nir (Code Review), Tomer (Backend)

### QA Validation Report (Eden)

✅ **PASS** — All validation checks passed. v0.8.6 ready for release gate.

**Key Results:**
- Build: ✅ `npm run build` (545.7kb, 82ms)
- Tests: ✅ 346/346 passed (21 test files, 1.76s)
- Version Consistency: ✅ All refs aligned (package.json, CHANGELOG, brochure)
- Stale References: ✅ Cleaned (saveSessionComment, btn-check-update, old CSS)
- New Feature Code Paths: ✅ Notes API, keyboard shortcuts, resource filtering, tag validation

### Test Coverage Enhancement (George)

**Coverage Gaps Identified & Fixed:**
- Added 30 new tests (316→346)
  - `test/tag-indexer.test.js` (10 tests): `isValidRepoTag` validation
  - `test/resource-filter.test.js` (20 tests): `sanitizeUrl`, `isTemplateUrl`
- Gaps before: `sanitizeUrl`, `isTemplateUrl`, `isValidRepoTag` had no direct unit tests
- Pattern: Utility functions now have comprehensive coverage

### Code Review — HOLD → FIXED (Nir → Tomer)

**Critical Issues Found (Nir):**
1. Path traversal vulnerability in `file:getDiff` — no validation on `filePath` from renderer
2. Race condition in diff popover cache — async fetch → null-deref
3. Unsafe `pop()` in tag filter — crashes on empty array

**Decision:** HOLD release until critical issues fixed.

**Fixes Applied (Tomer):**
1. **Path Traversal** (`src/main.js`): Added `path.resolve()`, `..` check, repository boundary validation
2. **Race Condition** (`src/renderer.js`): Explicit null checks in `onFileItemMouseEnter` & `showDiffPopover`
3. **Array Safety** (`src/tag-indexer.js`): Replaced `.pop()` with safe indexing, empty array guard

**Validation:**
- ✅ `npm run build` (545.7kb, 145ms)
- ✅ `npm test` (346/346 passed, 1.88s)
- ✅ No new warnings/errors

**Status:** Ready for final approval & release.

---
