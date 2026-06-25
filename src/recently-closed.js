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

function peekRestorableClosedSession(stack, validIds) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const sessionId = stack[i];
    if (validIds.has(sessionId)) return sessionId;
    stack.splice(i, 1);
  }
  return null;
}

function forgetRestorableClosedSession(stack, sessionId) {
  const index = stack.lastIndexOf(sessionId);
  if (index !== -1) stack.splice(index, 1);
}

module.exports = {
  rememberRestorableClosedSession,
  popRestorableClosedSession,
  peekRestorableClosedSession,
  forgetRestorableClosedSession,
};
