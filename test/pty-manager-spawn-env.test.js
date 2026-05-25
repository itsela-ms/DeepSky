import { describe, it, expect } from 'vitest';

const { buildSpawnEnv } = require('../src/pty-manager');

describe('pty-manager > buildSpawnEnv', () => {
  it('always sets TERM=xterm-256color', () => {
    const env = buildSpawnEnv({ FOO: 'bar' });
    expect(env.TERM).toBe('xterm-256color');
    expect(env.FOO).toBe('bar');
  });

  it('does not mutate the original env', () => {
    const base = { PATH: '/usr/bin' };
    buildSpawnEnv(base);
    expect(base.TERM).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'augments PATH on macOS/Linux to include common user bin directories',
    () => {
      const env = buildSpawnEnv({ PATH: '/usr/bin' });
      const segments = env.PATH.split(':');
      expect(segments[0]).toBe('/usr/bin');
      expect(segments).toContain('/opt/homebrew/bin');
      expect(segments).toContain('/usr/local/bin');
    },
  );

  it.skipIf(process.platform !== 'win32')('preserves PATH unchanged on Windows', () => {
    const before = 'C:\\Tools;C:\\Windows';
    const env = buildSpawnEnv({ PATH: before });
    expect(env.PATH).toBe(before);
  });
});
