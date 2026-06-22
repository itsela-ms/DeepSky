import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/**
 * Regression tests for v1.2.x session context/status behavior:
 *
 *   1. Status indicator overhaul:
 *        - "Working → Waiting" transition is now driven by a per-session
 *          debounce timer that fires ~1.2 s after the last pty:data chunk,
 *          instead of the previous ~39 s polling decay.
 *        - "Pending PR" fires only when the latest assistant.message in
 *          events.jsonl contains a PR URL, via `session.lastAssistantHasPR`,
 *          instead of any historical PR resource in the session.
 *
 * Like the rest of the renderer wiring tests, this asserts against source
 * text — spinning up xterm + Electron in jsdom is impractical.
 */

const rendererPath = path.join(__dirname, '..', 'src', 'renderer.js');
const cssPath = path.join(__dirname, '..', 'src', 'styles.css');

const renderer = fs.readFileSync(rendererPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

describe('per-session debounce timer makes Working → Waiting near-instant', () => {
  it('declares a sessionBusyTimers Map and tuned constants', () => {
    expect(renderer).toMatch(/const sessionBusyTimers\s*=\s*new Map\(\)/);
    // The old "wait 30 s before even considering idle" threshold is gone
    expect(renderer).not.toMatch(/BUSY_THRESHOLD_MS\s*=\s*30000/);
    expect(renderer).toMatch(/BUSY_THRESHOLD_MS\s*=\s*1500/);
    // Debounce is at least 1500ms — long enough to absorb brief spinner
    // pauses without flicker.
    const m = renderer.match(/BUSY_DEBOUNCE_MS\s*=\s*(\d+)/);
    expect(m, 'BUSY_DEBOUNCE_MS must be declared').not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(1500);
  });

  it('markSessionBusy sets busy=true, resets any pending timer, and schedules a flip to Waiting', () => {
    const m = renderer.match(/function markSessionBusy[\s\S]*?\n\}/);
    expect(m, 'markSessionBusy body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/sessionBusyState\.set\(sessionId,\s*true\)/);
    expect(body).toMatch(/clearTimeout\(existing\)/);
    expect(body).toMatch(/setTimeout\([\s\S]*?BUSY_DEBOUNCE_MS\)/);
    // When the debounce fires, busy must flip to false and the badge must
    // be repainted so the user sees Working → Waiting immediately.
    expect(body).toMatch(/sessionBusyState\.set\(sessionId,\s*false\)/);
    expect(body).toMatch(/schedulePatchSessionStateBadges\(sessionId\)/);
  });

  it('clearSessionBusy clears the debounce timer + busy flag + idle counter together', () => {
    const m = renderer.match(/function clearSessionBusy[\s\S]*?\n\}/);
    expect(m, 'clearSessionBusy body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/sessionBusyTimers\.get\(sessionId\)/);
    expect(body).toMatch(/clearTimeout\(timer\)/);
    expect(body).toMatch(/sessionBusyTimers\.delete\(sessionId\)/);
    expect(body).toMatch(/sessionBusyState\.delete\(sessionId\)/);
    expect(body).toMatch(/sessionIdleCount\.delete\(sessionId\)/);
  });

  it('pty:data listener invokes markSessionBusy (not the bare sessionBusyState.set) and only on substantive chunks', () => {
    const m = renderer.match(/window\.api\.onPtyData\(\(sessionId, data\) => \{[\s\S]*?\}\)\)/);
    expect(m, 'onPtyData listener body must be findable').not.toBeNull();
    const body = m[0];
    // markSessionBusy must be gated by the chunk-substance filter so that
    // cursor blinks and idle redraws don't flicker the badge.
    expect(body).toMatch(/if\s*\(\s*chunkLooksLikeAgentActivity\(data\)\s*\)/);
    expect(body).toMatch(/markSessionBusy\(sessionId\)/);
    expect(body).not.toMatch(/sessionBusyState\.set\(sessionId,\s*true\)/);
  });

  it('pty:exit and pty:evicted handlers route through clearSessionBusy (no leaked timer)', () => {
    // pty:exit handler
    const exitM = renderer.match(/window\.api\.onPtyExit\([\s\S]*?\}\)\);/);
    expect(exitM, 'onPtyExit body must be findable').not.toBeNull();
    expect(exitM[0]).toMatch(/clearSessionBusy\(sessionId\)/);

    // pty:evicted handler
    const evictM = renderer.match(/window\.api\.onPtyEvicted\?\.\([\s\S]*?\}\);/);
    expect(evictM, 'onPtyEvicted body must be findable').not.toBeNull();
    expect(evictM[0]).toMatch(/clearSessionBusy\(sessionId\)/);
  });

  it('updateSessionBusyStates skips poll-based decay for sessions that have an active debounce timer (avoids racing the timer)', () => {
    const m = renderer.match(/async function updateSessionBusyStates[\s\S]*?\n\}/);
    expect(m, 'updateSessionBusyStates body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/sessionBusyTimers\.has\(s\.id\)/);
  });

  it('updateSessionBusyStates only decays known-busy sessions and never elevates a session it has already set to false (preserves the timer as the sole busy=true authority, with one bootstrap exception)', () => {
    const m = renderer.match(/async function updateSessionBusyStates[\s\S]*?\n\}/);
    expect(m, 'updateSessionBusyStates body must be findable').not.toBeNull();
    const body = m[0];
    // The old "recentOutput → busy=true unconditionally" branch is gone.
    expect(body).not.toMatch(/if\s*\(\s*recentOutput\s*\)\s*\{\s*\/\/[^\n]*\n\s*sessionBusyState\.set\(s\.id,\s*true\)/);
    // The bootstrap path is gated on "the renderer hasn't recorded this
    // session yet" so it only fires once when the renderer attaches to an
    // already-running session.
    expect(body).toMatch(/!wasKnown\s*&&\s*recentOutput/);
    // Decay still consults IDLE_GRACE_POLLS so a single quiet poll cycle
    // doesn't immediately demote a session to Waiting.
    expect(body).toMatch(/IDLE_GRACE_POLLS/);
  });

  // ------------------------------------------------------------------
  // Anti-flicker hysteresis (round 7).
  //
  // The user reported that the Working / Waiting badge would briefly
  // flash (~1s) green→yellow→green→yellow during sessions that were
  // mostly idle but occasionally produced a single stray status line.
  // We now (a) hold the Waiting badge for BUSY_HOLD_AFTER_WAITING_MS
  // after a transition before allowing a re-promotion to Working, and
  // (b) only schedule a badge DOM patch when the visual state actually
  // changes (every-chunk patching caused per-frame DOM churn on busy
  // sessions, contributing to the perceived lag).
  // ------------------------------------------------------------------

  it('declares BUSY_HOLD_AFTER_WAITING_MS hysteresis constant ≥ 2000ms', () => {
    const m = renderer.match(/BUSY_HOLD_AFTER_WAITING_MS\s*=\s*(\d+)/);
    expect(m, 'BUSY_HOLD_AFTER_WAITING_MS must be declared').not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(2000);
  });

  it('declares BUSY_HOLD_AFTER_WORKING_MS dwell constant ≥ 1500ms to prevent immediate flip-back-to-Waiting flicker', () => {
    const m = renderer.match(/BUSY_HOLD_AFTER_WORKING_MS\s*=\s*(\d+)/);
    expect(m, 'BUSY_HOLD_AFTER_WORKING_MS must be declared').not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(1500);
  });

  it('declares BUSY_RESIZE_SUPPRESS_MS so resize-induced CLI prompt redraws cannot promote a session to Working', () => {
    const m = renderer.match(/BUSY_RESIZE_SUPPRESS_MS\s*=\s*(\d+)/);
    expect(m, 'BUSY_RESIZE_SUPPRESS_MS must be declared').not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(1000);
  });

  it('exports trackedResizePty wrapper that stamps sessionResizeAt before forwarding to the IPC api', () => {
    const m = renderer.match(/function trackedResizePty\(sessionId, cols, rows\)[\s\S]*?\n\}/);
    expect(m, 'trackedResizePty must be declared').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/sessionResizeAt\.set\(sessionId,\s*Date\.now\(\)\)/);
    expect(body).toMatch(/window\.api\.resizePty\(sessionId, cols, rows\)/);
  });

  it('every call site of api.resizePty goes through trackedResizePty so resize-suppression is global', () => {
    // After the refactor, the only literal `window.api.resizePty(...)` call
    // in renderer.js should be the one *inside* trackedResizePty itself.
    // All other call sites must invoke trackedResizePty(...) instead.
    const matches = renderer.match(/window\.api\.resizePty\(/g) || [];
    expect(matches.length, 'exactly one literal api.resizePty call (inside trackedResizePty)').toBe(1);
    // And we should see at least 2 trackedResizePty call sites elsewhere
    // (xterm.onResize handler + switchToSession + sidebar-resize handler).
    const tracked = renderer.match(/trackedResizePty\(/g) || [];
    expect(tracked.length, 'multiple call sites for trackedResizePty').toBeGreaterThanOrEqual(3);
  });

  it('BUSY_DEBOUNCE_MS bumped to at least 5000ms so natural pauses inside a single response do not flap the badge', () => {
    const m = renderer.match(/BUSY_DEBOUNCE_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(5000);
  });

  it('markSessionBusy consults sessionBusyStateChangedAt and BUSY_HOLD_AFTER_WAITING_MS to suppress same-chunk re-promotion', () => {
    const m = renderer.match(/function markSessionBusy[\s\S]*?\n\}/);
    expect(m, 'markSessionBusy body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/sessionBusyStateChangedAt\.get\(sessionId\)/);
    expect(body).toMatch(/BUSY_HOLD_AFTER_WAITING_MS/);
    // The hysteresis branch must read wasBusy and short-circuit when
    // a recent Waiting transition is still inside the hold window.
    expect(body).toMatch(/wasBusy/);
  });

  it('markSessionBusy honors resize-suppression: chunks within BUSY_RESIZE_SUPPRESS_MS of a resize never promote to Working', () => {
    const m = renderer.match(/function markSessionBusy[\s\S]*?\n\}/);
    const body = m[0];
    expect(body).toMatch(/sessionResizeAt\.get\(sessionId\)/);
    expect(body).toMatch(/BUSY_RESIZE_SUPPRESS_MS/);
  });

  it('markSessionBusy debounce-timer callback respects BUSY_HOLD_AFTER_WORKING_MS dwell so Working never flashes for under the dwell time', () => {
    const m = renderer.match(/function markSessionBusy[\s\S]*?\n\}/);
    const body = m[0];
    // The setTimeout(BUSY_DEBOUNCE_MS) callback must check the dwell
    // constant before flipping busy=false.
    expect(body).toMatch(/BUSY_HOLD_AFTER_WORKING_MS/);
  });

  it('markSessionBusy stores the transition timestamp into sessionBusyStateChangedAt on every state flip path', () => {
    const m = renderer.match(/function markSessionBusy[\s\S]*?\n\}/);
    const body = m[0];
    // Three writes expected after the round-8 changes:
    //   1. Inside the dwell-deferred re-arm timer (delayed Working → Waiting)
    //   2. Inside the original debounce-timer callback (Working → Waiting)
    //   3. Below the hold gate when promoting Waiting → Working
    const writeMatches = body.match(/sessionBusyStateChangedAt\.set\(sessionId,/g) || [];
    expect(writeMatches.length, 'three sessionBusyStateChangedAt.set writes (one per transition path)').toBe(3);
  });

  it('clearSessionBusy also evicts sessionBusyStateChangedAt AND sessionResizeAt so dead sessions do not leak hysteresis state', () => {
    const m = renderer.match(/function clearSessionBusy[\s\S]*?\n\}/);
    const body = m[0];
    expect(body).toMatch(/sessionBusyStateChangedAt\.delete\(sessionId\)/);
    expect(body).toMatch(/sessionResizeAt\.delete\(sessionId\)/);
  });

  it('updateSessionBusyStates poll respects BUSY_HOLD_AFTER_WORKING_MS on idle-decay to prevent flicker from racing the debounce timer', () => {
    const m = renderer.match(/async function updateSessionBusyStates[\s\S]*?\n\}/);
    expect(m, 'updateSessionBusyStates body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/BUSY_HOLD_AFTER_WORKING_MS/);
    // And the bootstrap path must stamp the transition timestamp.
    expect(body).toMatch(/sessionBusyStateChangedAt\.set\(s\.id,/);
  });

  it('onPtyData listener no longer unconditionally calls schedulePatchSessionStateBadges on every chunk (only on alive transition)', () => {
    const m = renderer.match(/window\.api\.onPtyData\(\(sessionId, data\) => \{[\s\S]*?\}\)\)/);
    expect(m, 'onPtyData listener body must be findable').not.toBeNull();
    const body = m[0];
    // The unconditional bottom-of-function schedulePatch call is gone; we
    // now gate the patch on a wasAlive transition guard.
    expect(body).toMatch(/const wasAlive = sessionAliveState\.has\(sessionId\)/);
    expect(body).toMatch(/if\s*\(\s*!wasAlive\s*\)\s*schedulePatchSessionStateBadges\(sessionId\)/);
  });

  it('STATUS_POLL_MS is at least 5000ms to reduce per-tick IPC + DOM cost on the sidebar', () => {
    const m = renderer.match(/STATUS_POLL_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(5000);
  });
});

