function rememberRestorableClosedSession(stack, sessionId) {
  if (!sessionId) {
    return;
  }

  const existingIndex = stack.lastIndexOf(sessionId);
  if (existingIndex !== -1) {
    stack.splice(existingIndex, 1);
  }

  stack.push(sessionId);
}

function popRestorableClosedSession(stack, validIds) {
  while (stack.length > 0) {
    const sessionId = stack.pop();
    if (validIds.has(sessionId)) {
      return sessionId;
    }
  }
  return null;
}

module.exports = { rememberRestorableClosedSession, popRestorableClosedSession };
