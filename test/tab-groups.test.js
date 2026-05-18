import { describe, it, expect } from 'vitest';

const { pruneSessionFromGroups } = require('../src/tab-groups');

describe('pruneSessionFromGroups', () => {
  it('removes a session from its group and keeps the group when other tabs remain', () => {
    const groups = [
      { id: 'g1', name: 'Group 1', tabIds: ['a', 'b'] },
      { id: 'g2', name: 'Group 2', tabIds: ['c'] },
    ];

    expect(pruneSessionFromGroups(groups, 'a')).toEqual([
      { id: 'g1', name: 'Group 1', tabIds: ['b'] },
      { id: 'g2', name: 'Group 2', tabIds: ['c'] },
    ]);
  });

  it('drops empty groups after removing the last session', () => {
    const groups = [
      { id: 'g1', name: 'Group 1', tabIds: ['a'] },
      { id: 'g2', name: 'Group 2', tabIds: ['b', 'c'] },
    ];

    expect(pruneSessionFromGroups(groups, 'a')).toEqual([
      { id: 'g2', name: 'Group 2', tabIds: ['b', 'c'] },
    ]);
  });

  it('returns the original array when the session is not grouped', () => {
    const groups = [
      { id: 'g1', name: 'Group 1', tabIds: ['a', 'b'] },
    ];

    expect(pruneSessionFromGroups(groups, 'z')).toBe(groups);
  });
});
