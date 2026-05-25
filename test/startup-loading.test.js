import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const { createStartupLoadingController } = require('../src/startup-loading');

describe('startup-loading controller', () => {
  function createController() {
    const dom = new JSDOM(`
      <div id="screen" class="startup-loading-screen" aria-hidden="false" aria-busy="true">
        <div id="title">Starting DeepSky...</div>
        <div id="message">Loading...</div>
      </div>
    `);
    const document = dom.window.document;
    const controller = createStartupLoadingController({
      screen: document.getElementById('screen'),
      title: document.getElementById('title'),
      message: document.getElementById('message'),
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
  });

  it('hides the screen when startup completes', () => {
    const { document, controller } = createController();
    controller.complete();

    expect(document.getElementById('screen').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('screen').getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('screen').dataset.state).toBe('ready');
  });

  it('shows an error state when startup fails', () => {
    const { document, controller } = createController();
    controller.fail(new Error('Session index failed to load.'));

    expect(document.getElementById('title').textContent).toBe("DeepSky couldn't finish starting");
    expect(document.getElementById('message').textContent).toBe('Session index failed to load.');
    expect(document.getElementById('screen').dataset.state).toBe('error');
    expect(document.getElementById('screen').getAttribute('aria-busy')).toBe('false');
  });
});
