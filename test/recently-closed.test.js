import { describe, it, expect } from 'vitest';

const {
  rememberRestorableClosedSession,
  peekRestorableClosedSession,
  forgetRestorableClosedSession,
} = require('../src/recently-closed');

describe('recently-closed sessions', () => {
  it('peeks without removing so failed restores can be retried', () => {
    const stack = [];
    rememberRestorableClosedSession(stack, 'a');

    expect(peekRestorableClosedSession(stack, new Set(['a']))).toBe('a');
    expect(stack).toEqual(['a']);
  });

  it('forgets a restored session only after open succeeds', () => {
    const stack = [];
    rememberRestorableClosedSession(stack, 'a');
    forgetRestorableClosedSession(stack, 'a');

    expect(stack).toEqual([]);
  });

  it('drops stale entries while peeking for a valid session', () => {
    const stack = ['stale', 'valid'];

    expect(peekRestorableClosedSession(stack, new Set(['valid']))).toBe('valid');
    expect(stack).toEqual(['stale', 'valid']);

    forgetRestorableClosedSession(stack, 'valid');
    expect(peekRestorableClosedSession(stack, new Set())).toBeNull();
    expect(stack).toEqual([]);
  });
});
