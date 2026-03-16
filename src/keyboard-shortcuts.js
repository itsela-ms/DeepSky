/**
 * Creates the xterm custom key event handler for a terminal session.
 *
 * Returns false  → let the event bubble up to the document-level keydown handler.
 * Returns true   → let xterm consume the event normally (standard terminal input).
 *
 * @param {string} sessionId - Active session identifier.
 * @param {import('@xterm/xterm').Terminal} terminal - The xterm terminal instance.
 * @param {object} api - The preload API bridge (window.api).
 * @param {object} hooks - Optional renderer hooks for local prompt UX.
 */
function createTerminalKeyHandler(sessionId, terminal, api, hooks = {}) {
  return (e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key || '';
    const lowerKey = key.length === 1 ? key.toLowerCase() : key;

    // Bubble zoom shortcuts to the document handler
    if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) return false;

    // Bubble Ctrl+T and Ctrl+N to document handler for new session
    if (mod && (lowerKey === 't' || lowerKey === 'n')) return false;

    // Bubble Ctrl+Tab / Ctrl+Shift+Tab for tab switching
    if (e.ctrlKey && key === 'Tab') return false;

    // Bubble Ctrl+W for closing tabs
    if (mod && lowerKey === 'w') return false;

    // Bubble Ctrl+I for status panel toggle
    if (mod && lowerKey === 'i') return false;

    // Bubble Ctrl+F for in-session search
    if (mod && !e.shiftKey && lowerKey === 'f') return false;

    // Ctrl+C with a selection → copy to clipboard instead of sending SIGINT
    if (mod && lowerKey === 'c' && terminal.hasSelection()) {
      e.preventDefault();
      api.copyText(terminal.getSelection());
      terminal.clearSelection();
      return false;
    }

    // Ctrl+Backspace → delete previous word (sends \x17, equivalent to Ctrl+W in Unix shells)
    if (key === 'Backspace' && mod) {
      e.preventDefault();
      hooks.onInput?.('\x17');
      api.writePty(sessionId, '\x17');
      return false;
    }

    // Shift+Enter → line continuation, matching manual "\" then Enter.
    if (key === 'Enter' && e.shiftKey && !mod) {
      e.preventDefault();
      hooks.onInput?.('\\');
      api.writePty(sessionId, '\\');
      setTimeout(() => {
        hooks.onInput?.('\r');
        api.writePty(sessionId, '\r');
      }, 30);
      return false;
    }

    // Ctrl+V / Shift+Insert → paste from clipboard
    const isPaste = (mod && lowerKey === 'v') || (e.shiftKey && key === 'Insert');
    if (isPaste) {
      e.preventDefault();
      api.pasteText().then(text => {
        if (text) {
          hooks.onInput?.(text);
          api.writePty(sessionId, text);
        }
      });
      return false;
    }

    return true;
  };
}

module.exports = { createTerminalKeyHandler };
