import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readPreferredSessionCwd } = require('../src/session-cwd');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsky-cwd-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('session-cwd > readPreferredSessionCwd', () => {
  it('returns the workspace.yaml cwd when no override file exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workspace.yaml'), 'cwd: /repos/app\nname: test\n', 'utf8');
    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('/repos/app');
  });

  it('returns the .deepsky-cwd override when newer than workspace.yaml', async () => {
    const yamlPath = path.join(tmpDir, 'workspace.yaml');
    fs.writeFileSync(yamlPath, 'cwd: /old/path\n', 'utf8');
    // Force older mtime on yaml
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(yamlPath, past, past);
    fs.writeFileSync(path.join(tmpDir, '.deepsky-cwd'), '/new/path\n', 'utf8');

    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('/new/path');
  });

  it('prefers workspace.yaml when it is newer than the override', async () => {
    const overridePath = path.join(tmpDir, '.deepsky-cwd');
    fs.writeFileSync(overridePath, '/old/override\n', 'utf8');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(overridePath, past, past);
    fs.writeFileSync(path.join(tmpDir, 'workspace.yaml'), 'cwd: /fresh/yaml\n', 'utf8');

    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('/fresh/yaml');
  });

  it('returns the override when workspace.yaml is missing', async () => {
    fs.writeFileSync(path.join(tmpDir, '.deepsky-cwd'), '/only/override\n', 'utf8');
    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('/only/override');
  });

  it('returns empty string when no metadata exists', async () => {
    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('');
  });

  it('ignores blank cwd values in workspace.yaml', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workspace.yaml'), 'cwd: "   "\n', 'utf8');
    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('');
  });

  it('handles malformed workspace.yaml gracefully', async () => {
    fs.writeFileSync(path.join(tmpDir, 'workspace.yaml'), '::: not yaml :::', 'utf8');
    await expect(readPreferredSessionCwd(tmpDir)).resolves.toBe('');
  });
});
