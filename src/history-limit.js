const HISTORY_SESSION_LIMIT = 500;
const HISTORY_SESSION_MONTH_WINDOW = 3;

function getHistoryScopeCutoff(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - HISTORY_SESSION_MONTH_WINDOW);
  return cutoff;
}

function getHistoryScopeNotice() {
  return `History shows up to ${HISTORY_SESSION_LIMIT} sessions from the last ${HISTORY_SESSION_MONTH_WINDOW} months by default.`;
}

function getHistoryScopeStatusNotice(showAll = false) {
  if (showAll) {
    return 'Showing all saved history.';
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
  getHistoryScopeCutoff,
  getHistoryEmptyState,
  getHistoryScopeActionLabel,
  getHistoryScopeNotice,
  getHistoryScopeStatusNotice,
};
