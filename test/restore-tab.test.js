import { describe, it, expect } from 'vitest';

const { rememberRestorableClosedSession, popRestorableClosedSession } = require('../src/recently-closed');

describe('rememberRestorableClosedSession', () => {
  it('pushes the session id onto the restore stack', () => {
    const stack = [];
    rememberRestorableClosedSession(stack, 'session-1');
    expect(stack).toEqual(['session-1']);
  });

  it('moves an existing session id to the top instead of duplicating it', () => {
    const stack = ['session-1', 'session-2', 'session-1'];
    rememberRestorableClosedSession(stack, 'session-2');
    expect(stack).toEqual(['session-1', 'session-1', 'session-2']);
  });

  it('ignores empty session ids', () => {
    const stack = ['session-1'];
    rememberRestorableClosedSession(stack, '');
    rememberRestorableClosedSession(stack, null);
    expect(stack).toEqual(['session-1']);
  });
});

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
