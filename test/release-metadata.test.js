import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PACKAGE_PATH = join(__dirname, '..', 'package.json');
const README_PATH = join(__dirname, '..', 'README.md');
const MAIN_PATH = join(__dirname, '..', 'src', 'main.js');

let pkg;
let readme;
let mainSource;

beforeAll(() => {
  pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  readme = readFileSync(README_PATH, 'utf8');
  mainSource = readFileSync(MAIN_PATH, 'utf8');
});

describe('release metadata regressions', () => {
  it('packages CHANGELOG.md with the app', () => {
    expect(pkg.build.files).toContain('CHANGELOG.md');
  });

  it('acquires the Electron single-instance lock', () => {
    expect(mainSource).toMatch(/requestSingleInstanceLock\(\)/);
    expect(mainSource).toMatch(/second-instance/);
  });

  it('documents installation for both Windows and macOS', () => {
    expect(readme).toMatch(/Windows[^\n]*installer/i);
    expect(readme).toMatch(/macOS \(Apple Silicon\)/i);
    expect(readme).toMatch(/dist:mac/);
  });

  it('documents the actual Windows installer filename', () => {
    expect(readme).toContain('DeepSky-Setup-x.x.x.exe');
  });
});