describe('chunkLooksLikeAgentActivity filters ambient pty noise', () => {
  // Pull the helper out of the renderer source as standalone JS so we can
  // exercise it in isolation. The renderer module itself depends on xterm
  // + Electron globals that are painful to mock; the helper is a pure
  // function so we can lift its source out for unit testing.
  const ansiSrc = renderer.match(/const ANSI_ESCAPE_RE\s*=\s*\/[^;]*;/);
  const minSrc = renderer.match(/const BUSY_MIN_PRINTABLE_CHARS\s*=\s*\d+;/);
  const fnSrc = renderer.match(/function chunkLooksLikeAgentActivity\([\s\S]*?\n\}/);
  let chunkLooksLikeAgentActivity;
  if (ansiSrc && minSrc && fnSrc) {
    // eslint-disable-next-line no-new-func
    chunkLooksLikeAgentActivity = new Function(`${ansiSrc[0]}\n${minSrc[0]}\n${fnSrc[0]}\nreturn chunkLooksLikeAgentActivity;`)();
  }

  it('parses out of renderer source', () => {
    expect(chunkLooksLikeAgentActivity, 'helper must be liftable from renderer.js').toBeTypeOf('function');
  });

  it('returns false for empty / nullish chunks', () => {
    expect(chunkLooksLikeAgentActivity('')).toBe(false);
    expect(chunkLooksLikeAgentActivity(null)).toBe(false);
    expect(chunkLooksLikeAgentActivity(undefined)).toBe(false);
  });

  it('returns false for a bare cursor-blink ANSI sequence', () => {
    // Just hide/show cursor — pure ambient redraw.
    expect(chunkLooksLikeAgentActivity('\x1b[?25l\x1b[?25h')).toBe(false);
  });

  it('returns false for a clear-line + carriage-return idle redraw with no text', () => {
    expect(chunkLooksLikeAgentActivity('\x1b[2K\r')).toBe(false);
  });

  it('returns false for a 1–2 char keystroke echo', () => {
    expect(chunkLooksLikeAgentActivity('h')).toBe(false);
    expect(chunkLooksLikeAgentActivity('hi')).toBe(false);
  });

  it('returns true for a spinner frame that carries a status line', () => {
    // Real copilot CLI spinner: cursor move + glyph + " Reasoning..."
    expect(chunkLooksLikeAgentActivity('\x1b[2K\r⠋ Reasoning...')).toBe(true);
  });

  it('returns true for a streamed assistant response chunk', () => {
    expect(chunkLooksLikeAgentActivity('I think the answer is to refactor the helper')).toBe(true);
  });

  it('returns true for colored ANSI text with at least a few printable chars', () => {
    expect(chunkLooksLikeAgentActivity('\x1b[32mDone!\x1b[0m')).toBe(false); // "Done!" = 5 chars, just under
    expect(chunkLooksLikeAgentActivity('\x1b[32mFinished\x1b[0m')).toBe(true);
  });

  it('handles Buffer input by coercing to string', () => {
    const buf = Buffer.from('Reasoning about edge cases');
    expect(chunkLooksLikeAgentActivity(buf)).toBe(true);
  });
});

