import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/**
 * Regression test for sidebar ↔ tab-strip ordering drift.
 *
 * The sidebar uses `sessionOrder` (drag-reorderable, persisted to settings)
 * as its source of truth. The top tab strip, however, used to append tabs
 * in raw creation/resolution order, which meant Ctrl+Tab cycled in an order
 * that did not match what the user saw in the sidebar — e.g., pressing
 * Ctrl+Tab would jump to a session that wasn't visually adjacent.
 *
 * The fix introduces `syncTabStripOrder()` which mirrors `sessionOrder` into
 * the DOM children of `tabsScrollArea`. It must be invoked whenever the
 * ordering can change:
 *   1. After every `addTab(...)` (new tabs append to the end of
 *      `sessionOrder` via `ensureSessionOrder`, so this is typically a
 *      no-op for the new tab itself but corrects any prior drift).
 *   2. After `handleSessionReorder(...)` updates `sessionOrder` from a
 *      sidebar drag.
 *   3. After init restores `sessionOrder` from settings — at that point
 *      tabs were already added in `Promise.allSettled` resolution order
 *      and need to be realigned to the canonical saved order.
 *
 * Because the renderer module is bundled with xterm/Electron deps that are
 * painful to mock, we assert against source text as the other wiring tests
 * in this directory do.
 */
describe('top tab strip mirrors sidebar sessionOrder', () => {
  const rendererPath = path.join(__dirname, '..', 'src', 'renderer.js');
  const src = fs.readFileSync(rendererPath, 'utf8');

  it('defines syncTabStripOrder', () => {
    expect(src).toMatch(/function syncTabStripOrder\s*\(/);
  });

  it('syncTabStripOrder sorts strip children by sessionOrder index', () => {
    const m = src.match(/function syncTabStripOrder[\s\S]*?\n\}/);
    expect(m, 'syncTabStripOrder body must be findable').not.toBeNull();
    const body = m[0];
    // Pulls the current tabs out of the strip
    expect(body).toMatch(/tabsScrollArea\.querySelectorAll\(['"`]:scope > \.tab['"`]\)/);
    // Computes a position from sessionOrder
    expect(body).toContain('sessionOrder.map');
    // Re-appends in sorted order (moves existing nodes; no clone, no listener loss)
    expect(body).toMatch(/for \(const .* of sorted\) tabsScrollArea\.appendChild/);
  });

  it('addTab triggers a strip sync after appending the new tab', () => {
    // Slice out the addTab body so we're not matching unrelated occurrences.
    const m = src.match(/function addTab\(sessionId, title\)[\s\S]*?\n\}/);
    expect(m, 'addTab body must be findable').not.toBeNull();
    const body = m[0];
    const appendIdx = body.indexOf('tabsScrollArea.appendChild(tab)');
    const syncIdx = body.indexOf('syncTabStripOrder()');
    expect(appendIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(appendIdx);
  });

  it('handleSessionReorder syncs the strip after updating sessionOrder', () => {
    const m = src.match(/function handleSessionReorder[\s\S]*?\n\}/);
    expect(m, 'handleSessionReorder body must be findable').not.toBeNull();
    const body = m[0];
    // Last mutation of sessionOrder is the push to the end after the splice.
    const lastMutationIdx = Math.max(
      body.lastIndexOf('sessionOrder.splice'),
      body.lastIndexOf('sessionOrder.push')
    );
    const syncIdx = body.indexOf('syncTabStripOrder()');
    expect(lastMutationIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(lastMutationIdx);
  });

  it('init realigns the strip after restoring saved sessionOrder', () => {
    // Find the restore-from-settings line and ensure syncTabStripOrder is
    // called nearby (within the same block, before renderSessionList).
    const restoreIdx = src.indexOf('sessionOrder = settings.sessionOrder.filter');
    expect(restoreIdx).toBeGreaterThan(-1);
    const after = src.slice(restoreIdx, restoreIdx + 600);
    const syncIdx = after.indexOf('syncTabStripOrder()');
    const renderIdx = after.indexOf('renderSessionList()');
    expect(syncIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    // Sync must run before renderSessionList so the strip is consistent
    // with what the sidebar paints in the same frame.
    expect(syncIdx).toBeLessThan(renderIdx);
  });
});
