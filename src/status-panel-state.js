function shouldApplyStatusPanelUpdate({
  requestId,
  currentRequestId,
  requestedSessionId,
  activeSessionId,
  panelCollapsed,
}) {
  return !panelCollapsed &&
    requestId === currentRequestId &&
    requestedSessionId === activeSessionId;
}

module.exports = { shouldApplyStatusPanelUpdate };