describe('folder icon uses inline SVG instead of the folder emoji', () => {
  it('session card renders the cwd button with an SVG, not 📂', () => {
    // The card render block: find the cwdHtml line.
    const m = renderer.match(/cwdHtml\s*=\s*`[^`]*`/);
    expect(m, 'cwdHtml assignment must be findable').not.toBeNull();
    const tpl = m[0];
    expect(tpl).toMatch(/<svg/);
    expect(tpl).toMatch(/session-cwd-icon/);
    expect(tpl).not.toMatch(/📂/);
  });

  it('marks active-list session cards so their cwd affordance can be more visible', () => {
    expect(renderer).toMatch(/currentSidebarTab\s*===\s*'active'[\s\S]{0,80}el\.classList\.add\('active-list-item'\)/);
  });

  it('CSS sizes the SVG, keeps history subtle, and colorizes active-list cwd icon outlines', () => {
    expect(css).toMatch(/\.session-cwd-icon\s*\{[\s\S]*?width:\s*1[1-4]px/);
    expect(css).toMatch(/\.session-cwd\s*\{[\s\S]*?color:\s*var\(--text-dim\)/);
    // Default opacity should be subtle (< 0.6) so the icon doesn't dominate.
    const m = css.match(/\.session-cwd\s*\{[\s\S]*?opacity:\s*0?\.(\d+)/);
    expect(m, 'session-cwd opacity rule must be findable').not.toBeNull();
    const opacity = Number('0.' + m[1]);
    expect(opacity).toBeLessThan(0.6);

    const activeRule = css.match(/\.session-item\.active-list-item \.session-cwd\s*\{[\s\S]*?\}/);
    expect(activeRule, 'active-list cwd styling must be findable').not.toBeNull();
    expect(activeRule[0]).toMatch(/color:\s*var\(--yellow\)/);
    expect(activeRule[0]).toMatch(/background:\s*none/);
    expect(activeRule[0]).toMatch(/border-color:\s*transparent/);
    const activeOpacity = activeRule[0].match(/opacity:\s*0?\.(\d+)/);
    expect(activeOpacity, 'active-list cwd opacity rule must be findable').not.toBeNull();
    expect(Number('0.' + activeOpacity[1])).toBeGreaterThanOrEqual(0.8);

    const activeFocusRule = css.match(/\.session-item\.active-list-item \.session-cwd:focus-visible\s*\{[\s\S]*?\}/);
    expect(activeFocusRule, 'active-list cwd focus styling must be findable').not.toBeNull();
    expect(activeFocusRule[0]).toMatch(/background:\s*none/);
    expect(activeFocusRule[0]).toMatch(/border-color:\s*transparent/);
    expect(activeFocusRule[0]).toMatch(/box-shadow:\s*none/);
  });
});

describe('Pending PR fires only for the latest assistant.message', () => {
  it('sidebar render uses session.lastAssistantHasPR (no resource-history scan)', () => {
    // The card render block: must consult the per-session boolean, NOT
    // session.resources.some(r => r.type === 'pr' ...).
    const m = renderer.match(/function renderSessionItem\([\s\S]*?\n\}/) ||
              renderer.match(/const isRunning = sessionAliveState\.has\(session\.id\);[\s\S]{0,400}deriveSessionState/);
    expect(m, 'session card render must be findable').not.toBeNull();
    expect(m[0]).toMatch(/session\.lastAssistantHasPR\s*===\s*true/);
  });

  it('patchSessionStateBadges and patchSessionStateBadgeForId both use lastAssistantHasPR', () => {
    const full = renderer.match(/function patchSessionStateBadges\(\)[\s\S]*?\n\}/);
    const one = renderer.match(/function patchSessionStateBadgeForId\([\s\S]*?\n\}/);
    expect(full, 'patchSessionStateBadges body must be findable').not.toBeNull();
    expect(one, 'patchSessionStateBadgeForId body must be findable').not.toBeNull();
    expect(full[0]).toMatch(/session\.lastAssistantHasPR\s*===\s*true/);
    expect(one[0]).toMatch(/session\.lastAssistantHasPR\s*===\s*true/);
  });

  it('renderer no longer references the old "any PR in resources" pattern for the status badge', () => {
    // The deprecated derivation looked like:
    //   session.resources && session.resources.some(r => r.type === 'pr' && ...)
    // — this should be gone from the badge-state derivation paths.
    expect(renderer).not.toMatch(/resources\.some\(r\s*=>\s*r\.type\s*===\s*['"]pr['"]\s*&&/);
  });
});

describe('SESSION CONTEXT bar has a fixed (not min-) height so fit() stays correct', () => {
  // Bug: when the bar was `min-height: 28px` it grew after prompt population.
  // fitAddon.fit() runs on
  // session switch BEFORE scheduleSessionPromptGhostRefresh populates the
  // bar — so the terminal viewport was computed against a 28px bar but the
  // actual rendered bar took ~32px, hiding the bottom row(s) of output
  // behind it. The user could not scroll to the very end of an agent reply.
  it('css pins .terminal-prompt-ghost to a fixed height (not min-height)', () => {
    const m = css.match(/\.terminal-prompt-ghost\s*\{[\s\S]*?\n\}/);
    expect(m, '.terminal-prompt-ghost rule must be findable').not.toBeNull();
    const body = m[0];
    expect(body, '.terminal-prompt-ghost must not use min-height (it grows when populated, breaking fit())').not.toMatch(/min-height\s*:/);
    expect(body).toMatch(/\bheight\s*:\s*32px\b/);
    // box-sizing: border-box keeps the 32px inclusive of padding so the
    // total layout footprint matches what fit() measured.
    expect(body).toMatch(/box-sizing\s*:\s*border-box/);
  });
});

describe('sidebar render skips destructive rebuild when nothing visible changed (anti-flicker)', () => {
  // Bug: pollSessionStatus runs every 3s and called refreshSessionList →
  // scheduleRenderSessionList → renderSessionList which did
  // `sessionList.innerHTML = ''` and rebuilt every card from scratch. The
  // result was a visible sidebar "blink" every 3 seconds. Now renderSessionList
  // computes a fingerprint of the visible state and short-circuits when it
  // matches the last render. Status badges + .running + active highlight are
  // still patched in place so they stay real-time.
  it('renderer declares a sidebar fingerprint cache var', () => {
    expect(renderer).toMatch(/let\s+_lastSidebarFingerprint\s*=\s*null/);
  });

  it('computeSidebarFingerprint depends on tab + search + sidebarCollapsed + groups + per-session visual state', () => {
    const m = renderer.match(/function computeSidebarFingerprint\([\s\S]*?\n\}/);
    expect(m, 'computeSidebarFingerprint body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/currentSidebarTab\b/);
    expect(body).toMatch(/searchQuery\b/);
    expect(body).toMatch(/sidebarCollapsed\b/);
    expect(body).toMatch(/historyShowsAll\b/);
    expect(body).toMatch(/tabGroups\b/);
    // per-item: id, title, lastAssistantHasPR (Pending PR badge), tags, resources
    expect(body).toMatch(/s\.id\b/);
    expect(body).toMatch(/s\.title\b/);
    expect(body).toMatch(/s\.lastAssistantHasPR\b/);
    expect(body).toMatch(/s\.tags\b/);
    expect(body).toMatch(/s\.resources\b/);
  });

  it('renderSessionList short-circuits when the fingerprint is unchanged, but still patches badges + active highlight', () => {
    const m = renderer.match(/function renderSessionList\([\s\S]*?sessionList\.innerHTML\s*=\s*['"]['"]/);
    expect(m, 'renderSessionList early-return + clear-line must be findable').not.toBeNull();
    const body = m[0];
    // Compute the fingerprint after `displayed` is built
    expect(body).toMatch(/computeSidebarFingerprint\(displayed\)/);
    // Compare against the cached value
    expect(body).toMatch(/_lastSidebarFingerprint\b/);
    // The short-circuit branch must still patch in-place so status stays
    // real-time even when we skip the rebuild.
    expect(body).toMatch(/patchActiveHighlight/);
    expect(body).toMatch(/patchSessionStateBadges/);
  });

  it('patchSessionStateBadges keeps the .running class in sync (since the rebuild path is now skipped on aliveness-only changes)', () => {
    const m = renderer.match(/function patchSessionStateBadges\(\)[\s\S]*?\n\}/);
    expect(m, 'patchSessionStateBadges body must be findable').not.toBeNull();
    const body = m[0];
    // Must add .running when isRunning is true and the class is missing
    expect(body).toMatch(/isRunning\s*&&\s*!el\.classList\.contains\(['"]running['"]\)/);
    // Must remove .running when isRunning is false
    expect(body).toMatch(/!isRunning\s*&&\s*el\.classList\.contains\(['"]running['"]\)/);
  });

  it('patchSessionStateBadgeForId also patches .running (same reasoning, per-id path)', () => {
    const m = renderer.match(/function patchSessionStateBadgeForId\([\s\S]*?\n\}/);
    expect(m, 'patchSessionStateBadgeForId body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/isRunning\s*&&\s*!el\.classList\.contains\(['"]running['"]\)/);
    expect(body).toMatch(/!isRunning\s*&&\s*el\.classList\.contains\(['"]running['"]\)/);
  });
});

describe('session switch is a single repaint (no double viewport sync)', () => {
  // Bug: switchToSession ran syncTerminalViewport(currentId) AND
  // scheduleTerminalViewportSync(currentId, ...) back-to-back. The first ran
  // immediately, the second ran ~20ms later in a queued rAF, producing a
  // visible double-paint flicker on every session switch (xterm canvas blink,
  // scrollbar jump, input box twitch). Keep only the scheduled one — it
  // already handles refreshSearch and runs in the next frame so the user
  // sees a single repaint.
  it('switchToSession does NOT call syncTerminalViewport synchronously alongside scheduleTerminalViewportSync', () => {
    const m = renderer.match(/function switchToSession\(sessionId\)[\s\S]*?\n\}/);
    expect(m, 'switchToSession body must be findable').not.toBeNull();
    const body = m[0];
    // The scheduled sync stays — that's the one repaint we want.
    expect(body).toMatch(/scheduleTerminalViewportSync\(currentId,\s*\{\s*refreshSearch:\s*true\s*\}\)/);
    // The redundant synchronous call must be gone.
    expect(body).not.toMatch(/^\s*syncTerminalViewport\(currentId\)\s*;/m);
  });
});

describe('side dot mirrors WORKING/WAITING status (green vs yellow), not just alive/dead', () => {
  // Bug: the `.session-item.running::after` dot was always green when a
  // session was alive, which made it meaningless — you couldn't tell from
  // the dot alone whether an agent was actively reasoning or sitting idle.
  // Now the dot reads from the same busy flag as the WORKING/WAITING badge:
  //   - .running.busy   → green (Working — agent is reasoning)
  //   - .running        → yellow (Waiting — agent is alive but idle)
  //   - (not .running)  → no dot (session is dead / history)
  // This makes the narrow-sidebar mode (where the badge text is clipped)
  // actually useful.
  it('CSS defaults .running::after to yellow and overrides to green only when .busy is also present', () => {
    // Default running state = yellow (Waiting)
    const yellowRule = css.match(/\.session-item\.running::after\s*\{[\s\S]*?\n\}/);
    expect(yellowRule, '.session-item.running::after rule must be findable').not.toBeNull();
    expect(yellowRule[0]).toMatch(/background\s*:\s*var\(--yellow\)/);
    expect(yellowRule[0]).toMatch(/box-shadow\s*:[^;]*var\(--yellow\)/);

    // .busy override = green (Working)
    const greenRule = css.match(/\.session-item\.running\.busy::after\s*\{[\s\S]*?\n\}/);
    expect(greenRule, '.session-item.running.busy::after override must be findable').not.toBeNull();
    expect(greenRule[0]).toMatch(/background\s*:\s*var\(--green\)/);
    expect(greenRule[0]).toMatch(/box-shadow\s*:[^;]*var\(--green\)/);
  });

  it('collapsed-sidebar dot un-hides and uses vivid (non-pastel) colors so green/yellow are distinguishable', () => {
    // Base rule hides the dot (display: none) so the expanded sidebar's
    // text pill is not duplicated; the collapsed override flips it back on.
    const m = css.match(/#sidebar\.collapsed \.session-item\.running::after\s*\{[\s\S]*?\n\}/);
    expect(m, 'collapsed-sidebar dot un-hide rule must be findable').not.toBeNull();
    const rule = m[0];
    expect(rule).toMatch(/display\s*:\s*block/);
    // Color must NOT be the pastel var(--yellow) — those are too close to
    // var(--green) in luminosity at 7px. Use an explicit saturated hex.
    expect(rule).not.toMatch(/background\s*:\s*var\(--yellow\)/);
    expect(rule).toMatch(/background\s*:\s*#[0-9a-fA-F]{3,6}/);

    // Busy override likewise uses a vivid hex green, not var(--green).
    const busy = css.match(/#sidebar\.collapsed \.session-item\.running\.busy::after\s*\{[\s\S]*?\n\}/);
    expect(busy, 'collapsed busy dot override must be findable').not.toBeNull();
    expect(busy[0]).not.toMatch(/background\s*:\s*var\(--green\)/);
    expect(busy[0]).toMatch(/background\s*:\s*#[0-9a-fA-F]{3,6}/);
  });

  it('createSessionItem applies the .busy class on initial render when sessionBusyState is true', () => {
    const m = renderer.match(/function createSessionItem\([\s\S]*?\n\}/);
    expect(m, 'createSessionItem body must be findable').not.toBeNull();
    const body = m[0];
    // The .running class is applied when alive (pre-existing); now the .busy
    // class should be applied alongside it when the busy flag is set.
    expect(body).toMatch(/sessionBusyState\.get\(session\.id\)\s*===\s*true[\s\S]{0,40}classList\.add\(['"]busy['"]\)/);
  });

  it('patchSessionStateBadges keeps .busy in sync (add when running+busy, remove otherwise)', () => {
    const m = renderer.match(/function patchSessionStateBadges\(\)[\s\S]*?\n\}/);
    expect(m, 'patchSessionStateBadges body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/isRunning\s*&&\s*isBusy\s*&&\s*!el\.classList\.contains\(['"]busy['"]\)/);
    expect(body).toMatch(/\(\s*!isRunning\s*\|\|\s*!isBusy\s*\)\s*&&\s*el\.classList\.contains\(['"]busy['"]\)/);
  });

  it('patchSessionStateBadgeForId also patches .busy (per-id path used by debounce timer)', () => {
    const m = renderer.match(/function patchSessionStateBadgeForId\([\s\S]*?\n\}/);
    expect(m, 'patchSessionStateBadgeForId body must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/isRunning\s*&&\s*isBusy\s*&&\s*!el\.classList\.contains\(['"]busy['"]\)/);
    expect(body).toMatch(/\(\s*!isRunning\s*\|\|\s*!isBusy\s*\)\s*&&\s*el\.classList\.contains\(['"]busy['"]\)/);
  });
});

describe('per-session red unread-notification badge removed (was noisy / not actionable)', () => {
  // Bug: the sidebar showed a red dot with a number on every session card
  // for unread notifications. Notifications fire on every session exit, so
  // the badge accumulated permanently until the user opened the bell menu
  // and clicked "mark all read". The global notification badge on the gear
  // icon already shows total unread, so the per-session badge was pure
  // duplication and noise.
  it('renderSessionList no longer enriches cards with .session-notification-badge', () => {
    expect(renderer).not.toMatch(/className\s*=\s*['"]session-notification-badge['"]/);
    expect(renderer).not.toMatch(/\.session-notification-badge/);
  });

  it('CSS rule for .session-notification-badge is removed', () => {
    expect(css).not.toMatch(/\.session-notification-badge\s*\{/);
  });

  it('the collapsed-sidebar hide rule for the badge is also cleaned up', () => {
    expect(css).not.toMatch(/#sidebar\.collapsed[\s\S]*?\.session-notification-badge/);
  });
});
