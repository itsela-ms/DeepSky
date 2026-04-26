import { describe, it, expect } from 'vitest';

const { popRestorableClosedSession } = require('../src/recently-closed');

describe('popRestorableClosedSession', () => {
  it('returns the most recent valid session id', () => {
    const stack = ['session-1', 'session-2', 'session-3'];
    const validIds = new Set(['session-2', 'session-3']);
    expect(popRestorableClosedSession(stack, validIds)).toBe('session-3');
  });

  it('skips deleted sessions until it finds a valid one', () => {
    const stack = ['session-1', 'deleted-session', 'session-2'];
    const validIds = new Set(['session-1']);
    expect(popRestorableClosedSession(stack, validIds)).toBe('session-1');
    expect(stack).toEqual([]);
  });

  it('returns null when no valid sessions remain', () => {
    const stack = ['deleted-a', 'deleted-b'];
    expect(popRestorableClosedSession(stack, new Set())).toBeNull();
  });
});
