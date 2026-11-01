import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const source = readFileSync(join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const fingerprintSource = source.slice(source.indexOf('function computeSidebarFingerprint('), source.indexOf('async function getAllValidSessionIds('));
const renderSource = source.slice(source.indexOf('function renderSessionList('), source.indexOf('function startRenameSession('));
const rowSource = source.slice(source.indexOf('const sidebarTimeFormatter'), source.indexOf('function renderSessionList('));
const { filterSessionsForSidebar, deriveSessionState } = require('../src/session-state');

function setup(count = 500) {
  const dom = new JSDOM('<div id="sessions"></div>');
  const document = dom.window.document;
  const list = document.getElementById('sessions');
  const built = vi.fn();
  const opened = vi.fn();
  const factory = new Function('document', 'sessionList', 'built', 'opened', 'filterSessionsForSidebar', 'deriveSessionState', `
    let currentSidebarTab = 'active';
    let historyShowsAll = false;
    let searchQuery = '';
    let sidebarCollapsed = false;
    let pendingSessionListRender = false;
    let sessionListRenderSeq = 0;
    let _lastSidebarFingerprint = null;
    const tabGroups = [];
    const sessionOrder = ['active'];
    const sessionAliveState = new Set(['active']);
    const sessionBusyState = new Map();
    const activeSessionId = null;
    const pendingSessionStarts = new Map();
    const sessionLastUsed = new Map();
    const sidebarSessionCache = new Map();
    let allSessions = [{id:'active',title:'Active'}, ...Array.from({length:${count}}, (_,i)=>({id:'history-'+i,title:'History '+i}))];
    const getSidebarSessionScope = () => currentSidebarTab === 'history' ? historyShowsAll ? 'all' : 'history' : 'active';
    const getActiveSidebarIds = () => new Set(['active']);
    const isSessionListRenderLocked = () => false;
    const ensureSessionOrder = () => {};
    const appendHistoryScopeNotice = () => {};
    const getHistoryEmptyState = () => 'Empty';
    const matchesSidebarMetadata = (s,q) => s.title.toLowerCase().includes(q);
    const patchActiveHighlight = () => {};
    const patchSessionStateBadges = () => {};
    const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
    ${rowSource}
    const realCreateSessionItem = createSessionItem;
    createSessionItem = (s, group, index) => {
      built(s.id);
      const node = realCreateSessionItem(s, group, index);
      node.addEventListener('click', () => opened(s.id));
      return node;
    };
    ${fingerprintSource}
    ${renderSource}
    return {
      render: tab => {currentSidebarTab=tab;renderSessionList();},
      update: (id, changes) => Object.assign(allSessions.find(s=>s.id===id),changes),
      search: q => {searchQuery=q;},
      empty: () => {allSessions=[];},
      append: count => {
        const start = allSessions.filter(s=>s.id.startsWith('history-')).length;
        allSessions.push(...Array.from({length:count},(_,i)=>({id:'history-'+(start+i),title:'History '+(start+i)})));
      },
      cache: sidebarListDomCache
    };
  `);
  return { ...factory(document, list, built, opened, filterSessionsForSidebar, deriveSessionState), list, built, opened, close: () => dom.window.close() };
}

describe('sidebar DOM reuse', () => {
  it('appends a new History page without recreating focused rows or their handlers', () => {
    const h = setup(100);
    try {
      h.render('history');
      const focused = h.list.firstChild;
      focused.focus();
      h.list.scrollTop = 500;
      h.built.mockClear();
      h.append(100);
      h.render('history');
      expect(h.list.children).toHaveLength(200);
      expect(h.list.firstChild).toBe(focused);
      expect(h.list.ownerDocument.activeElement).toBe(focused);
      expect(h.list.scrollTop).toBe(500);
      expect(h.built).toHaveBeenCalledTimes(100);
      focused.click();
      expect(h.opened).toHaveBeenCalledExactlyOnceWith('history-0');
    } finally { h.close(); }
  });

  it('switches 500-row History back and forth without constructing any rows again', () => {
    const h = setup();
    try {
      h.render('active');
      const activeNode = h.list.firstChild;
      h.render('history');
      expect(h.list.children).toHaveLength(500);
      const historyNode = h.list.firstChild;
      h.built.mockClear();
      for (let i = 0; i < 10; i++) {
        h.render('active');
        expect(h.list.firstChild).toBe(activeNode);
        h.render('history');
        expect(h.list.firstChild).toBe(historyNode);
      }
      expect(h.built).not.toHaveBeenCalled();
      historyNode.click();
      expect(h.opened).toHaveBeenCalledExactlyOnceWith('history-0');
    } finally { h.close(); }
  });

  it.each([
    ['title', 'Renamed'],
    ['cwd', 'C:\\changed'],
    ['updatedAt', '2026-10-26T00:00:00Z'],
    ['resources', [{ type: 'workitem', id: '1', title: 'New work item title' }]],
  ])('invalidates retained History nodes after a %s change', (field, value) => {
    const h = setup(2);
    try {
      h.render('history');
      const old = h.list.firstChild;
      h.render('active');
      h.update('history-0', { [field]: value });
      h.render('history');
      expect(h.list.firstChild).not.toBe(old);
    } finally { h.close(); }
  });

  it('does not restore a retained unfiltered list while searching', () => {
    const h = setup(3);
    try {
      h.render('history');
      h.render('active');
      h.search('history 1');
      h.render('history');
      expect(h.list.children).toHaveLength(1);
      expect(h.list.querySelector('.session-title').textContent).toBe('History 1');
    } finally { h.close(); }
  });

  it('reuses empty views and bounds retained scopes to Active, recent and all', () => {
    const h = setup(0);
    try {
      h.empty();
      h.render('history');
      const empty = h.list.firstChild;
      h.render('active');
      h.render('history');
      expect(h.list.firstChild).toBe(empty);
      expect(h.cache.size).toBe(2);
    } finally { h.close(); }
  });

  it('formats real rows with shared formatters and tolerates missing timestamps', () => {
    const dom = new JSDOM('<div></div>');
    try {
      const create = new Function('document', 'deriveSessionState', `
        const currentSidebarTab='history';const pendingSessionStarts=new Map();const sessionAliveState=new Set();
        const sessionBusyState=new Map();const sessionLastUsed=new Map();const activeSessionId=null;
        const escapeHtml = value => String(value);
        ${rowSource}
        return createSessionItem;
      `)(dom.window.document, deriveSessionState);
      const row = create({ id: 'a', title: 'Report', updatedAt: '2026-10-26T12:00:00Z' }, null, 0);
      expect(row.querySelector('.session-meta').textContent.length).toBeGreaterThan(0);
      expect(create({ id: 'b', title: 'Missing date' }, null, 1).textContent).toContain('Invalid Date');
    } finally { dom.window.close(); }
  });
});
