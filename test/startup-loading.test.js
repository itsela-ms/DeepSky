import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const { createStartupLoadingController } = require('../src/startup-loading');

describe('startup-loading controller', () => {
  function createController() {
    const dom = new JSDOM(`
      <div id="screen" class="startup-loading-screen" aria-hidden="false" aria-busy="true">
        <div id="title">Starting DeepSky...</div>
        <div id="message">Loading...</div>
        <div id="progress" class="startup-loading-progress hidden" role="progressbar">
          <div id="progress-bar"></div>
          <div id="progress-label"></div>
        </div>
      </div>
    `);
    const document = dom.window.document;
    const controller = createStartupLoadingController({
      screen: document.getElementById('screen'),
      title: document.getElementById('title'),
      message: document.getElementById('message'),
      progress: document.getElementById('progress'),
      progressBar: document.getElementById('progress-bar'),
      progressLabel: document.getElementById('progress-label'),
    });
    return { document, controller };
  }

  it('updates the visible loading state text', () => {
    const { document, controller } = createController();
    controller.setStatus({
      titleText: 'Loading sessions...',
      messageText: 'Preparing the sidebar...',
    });

    expect(document.getElementById('title').textContent).toBe('Loading sessions...');
    expect(document.getElementById('message').textContent).toBe('Preparing the sidebar...');
    expect(document.getElementById('screen').dataset.state).toBe('loading');
    expect(document.getElementById('screen').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('progress').classList.contains('hidden')).toBe(true);
  });

  it('shows determinate progress when progress text or percentage is provided', () => {
    const { document, controller } = createController();
    controller.setStatus({
      titleText: 'Installing update...',
      messageText: 'Applying the latest DeepSky build...',
      progressPercent: 42,
      progressText: 'Copying files...',
    });

    expect(document.getElementById('progress').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('progress').classList.contains('indeterminate')).toBe(false);
    expect(document.getElementById('progress').getAttribute('aria-valuemin')).toBe('0');
    expect(document.getElementById('progress').getAttribute('aria-valuemax')).toBe('100');
    expect(document.getElementById('progress').getAttribute('aria-valuenow')).toBe('42');
    expect(document.getElementById('progress-bar').style.width).toBe('42%');
    expect(document.getElementById('progress-label').textContent).toBe('Copying files...');
  });

  it('shows indeterminate progress without aria-valuenow', () => {
    const { document, controller } = createController();
    controller.setStatus({
      progressPercent: 12,
      progressText: 'Preparing installer...',
      indeterminate: true,
    });

    expect(document.getElementById('progress').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('progress').classList.contains('indeterminate')).toBe(true);
    expect(document.getElementById('progress').hasAttribute('aria-valuenow')).toBe(false);
    expect(document.getElementById('progress').hasAttribute('aria-valuemin')).toBe(false);
    expect(document.getElementById('progress').hasAttribute('aria-valuemax')).toBe(false);
    expect(document.getElementById('progress-bar').style.width).toBe('12%');
  });

  it('hides the screen when startup completes', () => {
    const { document, controller } = createController();
    controller.setStatus({ progressPercent: 30, progressText: 'Still loading...' });
    controller.complete();

    expect(document.getElementById('screen').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('screen').getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('screen').dataset.state).toBe('ready');
    expect(document.getElementById('progress').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('progress').hasAttribute('aria-valuenow')).toBe(false);
    expect(document.getElementById('progress').hasAttribute('aria-valuemin')).toBe(false);
    expect(document.getElementById('progress').hasAttribute('aria-valuemax')).toBe(false);
    expect(document.getElementById('progress-bar').style.width).toBe('0%');
  });

  it('shows an error state when startup fails', () => {
    const { document, controller } = createController();
    controller.setStatus({ progressPercent: 30, progressText: 'Still loading...' });
    controller.fail(new Error('Session index failed to load.'));

    expect(document.getElementById('title').textContent).toBe("DeepSky couldn't finish starting");
    expect(document.getElementById('message').textContent).toBe('Session index failed to load.');
    expect(document.getElementById('screen').dataset.state).toBe('error');
    expect(document.getElementById('screen').getAttribute('aria-busy')).toBe('false');
    expect(document.getElementById('progress').classList.contains('hidden')).toBe(true);
  });
});
