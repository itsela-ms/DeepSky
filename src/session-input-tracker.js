function processSessionInput(state = {}, data, onCommand) {
  let line = state.line || '';

  for (const ch of data || '') {
    if (ch === '\r' || ch === '\n') {
      const command = line.trim();
      if (command) onCommand?.(command);
      line = '';
      continue;
    }

    if (ch === '\b' || ch === '\x7f') {
      line = line.slice(0, -1);
      continue;
    }

    if (ch === '\x17') {
      line = line.replace(/[^\s]+[\s]*$/, '');
      continue;
    }

    if (ch >= ' ') {
      line += ch;
    }
  }

  return { line };
}

function isMetadataRefreshCommand(command) {
  return /^\/(?:rename|cwd)(?:\s|$)/i.test(command || '');
}

function extractMetadataCommand(command) {
  const text = String(command || '').trim();
  const match = text.match(/^\/(rename|cwd)\s+(.+)$/i);
  if (!match) return null;

  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return null;

  return {
    type: match[1].toLowerCase(),
    value,
  };
}

module.exports = {
  processSessionInput,
  isMetadataRefreshCommand,
  extractMetadataCommand,
};
