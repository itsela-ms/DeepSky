function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classifyDiffLine(line) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index') || line.startsWith('rename from ') || line.startsWith('rename to ')) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

function renderDiffPreviewHtml(diffText) {
  const lines = String(diffText || '').split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const cls = classifyDiffLine(line);
    return `<div class="status-diff-line status-diff-${cls}">${escapeHtml(line)}</div>`;
  }).join('');
}

module.exports = {
  classifyDiffLine,
  renderDiffPreviewHtml,
};
