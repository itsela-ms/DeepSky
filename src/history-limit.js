const HISTORY_SESSION_LIMIT = 500;
const HISTORY_SESSION_MONTH_WINDOW = 3;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_PRELOAD_REMAINING = 50;

function getHistoryScopeCutoff(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - HISTORY_SESSION_MONTH_WINDOW);
  return cutoff;
}

function getHistoryScopeNotice() {
  return `History loads ${HISTORY_PAGE_SIZE} sessions at a time, up to ${HISTORY_SESSION_LIMIT} from the last ${HISTORY_SESSION_MONTH_WINDOW} months.`;
}

function getHistoryScopeStatusNotice(showAll = false) {
  if (showAll) {
    return `Showing all saved history, ${HISTORY_PAGE_SIZE} sessions at a time.`;
  }
  return getHistoryScopeNotice();
}

function getHistoryScopeActionLabel(showAll = false) {
  return showAll ? 'Show recent history' : 'Show all history';
}

function getHistoryEmptyState(showAll = false) {
  return showAll
    ? 'No completed sessions yet.'
    : 'No completed sessions yet in the recent history window.';
}

module.exports = {
  HISTORY_SESSION_LIMIT,
  HISTORY_SESSION_MONTH_WINDOW,
  HISTORY_PAGE_SIZE,
  HISTORY_PRELOAD_REMAINING,
  getHistoryScopeCutoff,
  getHistoryEmptyState,
  getHistoryScopeActionLabel,
  getHistoryScopeNotice,
  getHistoryScopeStatusNotice,
};
