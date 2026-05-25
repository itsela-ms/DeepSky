import { describe, it, expect } from 'vitest';

const { popRestorableClosedSession } = require('../src/recently-closed');

describe('recently-closed > popRestorableClosedSession', () => {
  it('returns the most recently pushed valid session id', () => {
    const stack = ['a', 'b', 'c'];
    const valid = new Set(['a', 'b', 'c']);
    expect(popRestorableClosedSession(stack, valid)).toBe('c');
    expect(stack).toEqual(['a', 'b']);
  });

  it('skips ids that are no longer valid and pops them off the stack', () => {
    const stack = ['a', 'gone1', 'gone2'];
    const valid = new Set(['a']);
    expect(popRestorableClosedSession(stack, valid)).toBe('a');
    expect(stack).toEqual([]);
  });

  it('returns null when nothing in the stack is valid', () => {
    const stack = ['gone1', 'gone2'];
    const valid = new Set(['other']);
    expect(popRestorableClosedSession(stack, valid)).toBe(null);
    expect(stack).toEqual([]);
  });

  it('returns null on an empty stack', () => {
    const stack = [];
    expect(popRestorableClosedSession(stack, new Set())).toBe(null);
  });

  it('does not affect the validIds set', () => {
    const stack = ['a'];
    const valid = new Set(['a']);
    popRestorableClosedSession(stack, valid);
    expect(valid.has('a')).toBe(true);
  });
});
