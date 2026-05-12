/**
 * Source-level guardrail tests.
 *
 * These tests do NOT exercise behavior at runtime — they read the relevant
 * source files and assert that the *shape* of the code preserves two fixes
 * that have already regressed once before:
 *
 *   1. Terminal links open exactly once and the hover cursor stays a pointer
 *      (PR #5 / commit 92bd9bc, restored in PR #9). The Copilot CLI is the
 *      sole link opener; WebLinksAddon must remain loaded for the hover
 *      decoration but its click handler MUST be a no-op.
 *
 *   2. Letter shortcuts work on non-Latin keyboard layouts (PR #9). Letter
 *      shortcut handlers must resolve the logical key from the physical
 *      `e.code` (via `getShortcutKey`), never compare `e.key` to a Latin
 *      letter directly.
 *
 * If you fail one of these tests, do NOT just edit the test — read the comment
 * on the line being checked first. There is almost certainly a UX bug behind
 * the change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const RENDERER_SRC = readFileSync(join(ROOT, 'src', 'renderer.js'), 'utf8');
const SHORTCUTS_SRC = readFileSync(join(ROOT, 'src', 'keyboard-shortcuts.js'), 'utf8');
const MAIN_SRC = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// Terminal link handling — double-open + hover-cursor regression guard
// ───────────────────────────────────────────────────────────────────────────

describe('terminal link handling — regression guardrails', () => {
  it('keeps WebLinksAddon loaded so URLs are decorated and the hover cursor is a pointer', () => {
    expect(RENDERER_SRC).toMatch(/new WebLinksAddon\(/);
  });

  it('passes a no-op handler to WebLinksAddon so links do not open twice', () => {
    // The Copilot CLI emits OSC 8 hyperlinks and opens links itself on click.
    // Any non-empty handler here re-introduces the double-open regression.
    const noopForms = [
      /new WebLinksAddon\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,         // () => {}
      /new WebLinksAddon\(\s*\(\s*\)\s*=>\s*undefined\s*\)/,       // () => undefined
      /new WebLinksAddon\(\s*\(\s*_?e?\s*,?\s*_?uri?\s*\)\s*=>\s*\{\s*\}\s*\)/, // (e, uri) => {}
    ];
    const matched = noopForms.some(rx => rx.test(RENDERER_SRC));
    expect(matched, 'WebLinksAddon must be constructed with a no-op handler').toBe(true);
  });

  it('does NOT call openExternal from inside the WebLinksAddon constructor', () => {
    const lines = RENDERER_SRC.split(/\r?\n/);
    const idx = lines.findIndex(l => l.includes('new WebLinksAddon('));
    expect(idx, 'WebLinksAddon registration line not found').toBeGreaterThanOrEqual(0);
    // Inspect the registration line plus the next 5 lines (in case the
    // constructor is split across multiple lines). None of them may reference
    // openExternal — that is the exact pattern that opens every link twice.
    const block = lines.slice(idx, idx + 6).join('\n');
    expect(block).not.toMatch(/openExternal/);
  });

  it('keeps the explanatory comment so future cleanups do not revert the fix', () => {
    // The comment must mention BOTH the consequence ("twice") and the rationale
    // (the "CLI" is the sole opener, the addon stays for "cursor"/"hover").
    const idx = RENDERER_SRC.indexOf('new WebLinksAddon(');
    expect(idx).toBeGreaterThan(0);
    const before = RENDERER_SRC.slice(Math.max(0, idx - 800), idx);
    expect(before, 'expected a comment warning about double-open above WebLinksAddon').toMatch(/twice/i);
    expect(before, 'expected a comment about the cursor/hover affordance above WebLinksAddon').toMatch(/cursor|hover/i);
    expect(before, 'expected a comment naming the CLI as the link opener above WebLinksAddon').toMatch(/CLI/);
  });
});

describe('shell:openExternal IPC — regression guardrails', () => {
  it('only forwards http(s) URLs to shell.openExternal', () => {
    const handler = MAIN_SRC.match(/ipcMain\.handle\(\s*['"]shell:openExternal['"][\s\S]*?\}\s*\)\s*;/);
    expect(handler, 'shell:openExternal IPC handler not found').not.toBeNull();
    const block = handler[0];
    expect(block).toMatch(/http:\/\//);
    expect(block).toMatch(/https:\/\//);
    expect(block).toMatch(/shell\.openExternal/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts — non-Latin layout regression guard
// ───────────────────────────────────────────────────────────────────────────

describe('keyboard shortcuts — non-Latin layout regression guardrails', () => {
  it('renderer.js imports getShortcutKey from keyboard-shortcuts', () => {
    expect(RENDERER_SRC).toMatch(/getShortcutKey\b[\s\S]*require\(['"]\.\/keyboard-shortcuts['"]\)/);
  });

  it('renderer.js does not compare e.key to a single Latin letter (layout-dependent)', () => {
    // Single-letter `e.key === 'x'` checks fail on non-Latin layouts (e.g.
    // Hebrew Ctrl+V produces e.key === 'ה'). Use getShortcutKey(e) instead.
    // Named keys ('Enter', 'Escape', 'Tab', ...) and digits/symbols are fine.
    const offenders = RENDERER_SRC.match(/e\.key\s*===\s*['"][a-zA-Z]['"]/g);
    expect(
      offenders,
      `Found layout-dependent letter comparisons: ${offenders?.join(', ')}`
    ).toBeNull();
  });

  it('keyboard-shortcuts.js only compares lowerKey (not raw key/e.key) to letters', () => {
    // In src/keyboard-shortcuts.js, `lowerKey` is the result of getShortcutKey(e)
    // and is layout-independent. Direct letter comparisons must use it.
    // Allowed:   lowerKey === 'v'
    // Forbidden: key === 'v'   /   e.key === 'v'
    const offenders = SHORTCUTS_SRC.match(/(?<!lower)(?:^|\s)key\s*===\s*['"][a-zA-Z]['"]|e\.key\s*===\s*['"][a-zA-Z]['"]/g);
    expect(
      offenders,
      `Found layout-dependent letter comparisons in keyboard-shortcuts.js: ${offenders?.join(', ')}`
    ).toBeNull();
  });

  it('getShortcutKey is exported from keyboard-shortcuts.js', () => {
    expect(SHORTCUTS_SRC).toMatch(/module\.exports\s*=\s*\{[^}]*\bgetShortcutKey\b[^}]*\}/);
  });
});
