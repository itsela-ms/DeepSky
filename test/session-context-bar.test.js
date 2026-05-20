import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/**
 * Regression tests for two related v1.2.x improvements:
 *
 *   1. Copy-last-prompt button in the SESSION CONTEXT bar
 *      (`#terminal-prompt-ghost`).
 *   2. Status indicator overhaul:
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
const preloadPath = path.join(__dirname, '..', 'src', 'preload.js');
const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const cssPath = path.join(__dirname, '..', 'src', 'styles.css');
const indexHtmlPath = path.join(__dirname, '..', 'src', 'index.html');

const renderer = fs.readFileSync(rendererPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const main = fs.readFileSync(mainPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

describe('copy-last-prompt button in the SESSION CONTEXT bar', () => {
  it('IPC accepts a { full } option for getLastUserPrompt end-to-end', () => {
    // preload forwards the options argument
    expect(preload).toMatch(
      /getLastUserPrompt:\s*\(sessionId,\s*options\)\s*=>\s*ipcRenderer\.invoke\(['"]session:getLastUserPrompt['"],\s*sessionId,\s*options\)/
    );
    // main accepts and forwards the options argument
    expect(main).toMatch(
      /ipcMain\.handle\(\s*['"]session:getLastUserPrompt['"][\s\S]*?async\s*\(event,\s*sessionId,\s*options\)[\s\S]*?sessionService\.getLastUserPrompt\(sessionId,\s*options\)/
    );
  });

  it('updateSessionPromptGhost renders a .prompt-copy-btn with a data-session-id', () => {
    const m = renderer.match(/function updateSessionPromptGhost[\s\S]*?\n\}/);
    expect(m, 'updateSessionPromptGhost body must be findable').not.toBeNull();
    const body = m[0];
    // The button is rendered into the prompt-ghost innerHTML
    expect(body).toMatch(/prompt-copy-btn/);
    // The session id is captured at render time (rubber-duck: avoid copying
    // the wrong session if activeSessionId changes between render and click)
    expect(body).toMatch(/data-session-id=["']?\$\{(?:esc\()?sessionId/);
    // Button is only shown when there's actually a lastPrompt to copy
    const promptBranchIdx = body.indexOf('if (lastPrompt)');
    const copyBtnIdx = body.indexOf('prompt-copy-btn');
    expect(promptBranchIdx).toBeGreaterThan(-1);
    expect(copyBtnIdx).toBeGreaterThan(promptBranchIdx);
  });

  it('wires the copy click via event delegation on the stable prompt-ghost parent', () => {
    // Event delegation is required because innerHTML is rewritten on every
    // ghost update, so a direct listener would be wiped.
    expect(renderer).toMatch(
      /terminalPromptGhost\.addEventListener\(['"]click['"][\s\S]*?\.closest\(['"]\.prompt-copy-btn['"]\)/
    );
  });

  it('copy handler reads sessionId from the button (not activeSessionId) and calls copyText with the full prompt', () => {
    const m = renderer.match(/terminalPromptGhost\.addEventListener\(['"]click['"][\s\S]*?\n\s*\}\);/);
    expect(m, 'click delegation handler must be findable').not.toBeNull();
    const body = m[0];
    expect(body).toMatch(/btn\.dataset\.sessionId/);
    expect(body).toMatch(/getLastUserPrompt\(sessionId,\s*\{\s*full:\s*true\s*\}\)/);
    expect(body).toMatch(/copyText\(/);
    // The handler should not blindly read activeSessionId — that's the
    // exact race we're guarding against.
    expect(body).not.toMatch(/activeSessionId\b/);
  });

  it('prompt-ghost is no longer aria-hidden (now contains an interactive button)', () => {
    // Earlier the bar was aria-hidden="true" because it was purely
    // decorative; adding an interactive button means it must be exposed.
    expect(indexHtml).toMatch(/id="terminal-prompt-ghost" class="terminal-prompt-ghost"\s*>/);
    expect(indexHtml).not.toMatch(/id="terminal-prompt-ghost"[^>]*aria-hidden=/);
  });

  it('CSS defines a .prompt-copy-btn inside the prompt-ghost with hover/focus/copied states', () => {
    expect(css).toMatch(/\.terminal-prompt-ghost\s+\.prompt-copy-btn\s*\{/);
    expect(css).toMatch(/\.terminal-prompt-ghost\s+\.prompt-copy-btn:hover/);
    expect(css).toMatch(/\.terminal-prompt-ghost\s+\.prompt-copy-btn:focus-visible/);
    expect(css).toMatch(/\.terminal-prompt-ghost\s+\.prompt-copy-btn\.copied/);
  });
});

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

describe('folder icon uses inline monochrome SVG (not the yellow 📂 emoji)', () => {
  it('session card renders the cwd button with an SVG, not 📂', () => {
    // The card render block: find the cwdHtml line.
    const m = renderer.match(/cwdHtml\s*=\s*`[^`]*`/);
    expect(m, 'cwdHtml assignment must be findable').not.toBeNull();
    const tpl = m[0];
    expect(tpl).toMatch(/<svg/);
    expect(tpl).toMatch(/session-cwd-icon/);
    expect(tpl).not.toMatch(/📂/);
  });

  it('CSS sizes the SVG and uses currentColor on a dim default', () => {
    expect(css).toMatch(/\.session-cwd-icon\s*\{[\s\S]*?width:\s*1[1-4]px/);
    expect(css).toMatch(/\.session-cwd\s*\{[\s\S]*?color:\s*var\(--text-dim\)/);
    // Default opacity should be subtle (< 0.6) so the icon doesn't dominate.
    const m = css.match(/\.session-cwd\s*\{[\s\S]*?opacity:\s*0?\.(\d+)/);
    expect(m, 'session-cwd opacity rule must be findable').not.toBeNull();
    const opacity = Number('0.' + m[1]);
    expect(opacity).toBeLessThan(0.6);
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
