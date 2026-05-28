'use strict';

// Headless smoke test for the packaged Electron app.
//
// What it verifies on macOS CI (before we ship a DMG):
//   1. The packaged .app can boot the main process at all.
//   2. node-pty is require()-able from the asar.unpacked location.
//   3. node-pty's `spawn-helper` is executable (no EACCES from chmod-stripping).
//   4. A real PTY session can be spawned and produce output back to the
//      parent process — the actual failure mode users hit when packaging
//      goes wrong.
//
// Trigger: run with `--smoke-test` arg or DEEPSKY_SMOKE_TEST=1 env var.
// The process exits 0 on success / 1 on any failure, with a tagged report
// on stdout that CI greps for sanity assertions.
//
// IMPORTANT: this runs BEFORE app.whenReady() in main.js, so no Electron
// window is opened. That keeps CI fast and avoids needing a display server.

const path = require('path');
const fs = require('fs');

function log(level, msg, data) {
  const line = data
    ? `[smoke-test] ${level.toUpperCase()} ${msg} ${JSON.stringify(data)}`
    : `[smoke-test] ${level.toUpperCase()} ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
}

async function run({ pty: injectedPty, shellPath, timeoutMs = 15000 } = {}) {
  log('info', 'starting');
  log('info', 'env', {
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    PATH_len: (process.env.PATH || '').length,
    node: process.version,
    electron: process.versions.electron || null,
  });

  // Step 1: require('node-pty') — proves the native module loaded.
  let pty = injectedPty;
  if (!pty) {
    try {
      pty = require('node-pty');
      log('info', 'node-pty loaded', { keys: Object.keys(pty || {}).slice(0, 8) });
    } catch (err) {
      log('error', 'node-pty failed to load', { message: err && err.message });
      return false;
    }
  }

  // Step 2: locate spawn-helper relative to node-pty and verify it's executable
  // (mac/linux only; Windows uses ConPTY and ships no helper).
  if (process.platform !== 'win32') {
    try {
      const nodePtyDir = path.dirname(require.resolve('node-pty'));
      // node-pty's bin lives at <root>/lib/index.js; helper lives at <root>/build/Release
      // for prebuilds it's at <root>/prebuilds/<platform>-<arch>/spawn-helper.
      // Search both common locations.
      const candidates = [
        path.join(nodePtyDir, '..', 'build', 'Release', 'spawn-helper'),
        path.join(nodePtyDir, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      ];
      let found = null;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) { found = candidate; break; }
      }
      if (!found) {
        log('error', 'spawn-helper not found', { candidates });
        return false;
      }
      const stat = fs.statSync(found);
      const mode = stat.mode & 0o777;
      if ((mode & 0o111) === 0) {
        log('error', 'spawn-helper not executable', { found, mode: mode.toString(8) });
        return false;
      }
      log('info', 'spawn-helper ok', { found, mode: mode.toString(8) });
    } catch (err) {
      log('error', 'spawn-helper probe failed', { message: err && err.message });
      return false;
    }
  }

  // Step 3: actually spawn a PTY and read back a known marker.
  const shell = shellPath || (process.platform === 'win32'
    ? (process.env.COMSPEC || 'cmd.exe')
    : '/bin/zsh');
  const args = process.platform === 'win32'
    ? ['/C', 'echo PTY_OK']
    : ['-lc', 'echo PTY_OK'];

  return new Promise((resolve) => {
    let proc;
    let buf = '';
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { if (proc && proc.kill) proc.kill(); } catch {}
      log(ok ? 'info' : 'error', `result: ${reason}`, { buf: buf.slice(0, 200) });
      resolve(ok);
    };

    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      finish(false, `pty.spawn threw: ${err && err.message}`);
      return;
    }

    proc.onData((data) => {
      buf += data;
      if (buf.includes('PTY_OK')) finish(true, 'PTY echoed PTY_OK');
    });
    proc.onExit(({ exitCode }) => {
      // The shell may exit before we read the buffer on slow CI runners. If
      // we already saw PTY_OK in `buf`, fall through; otherwise check now.
      if (buf.includes('PTY_OK')) {
        finish(true, `PTY exited (${exitCode}) after echoing PTY_OK`);
      } else if (!settled) {
        finish(false, `PTY exited (${exitCode}) without echoing PTY_OK`);
      }
    });

    setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);
  });
}

module.exports = { run };
