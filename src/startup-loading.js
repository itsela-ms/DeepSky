function createStartupLoadingController({ screen, title, message } = {}) {
  function setStatus({ titleText, messageText } = {}) {
    if (!screen) return;
    screen.classList.remove('hidden');
    screen.dataset.state = 'loading';
    screen.setAttribute('aria-hidden', 'false');
    screen.setAttribute('aria-busy', 'true');
    if (typeof titleText === 'string' && title) {
      title.textContent = titleText;
    }
    if (typeof messageText === 'string' && message) {
      message.textContent = messageText;
    }
  }

  function complete() {
    if (!screen) return;
    screen.dataset.state = 'ready';
    screen.setAttribute('aria-hidden', 'true');
    screen.setAttribute('aria-busy', 'false');
    screen.classList.add('hidden');
  }

  function fail(error) {
    if (!screen) return;
    const details = error?.message || String(error || 'Unknown startup error.');
    screen.classList.remove('hidden');
    screen.dataset.state = 'error';
    screen.setAttribute('aria-hidden', 'false');
    screen.setAttribute('aria-busy', 'false');
    if (title) {
      title.textContent = "DeepSky couldn't finish starting";
    }
    if (message) {
      message.textContent = details;
    }
  }

  return {
    setStatus,
    complete,
    fail,
  };
}

module.exports = {
  createStartupLoadingController,
};
