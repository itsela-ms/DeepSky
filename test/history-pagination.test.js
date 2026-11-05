import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';

const SessionService = require('../src/session-service');
const source = readFileSync(join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const refreshSource = source.slice(source.indexOf('const sidebarSessionCache = new Map();'), source.indexOf('// Compact, stable fingerprint'));

describe('History scope header', () => {
  it.each([false, true])('separates text, wrapping actions and loaded count for all=%s', showAll => {
    const dom = new JSDOM('<div id="list"></div>');
    try {
      const list = dom.window.document.getElementById('list');
      const code = source.slice(source.indexOf('function appendHistoryScopeNotice('), source.indexOf('function getSidebarSessionScope('));
      const helpers = require('../src/history-limit');
      const append = new Function('document', 'sessionList', 'getHistoryScopeStatusNotice', 'getHistoryScopeActionLabel', `
        const currentSidebarTab='history', sidebarCollapsed=false, searchQuery='';
        const historyShowsAll=${showAll};
        const getSidebarSessionScope=()=>historyShowsAll?'all':'history';
        const sidebarSessionCache=new Map([[getSidebarSessionScope(),{sessions:Array(100),nextCursor:{offset:100}}]]);
        ${code}
        return appendHistoryScopeNotice;
      `)(dom.window.document, list, helpers.getHistoryScopeStatusNotice, helpers.getHistoryScopeActionLabel);
      append();
      const header = list.querySelector('.history-scope-note');
      expect([...header.children].map(node => node.className)).toEqual([
        'history-scope-note-copy', 'history-scope-actions', 'history-page-status',
      ]);
      const buttons = [...header.querySelector('.history-scope-actions').children];
      expect(buttons.map(button => button.textContent)).toEqual([
        showAll ? 'Show recent history' : 'Show all history', 'Refresh history',
      ]);
      expect(buttons.every(button => button.tagName === 'BUTTON' && button.type === 'button')).toBe(true);
      expect(header.querySelector('[role="status"]').textContent).toContain('100 sessions loaded');
    } finally { dom.window.close(); }
  });
});

function serviceWithSessions(count, excluded = []) {
  const service = new SessionService('synthetic-state');
  const now = Date.now();
  service._readSessionEntries = vi.fn(async () => Array.from({ length: count }, (_, i) => ({ name: `s-${i}` })));
  service._getSessionLastModifiedHint = vi.fn(async entry => now - Number(entry.name.slice(2)) * 1000);
  service._loadSession = vi.fn(async entry => ({
    id: entry.name, title: entry.name, updatedAt: new Date(now).toISOString(), lastModified: now,
  }));
  return { service, excluded };
}

describe('history page service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('pages a real inventory without caching metadata beyond the requested batch', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'deepsky-history-pages-'));
    try {
      await Promise.all(Array.from({ length: 205 }, async (_, index) => {
        const dir = join(root, `session-${String(index).padStart(3, '0')}`);
        const date = new Date(Date.UTC(2026, 9, 1, 0, 0, 205 - index));
        await fs.mkdir(dir);
        const workspace = join(dir, 'workspace.yaml');
        await fs.writeFile(workspace, `name: Session ${index}\n`);
        await fs.utimes(workspace, date, date);
        await fs.utimes(dir, date, date);
      }));
      const service = new SessionService(root);
      const first = await service.listHistoryPage({ scope: 'all' });
      expect(first.sessions).toHaveLength(100);
      expect(first.sessions[0].title).toBe('Session 0');
      expect(service._sessionCache.size).toBe(100);
      const second = await service.listHistoryPage({ scope: 'all', cursor: first.nextCursor });
      expect(second.sessions[0].title).toBe('Session 100');
      expect(service._sessionCache.size).toBe(200);
      const last = await service.listHistoryPage({ scope: 'all', cursor: second.nextCursor });
      expect(last.sessions).toHaveLength(5);
      expect(last.nextCursor).toBeNull();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('hydrates only 100 initial entries and the next 100 on a stable cursor', async () => {
    const { service } = serviceWithSessions(250);
    const first = await service.listHistoryPage();
    expect(first.sessions).toHaveLength(100);
    expect(service._loadSession).toHaveBeenCalledTimes(100);
    service._readSessionEntries.mockResolvedValue([{ name: 'new-session' }]);
    const second = await service.listHistoryPage({ cursor: first.nextCursor });
    const third = await service.listHistoryPage({ cursor: second.nextCursor });
    expect(second.sessions).toHaveLength(100);
    expect(second.sessions[0].id).toBe('s-100');
    expect(third.sessions).toHaveLength(50);
    expect(third.nextCursor).toBeNull();
    expect(new Set([...first.sessions, ...second.sessions, ...third.sessions].map(s => s.id)).size).toBe(250);
    expect(service._readSessionEntries).toHaveBeenCalledOnce();
  });

  describe('history page IPC wiring', () => {
    function setup() {
      const main = readFileSync(join(__dirname, '..', 'src', 'main.js'), 'utf8');
      const code = main.slice(main.indexOf('  let allSessionsCache = [];'), main.indexOf("  ipcMain.handle('sessions:search'"));
      const handlers = new Map();
      const page = { sessions: [{ id: 'report' }], nextCursor: { snapshotId: 'snapshot', offset: 100 } };
      const service = {
        listSessions: vi.fn(async () => [{ id: 'open' }]),
        listHistoryPage: vi.fn(async () => page),
      };
      new Function('ipcMain', 'sessionService', 'settingsService', 'ptyManager', 'tagIndexer', 'resourceIndexer', code)(
        { handle: (name, fn) => handlers.set(name, fn) }, service,
        { get: () => ({ openTabs: ['open'] }) },
        { getActiveSessions: () => [{ id: 'live' }] },
        { getTagsForSession: id => [`tag:${id}`] },
        { getResourcesForSession: () => [{ type: 'pr', id: '123' }] },
      );
      return { handlers, service, page };
    }

    it('forwards list options rather than mistaking the Electron event for options', async () => {
      const { handlers, service } = setup();
      await handlers.get('sessions:list')({ sender: {} }, { scope: 'all' });
      expect(service.listSessions).toHaveBeenCalledWith({ scope: 'all' });
      await handlers.get('sessions:list')({ sender: {} }, { scope: 'history' });
      expect(service.listSessions).toHaveBeenLastCalledWith({ scope: 'history' });
    });

    it('keeps Active loading restricted to saved, running and renderer-open tabs', async () => {
      const { handlers, service } = setup();
      await handlers.get('sessions:list')({}, { scope: 'active', activeIds: ['renderer', 'open'] });
      expect(service.listSessions).toHaveBeenCalledWith({ ids: ['open', 'live', 'renderer'] });
    });

    it('forwards page cursors/exclusions and returns source metadata with the cursor intact', async () => {
      const { handlers, service, page } = setup();
      const cursor = { snapshotId: 'previous', offset: 100 };
      const response = await handlers.get('sessions:historyPage')({}, { scope: 'all', cursor, excludeIds: ['open', 'live'] });
      expect(service.listHistoryPage).toHaveBeenCalledWith({ scope: 'all', cursor, excludeIds: ['open', 'live'] });
      expect(response.nextCursor).toEqual(page.nextCursor);
      expect(response.sessions).toEqual([{ id: 'report', tags: ['tag:report'], resources: [{ type: 'pr', id: '123' }] }]);
    });

    it('exposes the paged IPC request through the sandboxed preload API', async () => {
      let api;
      const invoke = vi.fn(async () => ({ sessions: [], nextCursor: null }));
      const preload = readFileSync(join(__dirname, '..', 'src', 'preload.js'), 'utf8');
      new Function('require', preload)(() => ({
        contextBridge: { exposeInMainWorld: (name, value) => { api = value; } },
        ipcRenderer: { invoke },
      }));
      await api.listHistoryPage({ scope: 'history', cursor: null });
      expect(invoke).toHaveBeenCalledWith('sessions:historyPage', { scope: 'history', cursor: null });
    });
  });

  it('fills a page past removed entries and excludes active sessions before counting', async () => {
    const { service } = serviceWithSessions(210);
    const original = service._loadSession.getMockImplementation();
    service._loadSession.mockImplementation(entry => entry.name === 's-1' ? null : original(entry));
    const first = await service.listHistoryPage({ excludeIds: ['s-0', 's-2'] });
    expect(first.sessions).toHaveLength(100);
    expect(first.sessions[0].id).toBe('s-3');
    const second = await service.listHistoryPage({ cursor: first.nextCursor, excludeIds: ['s-104'] });
    expect(second.sessions).toHaveLength(100);
    expect(second.sessions.some(s => s.id === 's-104')).toBe(false);
  });

  it('preserves the recent cap but pages all-history past 500', async () => {
    const { service } = serviceWithSessions(650);
    for (const [scope, expected] of [['history', 500], ['all', 650]]) {
      let cursor = null;
      const ids = [];
      do {
        const page = await service.listHistoryPage({ scope, cursor });
        ids.push(...page.sessions.map(s => s.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toHaveLength(expected);
    }
  });

  it('filters old metadata from recent History but retains it in all History', async () => {
    const { service } = serviceWithSessions(2);
    service._loadSession.mockResolvedValue({ id: 'old', updatedAt: '2000-01-01', lastModified: 1 });
    expect((await service.listHistoryPage()).sessions).toEqual([]);
    expect((await service.listHistoryPage({ scope: 'all' })).sessions).toHaveLength(2);
  });

  it('rejects invalid, expired and wrong-scope cursors and bounds retained catalogs', async () => {
    const { service } = serviceWithSessions(120);
    const first = await service.listHistoryPage();
    await expect(service.listHistoryPage({ scope: 'all', cursor: first.nextCursor })).rejects.toThrow();
    await expect(service.listHistoryPage({ cursor: { ...first.nextCursor, offset: -1 } })).rejects.toThrow();
    for (let i = 0; i < 9; i++) await service.listHistoryPage();
    expect(service._historyCatalogs.size).toBe(8);
    await expect(service.listHistoryPage({ cursor: first.nextCursor })).rejects.toThrow('expired');
  });

  it('loads Active metadata by ID without enumerating the History directory', async () => {
    const { service } = serviceWithSessions(1000);
    expect((await service.listSessions({ ids: ['s-4', 's-8', 's-4'] })).map(s => s.id)).toEqual(['s-4', 's-8']);
    expect(service._readSessionEntries).not.toHaveBeenCalled();
    expect(service._loadSession).toHaveBeenCalledTimes(2);
    await expect(service.listSessions({ ids: ['..'] })).rejects.toThrow('Invalid');
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function rendererSetup() {
  const dom = new JSDOM('<div id="list"></div>');
  const list = dom.window.document.getElementById('list');
  let markerPositions = new Map();
  list.getBoundingClientRect = () => ({ bottom: 600 });
  const render = vi.fn(ids => {
    list.replaceChildren(...ids.map((id, i) => {
      const row = dom.window.document.createElement('button');
      row.className = 'session-item';
      row.dataset.sessionId = id;
      row.getBoundingClientRect = () => ({ top: markerPositions.get(i) ?? 10000 });
      return row;
    }));
  });
  const api = {
    listHistoryPage: vi.fn(async () => ({
      sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` })),
      nextCursor: { snapshotId: 'snapshot', offset: 100 },
    })),
    listSessions: vi.fn(async () => [{ id: 'active' }]),
  };
  const factory = new Function('window', 'sessionList', 'render', `
    let currentSidebarTab = 'history', searchQuery = '', scope = 'history', activeSessionId = null;
    let allSessions = [], _lastSidebarFingerprint = null;
    const HISTORY_PRELOAD_REMAINING = 50;
    const sidebarListDomCache = new Map();
    const terminals = new Map(), pendingSessionStarts = new Map(), sessionLastUsed = new Map();
    const emptyState = {classList:{remove(){}}};
    const getSidebarSessionScope = () => scope;
    const getActiveSidebarIds = () => new Set();
    const isSessionListRenderLocked = () => false;
    const mergePendingSessionStarts = () => {};
    const updateTabTitle = () => {};
    const updateSessionPromptGhost = () => {};
    const updateSessionBusyStates = async () => {};
    const showToast = () => {};
    const renderSessionList = () => render(allSessions.map(s=>s.id));
    const scheduleRenderSessionList = renderSessionList;
    ${refreshSource}
    return {
      refresh: refreshSessionList, preload: maybePreloadHistoryPage, cache: sidebarSessionCache,
      next: () => historyPageReads.get(scope),
      activate: (tab, query='') => {currentSidebarTab=tab;searchQuery=query;scope=tab==='active'?'active':'history';},
      load: loadNextHistoryPage,
      invalidate: invalidateSidebarSessionSnapshots,
      read: readSidebarSessionSnapshot
    };
  `);
  return { ...factory({ api }, list, render), list, api, render, positions: values => { markerPositions = new Map(values); }, close: () => dom.window.close() };
}

describe('history scroll preloading', () => {
  it('continues polling live states without resetting a loaded History snapshot', async () => {
    const pollSource = source.slice(source.indexOf('async function pollSessionStatus()'), source.indexOf('setInterval(pollSessionStatus'));
    const refresh = vi.fn(async () => {});
    const busy = vi.fn(async () => {});
    const render = vi.fn();
    const poll = new Function('refreshSessionList', 'updateSessionBusyStates', 'scheduleRenderSessionList', `
      const terminals = new Map([['active', {}]]);
      const currentSidebarTab = 'history', searchQuery = '';
      const sidebarSessionCache = new Map([['history', {paged:true}]]);
      const getSidebarSessionScope = () => 'history';
      const refreshOpenSessionStatuses = async () => {};
      const patchSessionStateBadges = () => {};
      ${pollSource}
      return pollSessionStatus;
    `)(refresh, busy, render);
    await poll();
    expect(refresh).toHaveBeenCalledWith({ useCached: true });
    expect(busy).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
  });

  it('requests at row 50, then 150, and deduplicates repeated scroll events', async () => {
    const h = rendererSetup();
    try {
      await h.refresh();
      expect(h.list.children).toHaveLength(100);
      h.api.listHistoryPage.mockClear();
      h.positions([[49, 601]]);
      h.preload();
      expect(h.api.listHistoryPage).not.toHaveBeenCalled();
      const next = deferred();
      h.api.listHistoryPage.mockReturnValueOnce(next.promise);
      h.positions([[49, 600]]);
      h.list.dispatchEvent(new h.list.ownerDocument.defaultView.Event('scroll'));
      h.preload();
      expect(h.api.listHistoryPage).toHaveBeenCalledOnce();
      expect(h.api.listHistoryPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { snapshotId: 'snapshot', offset: 100 } }));
      h.list.scrollTop = 320;
      next.resolve({ sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s-${i + 100}` })), nextCursor: { snapshotId: 'snapshot', offset: 200 } });
      await h.next();
      expect(h.list.children).toHaveLength(200);
      expect(h.list.scrollTop).toBe(320);
      h.preload();
      expect(h.api.listHistoryPage).toHaveBeenCalledOnce();
      h.positions([[149, 600]]);
      h.api.listHistoryPage.mockResolvedValueOnce({
        sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s-${i + 200}` })),
        nextCursor: { snapshotId: 'snapshot', offset: 300 },
      });
      h.preload();
      await h.next();
      expect(h.list.children).toHaveLength(300);
      h.preload();
      expect(h.api.listHistoryPage).toHaveBeenCalledTimes(2);
      h.positions([[249, 600]]);
      h.api.listHistoryPage.mockResolvedValueOnce({ sessions: [{ id: 's-300' }], nextCursor: null });
      h.preload();
      await h.next();
      expect(h.list.children).toHaveLength(301);
      h.preload();
      expect(h.api.listHistoryPage).toHaveBeenCalledTimes(3);
    } finally { h.close(); }
  });

  it('caches a late page without painting over Active or full-scope search', async () => {
    const h = rendererSetup();
    try {
      await h.refresh();
      const page = deferred();
      h.api.listHistoryPage.mockReturnValueOnce(page.promise);
      h.positions([[49, 500]]);
      h.preload();
      const pending = h.next();
      h.activate('active');
      await h.refresh();
      h.render.mockClear();
      page.resolve({ sessions: [{ id: 'older' }], nextCursor: null });
      await pending;
      expect(h.render).not.toHaveBeenCalled();
      expect(h.cache.get('history').sessions).toHaveLength(101);
      h.activate('history', 'query');
      h.preload();
      expect(h.api.listHistoryPage).toHaveBeenCalledTimes(2);
    } finally { h.close(); }
  });

  it('rejects a failed page without advancing its cursor and retries explicitly', async () => {
    const h = rendererSetup();
    try {
      await h.refresh();
      const snapshot = h.cache.get('history');
      h.api.listHistoryPage.mockRejectedValueOnce(new Error('Read failed'));
      await expect(h.load('history', snapshot)).rejects.toThrow('Read failed');
      expect(snapshot.sessions).toHaveLength(100);
      expect(snapshot.nextCursor.offset).toBe(100);
      h.api.listHistoryPage.mockResolvedValueOnce({ sessions: [{ id: 'older' }, { id: 's-0' }], nextCursor: null });
      await h.load('history', snapshot);
      expect(snapshot.sessions).toHaveLength(101);
    } finally { h.close(); }
  });

  it('drops a page from a replaced snapshot after Refresh history', async () => {
    const h = rendererSetup();
    try {
      await h.refresh();
      const old = h.cache.get('history');
      const page = deferred();
      h.api.listHistoryPage.mockReturnValueOnce(page.promise);
      const pending = h.load('history', old);
      await h.refresh();
      h.render.mockClear();
      page.resolve({ sessions: [{ id: 'obsolete' }], nextCursor: null });
      await pending;
      expect(h.cache.get('history')).not.toBe(old);
      expect(h.cache.get('history').sessions.some(s => s.id === 'obsolete')).toBe(false);
      expect(h.render).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it('keeps pages across cached tab switches and uses full metadata inventory only for search', async () => {
    const h = rendererSetup();
    try {
      await h.refresh();
      h.api.listHistoryPage.mockClear();
      await h.refresh({ useCached: true });
      expect(h.api.listHistoryPage).not.toHaveBeenCalled();
      h.activate('history', 'query');
      await h.refresh();
      expect(h.api.listSessions).toHaveBeenCalledWith({ scope: 'history' });
      expect(h.cache.get('history').paged).toBe(false);
      h.activate('history');
      await h.refresh();
      expect(h.cache.get('history').paged).toBe(true);
      expect(h.cache.get('history').sessions).toHaveLength(100);
    } finally { h.close(); }
  });

  it('does not allow a late full-search result to replace a newer paginated snapshot', async () => {
    const h = rendererSetup();
    try {
      h.activate('history', 'query');
      const search = deferred();
      h.api.listSessions.mockReturnValueOnce(search.promise);
      const pendingSearch = h.refresh();
      h.activate('history');
      await h.refresh();
      search.resolve([{ id: 'search-only' }]);
      await pendingSearch;
      expect(h.cache.get('history').paged).toBe(true);
      expect(h.cache.get('history').sessions).toHaveLength(100);
      expect(h.list.children).toHaveLength(100);
    } finally { h.close(); }
  });

  it('invalidates pending reads when a title setting changes', async () => {
    const h = rendererSetup();
    try {
      const page = deferred();
      h.api.listHistoryPage.mockReturnValueOnce(page.promise);
      const pending = h.refresh();
      h.invalidate();
      page.resolve({ sessions: [{ id: 'old-title' }], nextCursor: null });
      await pending;
      expect(h.cache.size).toBe(0);
      expect(h.list.children).toHaveLength(0);
      await h.refresh();
      expect(h.cache.get('history').sessions).toHaveLength(100);
    } finally { h.close(); }
  });
});
