import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/**
 * Regression test for the v1.2.0 Ctrl+W bug.
 *
 * Prior to the fix in this branch, Ctrl+W (and the tab strip × button and
 * middle-click) dispatched to `closeTab(sessionId)` — a soft close that only
 * removed the tab strip entry. The pty kept running and the sidebar still
 * showed the session as alive, so the user's "close session" expectation
 * was broken.
 *
 * The correct call is `terminateSession(sessionId, { rememberClosedTab: true })`
 * — it kills the pty, prunes sidebar state, and pushes the session id onto
 * the recently-closed stack so Ctrl+Shift+T can restore it.
 *
 * Because these handlers live deep inside the bundled renderer module and
 * touch xterm + Electron APIs, we assert on the source text directly rather
 * than spinning up Electron.
 */
describe('close-tab actions terminate the session', () => {
  const rendererPath = path.join(__dirname, '..', 'src', 'renderer.js');
  const src = fs.readFileSync(rendererPath, 'utf8');

  it('Ctrl+W shortcut dispatch calls terminateSession (not closeTab)', () => {
    const m = src.match(/case 'close-tab':\s*\n\s*([^\n]+)/);
    expect(m, 'expected a `case "close-tab":` switch arm').not.toBeNull();
    expect(m[1]).toContain('terminateSession(activeSessionId');
    expect(m[1]).toContain('rememberClosedTab: true');
    expect(m[1]).not.toMatch(/\bcloseTab\(/);
  });

  it('tab strip × close button calls terminateSession', () => {
    const m = src.match(/closeBtn\.addEventListener\('click'[^;]+;[^;]*;[^}]*\}\)/);
    expect(m, 'expected a closeBtn click handler').not.toBeNull();
    expect(m[0]).toContain('terminateSession(sessionId');
    expect(m[0]).toContain('rememberClosedTab: true');
    expect(m[0]).not.toMatch(/\bcloseTab\(/);
  });

  it('tab middle-click calls terminateSession', () => {
    // The middle-click branch sits inside the tab mousedown handler.
    const m = src.match(/if \(e\.button === 1\)[^}]*\}/);
    expect(m, 'expected a middle-click branch').not.toBeNull();
    expect(m[0]).toContain('terminateSession(sessionId');
    expect(m[0]).toContain('rememberClosedTab: true');
    expect(m[0]).not.toMatch(/\bcloseTab\(/);
  });

  it('removeGroup(_, closeTabs=true) terminates each tab', () => {
    const m = src.match(/function removeGroup\(groupId, closeTabs\) \{[\s\S]*?\n\}/);
    expect(m, 'expected removeGroup definition').not.toBeNull();
    expect(m[0]).toContain('terminateSession(tabId');
    expect(m[0]).toContain('rememberClosedTab: true');
  });
});

describe('session:new IPC contract returns bufferedData', () => {
  // Validates the scroll-bug fix: main.js no longer races by sending pty:data
  // before the invoke returns; instead it returns { sessionId, bufferedData }
  // and the renderer writes bufferedData AFTER createTerminal.
  const mainPath = path.join(__dirname, '..', 'src', 'main.js');
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

  it('main.js does not send pty:data for warm-standby buffered data', () => {
    // Find the session:new handler body
    const m = mainSrc.match(/ipcMain\.handle\('session:new',[\s\S]*?return \{ sessionId, bufferedData: '' \};\s*\}\);/);
    expect(m, 'expected session:new handler with new return shape').not.toBeNull();
    // The pre-fix code called `mainWindow.webContents.send('pty:data', { sessionId: claimed.id, data: ... })`
    // inside this handler. Confirm that pattern is gone.
    expect(m[0]).not.toMatch(/webContents\.send\('pty:data'/);
  });

  it('main.js returns { sessionId, bufferedData } from session:new', () => {
    const m = mainSrc.match(/ipcMain\.handle\('session:new',[\s\S]*?return \{ sessionId, bufferedData: '' \};\s*\}\);/);
    expect(m).not.toBeNull();
    // Both warm-standby and cold-start branches return the new shape.
    expect(m[0]).toMatch(/return \{\s*sessionId: claimed\.id,\s*bufferedData:/);
    expect(m[0]).toMatch(/return \{ sessionId, bufferedData: '' \};/);
  });

  it('renderer.js newSession destructures bufferedData and writes it after createTerminal', () => {
    const m = rendererSrc.match(/async function newSession\(\) \{[\s\S]*?creatingSession = false;\s*\}\s*\}/);
    expect(m, 'expected newSession definition').not.toBeNull();
    // Must write bufferedData AFTER createTerminal (not before).
    const createIdx = m[0].indexOf('createTerminal(sessionId)');
    const writeIdx = m[0].indexOf('termEntry.terminal.write(bufferedData');
    expect(createIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(createIdx);
  });
});
