# Beta Channel & Auto-Update Opt-Out Implementation

**Date:** 2026-03-19  
**Agent:** Tomer (Backend Dev)  
**Requested by:** Itay Sela

## Problem
DeepSky needed a way to let users:
1. Opt-in to beta releases (for early testing)
2. Disable auto-updates entirely (for controlled environments)

## Solution
Implemented two new settings managed by backend:

### 1. Settings Service (`settings-service.js`)
Added two defaults:
- `autoUpdateEnabled: true` — Controls whether update checks/downloads happen
- `updateChannel: 'stable'` — Options: 'stable' | 'beta'

### 2. Update Service (`update-service.js`)
Major refactor to make the service settings-aware:

**Constructor changes:**
- Now accepts `settingsService` as second parameter
- Reads settings on init to configure `electron-updater`
- Sets `allowPrerelease`, `autoDownload`, and `autoInstallOnAppQuit` based on user preferences

**Runtime behavior:**
- `checkOnStartup()` respects `autoUpdateEnabled` — bails early if disabled
- `_startPeriodicCheck()` checks `autoUpdateEnabled` before each interval check
- New `applySettings()` method applies setting changes live without restart:
  - Updates `electron-updater` flags
  - Stops timer if updates disabled, starts timer if re-enabled
  - Resets status to `idle` when disabling

**New IPC:**
- `update:applySettings` — Frontend calls this after changing settings

### 3. Main Process (`main.js`)
- Updated `UpdateService` instantiation to pass `settingsService`

### 4. Preload (`preload.js`)
- Added `applyUpdateSettings()` to the exposed API

### 5. CI/CD (`.github/workflows/build.yml`)
- Added `prerelease: ${{ contains(github.ref_name, 'beta') }}` to release job
- Any tag with "beta" in the name (e.g., `v0.9.0-beta.1`) will be marked as prerelease
- Stable releases won't see beta updates unless they opt-in

## Key Decisions

1. **Settings-driven, not flag-driven**: Used existing settings service rather than env vars or CLI flags — consistent with DeepSky's config approach

2. **Live application without restart**: `applySettings()` method allows frontend to change update behavior immediately (stop/start timer, update flags)

3. **Safe defaults**: Both settings default to current behavior (auto-update enabled, stable channel) — no breaking changes for existing users

4. **Fail-safe on disable**: When `autoUpdateEnabled = false`, we:
   - Return early from `checkOnStartup()`
   - Skip checks in periodic timer
   - Call `dispose()` when settings are applied to stop the timer completely

5. **GitHub release detection**: Used `contains(github.ref_name, 'beta')` in workflow — simple, flexible, and follows semantic versioning conventions

## Validation
- ✅ `npm run build` — Succeeded
- ✅ `npm test` — All 338 tests passed

## Files Modified
1. `src/settings-service.js` — Added two new defaults
2. `src/update-service.js` — Refactored for settings awareness, added `applySettings()`
3. `src/main.js` — Passed `settingsService` to `UpdateService` constructor
4. `src/preload.js` — Exposed `applyUpdateSettings()` IPC
5. `.github/workflows/build.yml` — Added `prerelease` detection

## Impact
- Frontend team (Ziv) needs to implement UI controls for these settings
- Users on beta channel will see prereleases; stable users won't
- Users can now disable auto-updates for compliance/airgap scenarios
