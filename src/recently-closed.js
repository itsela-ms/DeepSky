function popRestorableClosedSession(stack, validIds) {
  while (stack.length > 0) {
    const sessionId = stack.pop();
    if (validIds.has(sessionId)) {
      return sessionId;
    }
  }
  return null;
}

module.exports = { popRestorableClosedSession };
