function createStartupLoadingController({ screen, title, message, progress, progressBar, progressLabel } = {}) {
  function setStatus(status = {}) {
    if (!screen) return;
    const { titleText, messageText } = status;
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
    updateProgress(status);
  }

  function complete() {
    if (!screen) return;
    screen.dataset.state = 'ready';
    screen.setAttribute('aria-hidden', 'true');
    screen.setAttribute('aria-busy', 'false');
    screen.classList.add('hidden');
    hideProgress();
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
    hideProgress();
  }

  function hideProgress() {
    if (!progress) return;
    progress.classList.add('hidden');
    progress.classList.remove('indeterminate');
    progress.removeAttribute('aria-valuenow');
    progress.removeAttribute('aria-valuemin');
    progress.removeAttribute('aria-valuemax');
    if (progressBar) progressBar.style.width = '0%';
    if (progressLabel) progressLabel.textContent = '';
  }

  function updateProgress({ progressPercent, progressText, indeterminate } = {}) {
    if (!progress) return;

    const hasProgress = typeof progressPercent === 'number' || typeof progressText === 'string' || indeterminate === true;
    if (!hasProgress) {
      hideProgress();
      return;
    }

    const percent = Math.max(0, Math.min(100, Number(progressPercent) || 0));
    progress.classList.remove('hidden');
    progress.classList.toggle('indeterminate', indeterminate === true);
    if (indeterminate === true) {
      progress.removeAttribute('aria-valuenow');
      progress.removeAttribute('aria-valuemin');
      progress.removeAttribute('aria-valuemax');
    } else {
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressLabel) progressLabel.textContent = progressText || '';
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
