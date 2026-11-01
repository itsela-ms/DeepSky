import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { shouldApplyStatusPanelUpdate } = require('../src/status-panel-state');
const source = readFileSync(join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const updateSource = source.slice(
  source.indexOf('const statusPanelCache = new Map();'),
  source.indexOf('function renderStatusPanel(')
);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const body = { innerHTML: '' };
  const render = vi.fn();
  const api = {
    getSessionStatus: vi.fn().mockResolvedValue({ summary: { text: 'Current summary' } }),
    getSessionDirectoryAvailability: vi.fn().mockResolvedValue({ sessionDirectoryAvailable: true }),
  };
  const factory = new Function(
    'window', 'statusPanelBody', 'renderStatusPanel', 'shouldApplyStatusPanelUpdate',
    `let statusPanelRequestSeq = 0;
     let activeSessionId = 'a';
     const terminals = new Map();
     const statusPanel = { classList: { contains: () => false } };
     const allSessions = [{ id: 'a' }, { id: 'b' }];
     const loadStatusSectionState = () => {};
     const hideStatusDiffPopover = () => {};
     ${updateSource}
     return {
       update: updateStatusPanel, cache: statusPanelCache,
       preload: refreshOpenSessionStatuses, terminals,
       activate: id => { activeSessionId = id; }
     };`
  );
  return { ...factory({ api }, body, render, shouldApplyStatusPanelUpdate), api, body, render };
}

describe('status panel session switching', () => {
  it('clears previous-session content and starts both reads without waiting for status', async () => {
    const harness = setup();
    const status = deferred();
    harness.api.getSessionStatus.mockReturnValueOnce(status.promise);
    harness.body.innerHTML = 'Previous session summary';
    const pending = harness.update('a');
    expect(harness.body.innerHTML).toContain('Loading session status');
    expect(harness.api.getSessionDirectoryAvailability).toHaveBeenCalledWith('a');
    status.resolve({ summary: { text: 'A' } });
    await pending;
    expect(harness.render).toHaveBeenCalledOnce();
  });

  it('renders a cached snapshot synchronously while refreshing a returning session', async () => {
    const harness = setup();
    await harness.update('a');
    const cached = harness.cache.get('a');
    cached.readAt -= 15000;
    harness.render.mockClear();
    const status = deferred();
    harness.api.getSessionStatus.mockReturnValueOnce(status.promise);
    const pending = harness.update('a');
    expect(harness.render).toHaveBeenCalledWith('a', cached.statusData, { id: 'a' }, cached.directoryAvailability);
    status.resolve({ summary: { text: 'New A' } });
    await pending;
    expect(harness.render).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale response when switching during the directory read', async () => {
    const harness = setup();
    const directory = deferred();
    harness.api.getSessionDirectoryAvailability.mockReturnValueOnce(directory.promise);
    const pendingA = harness.update('a');
    await Promise.resolve();
    harness.activate('b');
    await harness.update('b');
    directory.resolve({ sessionDirectoryAvailable: true });
    await pendingA;
    expect(harness.render).toHaveBeenCalledOnce();
    expect(harness.render.mock.calls[0][0]).toBe('b');
  });

  it('keeps the cache bounded across many sessions', async () => {
    const harness = setup();
    for (let index = 0; index < 60; index++) {
      const id = `session-${index}`;
      harness.activate(id);
      await harness.update(id);
    }
    expect(harness.cache.size).toBe(50);
    expect(harness.cache.has('session-0')).toBe(false);
    expect(harness.cache.has('session-59')).toBe(true);
  });

  it('preloads unvisited open sessions so their first switch renders without any IPC', async () => {
    const harness = setup();
    harness.terminals.set('a', {});
    harness.terminals.set('b', {});
    await harness.preload();
    expect(harness.cache.has('b')).toBe(true);
    harness.activate('b');
    harness.render.mockClear();
    harness.api.getSessionStatus.mockClear();
    harness.api.getSessionDirectoryAvailability.mockClear();
    const pending = harness.update('b');
    expect(harness.render).toHaveBeenCalledOnce();
    expect(harness.render.mock.calls[0][0]).toBe('b');
    expect(harness.api.getSessionStatus).not.toHaveBeenCalled();
    expect(harness.api.getSessionDirectoryAvailability).not.toHaveBeenCalled();
    await pending;
  });

  it('coalesces a switch and background read for the same session', async () => {
    const harness = setup();
    harness.terminals.set('a', {});
    const status = deferred();
    harness.api.getSessionStatus.mockReturnValueOnce(status.promise);
    const preload = harness.preload();
    const update = harness.update('a');
    expect(harness.api.getSessionStatus).toHaveBeenCalledTimes(1);
    expect(harness.api.getSessionDirectoryAvailability).toHaveBeenCalledTimes(1);
    status.resolve({ summary: { text: 'A' } });
    await Promise.all([preload, update]);
  });

  it('limits background reads to two and does not reload fresh snapshots', async () => {
    const harness = setup();
    for (const id of ['a', 'b', 'c', 'd']) harness.terminals.set(id, {});
    const gates = [deferred(), deferred()];
    harness.api.getSessionStatus
      .mockReturnValueOnce(gates[0].promise)
      .mockReturnValueOnce(gates[1].promise);
    const first = harness.preload();
    await harness.preload();
    expect(harness.api.getSessionStatus).toHaveBeenCalledTimes(2);
    gates.forEach(gate => gate.resolve({ summary: { text: 'Preloaded' } }));
    await first;
    expect(harness.api.getSessionStatus).toHaveBeenCalledTimes(4);
    await harness.preload();
    expect(harness.api.getSessionStatus).toHaveBeenCalledTimes(4);
    harness.cache.forEach(snapshot => { snapshot.readAt -= 15000; });
    await harness.preload();
    expect(harness.api.getSessionStatus).toHaveBeenCalledTimes(8);
  });

  it('caches a response for an inactive session without rendering it over the current panel', async () => {
    const harness = setup();
    const status = deferred();
    harness.api.getSessionStatus.mockReturnValueOnce(status.promise);
    const update = harness.update('a');
    harness.activate('b');
    status.resolve({ summary: { text: 'A' } });
    await update;
    expect(harness.cache.has('a')).toBe(true);
    expect(harness.render).not.toHaveBeenCalled();
  });

  it('picks up newly opened sessions during a preload pass and skips closed ones', async () => {
    const harness = setup();
    for (const id of ['a', 'b', 'closed']) harness.terminals.set(id, {});
    const gates = [deferred(), deferred()];
    harness.api.getSessionStatus
      .mockReturnValueOnce(gates[0].promise)
      .mockReturnValueOnce(gates[1].promise);
    const preload = harness.preload();
    harness.terminals.delete('closed');
    harness.terminals.set('new', {});
    gates.forEach(gate => gate.resolve({ summary: { text: 'Ready' } }));
    await preload;
    expect(harness.cache.has('new')).toBe(true);
    expect(harness.api.getSessionStatus).not.toHaveBeenCalledWith('closed');
  });
});
