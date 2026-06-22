import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

describe('session working-directory changes', () => {
  const mainPath = path.join(__dirname, '..', 'src', 'main.js');
  const mainSource = fs.readFileSync(mainPath, 'utf8');

  it('restarts a live session through PtyManager.restartSession instead of kill+immediate-open', () => {
    const start = mainSource.indexOf("ipcMain.handle('session:changeCwd'");
    const end = mainSource.indexOf('\n  // IPC: Write to a session', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const body = mainSource.slice(start, end);
    expect(body).toMatch(/await ptyManager\.restartSession\(sessionId,\s*cwd,\s*launcher(?:,\s*launcherArgs)?\)/);
    expect(body).not.toMatch(/ptyManager\.kill\(sessionId\)[\s\S]*ptyManager\.openSession\(sessionId,\s*cwd,\s*launcher\)/);
  });
});
