import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const source = readFileSync(join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const refreshSource = source.slice(
  source.indexOf('const sidebarSessionCache = new Map();'),
  source.indexOf('// Compact, stable fingerprint')
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const api = { listSessions: vi.fn(async ({ scope }) => [{ id: scope, title: scope }]) };
  api.listHistoryPage = vi.fn(async options => ({ sessions: await api.listSessions(options), nextCursor: null }));
  const render = vi.fn();
  const busy = vi.fn().mockResolvedValue(undefined);
  const toast = vi.fn();
  const body = { innerHTML: '', addEventListener: vi.fn() };
  const activeIds = new Set();
  const factory = new Function('window', 'render', 'busy', 'showToast', 'sessionList', 'activeIds', `
    let scope = 'active';
    let currentSidebarTab = 'active';
    let searchQuery = '';
    const HISTORY_PRELOAD_REMAINING = 50;
    let allSessions = [];
    let activeSessionId = null;
    let _lastSidebarFingerprint = null;
    const terminals = new Map();
    const pendingSessionStarts = new Map();
    const sessionLastUsed = new Map();
    const emptyState = { classList: { remove() {} } };
    const getSidebarSessionScope = () => scope;
    const getActiveSidebarIds = () => activeIds;
    const mergePendingSessionStarts = () => {};
    const updateTabTitle = () => {};
    const updateSessionPromptGhost = () => {};
    const renderSessionList = () => render(allSessions.map(s => s.id));
    const scheduleRenderSessionList = renderSessionList;
    const updateSessionBusyStates = busy;
    ${refreshSource}
    return {
      refresh: refreshSessionList, cache: sidebarSessionCache,
      read: readSidebarSessionSnapshot,
      switchTo: next => { scope = next; currentSidebarTab = next === 'active' ? 'active' : 'history'; return refreshSessionList({ useCached: true }); },
      sessions: () => allSessions
    };
  `);
  return { ...factory({ api }, render, busy, toast, body, activeIds), api, render, busy, toast, body, activeIds };
}

describe('sidebar tab switching', () => {
  it('wires real tab clicks to immediate cached rendering and ignores the selected tab', async () => {
    const h = setup();
    await h.refresh();
    await h.read('history');
    h.api.listSessions.mockClear();
    const dom = new JSDOM('<button class="sidebar-tab active" data-tab="active">Active</button><button class="sidebar-tab" data-tab="history">History</button>');
    try {
      const wiring = source.slice(source.indexOf('// Sidebar tab switching'), source.indexOf('// Settings modal'));
      const updateSettings = vi.fn();
      let selectedTab;
      const refresh = vi.fn(options => {
        expect(options).toEqual({ useCached: true });
        return h.switchTo(selectedTab());
      });
      selectedTab = new Function('document', 'refreshSessionList', 'window', 'reportSidebarRefreshError', `
        let currentSidebarTab = 'active';
        ${wiring}
        return () => currentSidebarTab;
      `)(dom.window.document, refresh, { api: { updateSettings } }, vi.fn());
      dom.window.document.querySelector('[data-tab="history"]').click();
      expect(h.render).toHaveBeenLastCalledWith(['history']);
      expect(dom.window.document.querySelector('[data-tab="history"]').classList.contains('active')).toBe(true);
      expect(updateSettings).toHaveBeenCalledWith({ lastActiveTab: 'history' });
      dom.window.document.querySelector('[data-tab="history"]').click();
      expect(refresh).toHaveBeenCalledOnce();
      expect(h.api.listSessions).not.toHaveBeenCalled();
      await Promise.resolve();
    } finally {
      dom.window.close();
    }
  });

  it('preloads History while Active is displayed, then switches without IPC', async () => {
    const h = setup();
    await h.refresh();
    await h.read('history');
    h.api.listSessions.mockClear();
    h.busy.mockClear();
    h.render.mockClear();
    const switching = h.switchTo('history');
    expect(h.render).toHaveBeenCalledWith(['history']);
    expect(h.api.listSessions).not.toHaveBeenCalled();
    expect(h.busy).not.toHaveBeenCalled();
    await switching;
  });

  it('paints a stale snapshot synchronously while the list refresh is pending', async () => {
    const h = setup();
    h.cache.set('history', { sessions: [{ id: 'old' }], readAt: 0 });
    const fresh = deferred();
    h.api.listSessions.mockReturnValueOnce(fresh.promise);
    const switching = h.switchTo('history');
    expect(h.render).toHaveBeenCalledWith(['old']);
    fresh.resolve([{ id: 'new' }]);
    await switching;
    expect(h.render).toHaveBeenLastCalledWith(['new']);
  });

  it('schedules refreshed rows before waiting for busy-state IPC', async () => {
    const h = setup();
    const busy = deferred();
    h.busy.mockReturnValueOnce(busy.promise);
    const refresh = h.refresh();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.render).toHaveBeenCalledWith(['active']);
    expect(h.render).toHaveBeenCalledOnce();
    busy.resolve();
    await refresh;
    expect(h.render).toHaveBeenCalledTimes(2);
  });

  it('does not repaint an old scope when its busy-state refresh finishes late', async () => {
    const h = setup();
    const busy = deferred();
    h.busy.mockReturnValueOnce(busy.promise);
    const refresh = h.refresh();
    await new Promise(resolve => setImmediate(resolve));
    await h.switchTo('history');
    const calls = h.render.mock.calls.length;
    busy.resolve();
    await refresh;
    expect(h.render).toHaveBeenCalledTimes(calls);
    expect(h.render).toHaveBeenLastCalledWith(['history']);
  });

  it('coalesces concurrent list requests for the same scope', async () => {
    const h = setup();
    const read = deferred();
    h.api.listSessions.mockReturnValueOnce(read.promise);
    const first = h.read('history');
    const second = h.read('history');
    expect(first).toBe(second);
    expect(h.api.listSessions).toHaveBeenCalledOnce();
    read.resolve([]);
    await first;
  });

  it('ignores a late History response after switching back to Active', async () => {
    const h = setup();
    h.cache.set('active', { sessions: [{ id: 'active' }], readAt: Date.now() });
    const history = deferred();
    h.api.listSessions.mockReturnValueOnce(history.promise);
    const switching = h.switchTo('history');
    expect(h.body.innerHTML).toContain('Loading sessions');
    await h.switchTo('active');
    history.resolve([{ id: 'history' }]);
    await switching;
    expect(h.sessions().map(s => s.id)).toEqual(['active']);
    expect(h.render).toHaveBeenLastCalledWith(['active']);
    expect(h.cache.get('history').sessions).toEqual([{ id: 'history' }]);
  });

  it('keeps all-history and recent-history snapshots separate', async () => {
    const h = setup();
    h.cache.set('all', { sessions: [{ id: 'older' }], readAt: Date.now() });
    h.cache.set('history', { sessions: [{ id: 'recent' }], readAt: Date.now() });
    await h.switchTo('all');
    expect(h.render).toHaveBeenLastCalledWith(['older']);
    await h.switchTo('history');
    expect(h.render).toHaveBeenLastCalledWith(['recent']);
  });

  it('preserves open-session metadata omitted from the recent History window', async () => {
    const h = setup();
    await h.refresh();
    h.activeIds.add('active');
    await h.read('history');
    await h.switchTo('history');
    expect(h.sessions().map(s => s.id)).toEqual(['history', 'active']);
  });

  it('does not permanently cache failed reads and allows a retry', async () => {
    const h = setup();
    h.api.listSessions.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(h.read('history')).rejects.toThrow('Disk unavailable');
    expect(h.cache.has('history')).toBe(false);
    await expect(h.read('history')).resolves.toMatchObject({ sessions: [{ id: 'history' }] });
    expect(h.api.listSessions).toHaveBeenCalledTimes(2);
  });

  it('propagates titles without treating an Active subset as a deletion inventory', async () => {
    const h = setup();
    h.cache.set('history', { sessions: [{ id: 'kept', title: 'Old name' }, { id: 'deleted' }], readAt: 0 });
    h.api.listSessions.mockResolvedValueOnce([{ id: 'kept', title: 'Manual name' }]);
    await h.read('active');
    expect(h.cache.get('history').sessions).toEqual([{ id: 'kept', title: 'Manual name' }, { id: 'deleted' }]);
  });

  it('does not treat sessions outside the limited History response as deleted', async () => {
    const h = setup();
    h.cache.set('active', { sessions: [{ id: 'older' }, { id: 'recent', title: 'Old name' }], readAt: 0 });
    h.api.listSessions.mockResolvedValueOnce([{ id: 'recent', title: 'Updated' }]);
    await h.read('history');
    expect(h.cache.get('active').sessions).toEqual([{ id: 'older' }, { id: 'recent', title: 'Updated' }]);
  });

  it('reuses a preloaded Active list synchronously when returning from History', async () => {
    const h = setup();
    await h.switchTo('history');
    await h.read('active');
    h.api.listSessions.mockClear();
    h.render.mockClear();
    const returning = h.switchTo('active');
    expect(h.render).toHaveBeenCalledWith(['active']);
    expect(h.api.listSessions).not.toHaveBeenCalled();
    await returning;
  });
});
