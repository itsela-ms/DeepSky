import { describe, it, expect } from 'vitest';

const {
  HISTORY_SESSION_LIMIT,
  HISTORY_SESSION_MONTH_WINDOW,
  getHistoryEmptyState,
  getHistoryScopeActionLabel,
  getHistoryScopeNotice,
  getHistoryScopeStatusNotice,
} = require('../src/history-limit');

describe('history-limit helpers', () => {
  it('uses bounded-history copy without the old explicit-ask wording', () => {
    expect(getHistoryScopeNotice()).toBe(
      `History shows up to ${HISTORY_SESSION_LIMIT} sessions from the last ${HISTORY_SESSION_MONTH_WINDOW} months by default.`
    );
    expect(getHistoryScopeNotice()).not.toMatch(/ask explicitly/i);
  });

  it('switches the notice when all history is visible', () => {
    expect(getHistoryScopeStatusNotice(false)).toBe(getHistoryScopeNotice());
    expect(getHistoryScopeStatusNotice(true)).toBe('Showing all saved history.');
  });

  it('provides toggle labels for recent vs full history', () => {
    expect(getHistoryScopeActionLabel(false)).toBe('Show all history');
    expect(getHistoryScopeActionLabel(true)).toBe('Show recent history');
  });

  it('adjusts the empty state for recent vs full history', () => {
    expect(getHistoryEmptyState(false)).toBe('No completed sessions yet in the recent history window.');
    expect(getHistoryEmptyState(true)).toBe('No completed sessions yet.');
  });
});
