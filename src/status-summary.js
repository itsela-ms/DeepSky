function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusSummaryMetaHtml(sessionId) {
  const escapedSessionId = escapeHtml(sessionId);
  return `<div class="status-summary-meta">
      <div class="status-summary-identity">
        <span class="status-summary-id-label">🆔 Session ID</span>
        <div class="status-summary-id-row">
          <code class="status-summary-id" title="${escapedSessionId}">${escapedSessionId}</code>
          <button class="status-summary-id-copy status-copy-session-id" type="button" data-session-id="${escapedSessionId}" title="Copy session ID" aria-label="Copy session ID">
            <span class="status-summary-action-icon">📋</span>
          </button>
        </div>
      </div>
      <div class="status-summary-actions-block">
        <span class="status-summary-actions-label">Quick actions</span>
        <div class="status-summary-actions">
          <button class="status-summary-action status-open-session-directory" type="button" data-session-id="${escapedSessionId}" title="Open session directory">
            <span class="status-summary-action-icon">📁</span>
            <span>session</span>
          </button>
          <button class="status-summary-action status-open-session-files-directory" type="button" data-session-id="${escapedSessionId}" title="Open session files directory">
            <span class="status-summary-action-icon">📄</span>
            <span>files</span>
          </button>
        </div>
      </div>
    </div>`;
}

module.exports = {
  renderStatusSummaryMetaHtml,
};
