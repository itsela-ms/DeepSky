// Manual smoke test — NOT part of the auto test suite (kept under test/manual/).
// Runs the real PtyManager against the real Copilot CLI to verify the
// "spawn without --resume, discover the CLI-assigned ID afterward" fix.
// Run with: node test/manual/smoke-real-cli.js
const PtyManager = require('../../src/pty-manager');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function main() {
  const copilotPath = process.env.COPILOT_PATH || 'C:\\Tools\\copilot.cmd';
  if (!fs.existsSync(copilotPath)) {
    console.error('Copilot launcher not found at', copilotPath);
    process.exit(2);
  }

  const settingsService = { get: () => ({ maxConcurrent: 5, useAgencyCopilot: false }) };
  const manager = new PtyManager(copilotPath, settingsService);

  console.log('Calling newSession() …');
  const t0 = Date.now();
  let sessionId;
  try {
    sessionId = await manager.newSession(os.homedir());
  } catch (e) {
    console.error('newSession failed:', e.message);
    process.exit(1);
  }
  const elapsed = Date.now() - t0;
  console.log('newSession returned id =', sessionId, '(took ' + elapsed + ' ms)');

  const folder = path.join(os.homedir(), '.copilot', 'session-state', sessionId);
  if (!fs.existsSync(folder)) {
    console.error('Discovered ID has no folder on disk:', folder);
    process.exit(1);
  }
  console.log('Verified folder exists at', folder);

  manager.kill(sessionId);
  console.log('OK — fix verified end-to-end against the real CLI.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
