function getFocusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
}

function trapFocusWithin(event, container) {
  if (!container || event.key !== 'Tab') return false;

  const focusable = getFocusableElements(container);
  if (!focusable.length) {
    event.preventDefault();
    return true;
  }

  const activeElement = container.ownerDocument?.activeElement;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const containsFocus = activeElement && container.contains(activeElement);

  if (event.shiftKey) {
    if (activeElement === first || !containsFocus) {
      last.focus();
      event.preventDefault();
      return true;
    }
    return false;
  }

  if (activeElement === last || !containsFocus) {
    first.focus();
    event.preventDefault();
    return true;
  }

  return false;
}

function isBackdropClickTarget(target) {
  return Boolean(target?.classList?.contains('enhance-modal-backdrop'));
}

module.exports = {
  getFocusableElements,
  trapFocusWithin,
  isBackdropClickTarget,
};
