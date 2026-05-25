function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSummaryActionButton(sessionId, actionClass, icon, label, available, availableTitle, unavailableTitle) {
  const escapedSessionId = escapeHtml(sessionId);
  const title = available ? availableTitle : unavailableTitle;
  const unavailableClass = available ? '' : ' is-unavailable';
  const disabledAttrs = available ? '' : ' disabled';

  return `<button class="status-summary-action ${actionClass}${unavailableClass}" type="button" data-session-id="${escapedSessionId}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabledAttrs}>
            <span class="status-summary-action-icon">${icon}</span>
            <span>${label}</span>
          </button>`;
}

function renderStatusSummaryMetaHtml(sessionId, availability = {}) {
  const escapedSessionId = escapeHtml(sessionId);
  const sessionDirectoryAvailable = availability.sessionDirectoryAvailable !== false;
  const filesDirectoryAvailable = availability.filesDirectoryAvailable !== false;

  return `<div class="status-summary-meta">
      <div class="status-summary-id-block">
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
          ${renderSummaryActionButton(
            sessionId,
            'status-open-session-directory',
            '📁',
            'session',
            sessionDirectoryAvailable,
            'Open session directory',
            'Session directory unavailable',
          )}
          ${renderSummaryActionButton(
            sessionId,
            'status-open-session-files-directory',
            '📄',
            'files',
            filesDirectoryAvailable,
            'Open session files directory',
            'Session files directory unavailable',
          )}
        </div>
      </div>
    </div>`;
}

module.exports = {
  renderStatusSummaryMetaHtml,
};
