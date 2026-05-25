import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

const NotificationService = require('../src/notification-service');

let tmpDir;
let svc;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsky-notif-'));
});

afterEach(() => {
  if (svc) { try { svc.stop(); } catch {} svc = null; }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('NotificationService', () => {
  it('creates the notifications directory on construction', () => {
    const dir = path.join(tmpDir, 'nested', 'notifications');
    svc = new NotificationService(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('push() adds a notification with normalized fields and emits an event', () => {
    svc = new NotificationService(tmpDir);
    let received = null;
    svc.on('notification', (n) => { received = n; });
    const n = svc.push({ title: 'Hello', body: 'World', sessionId: 's1' });
    expect(n.id).toBe(1);
    expect(n.type).toBe('info');
    expect(n.read).toBe(false);
    expect(n.timestamp).toBeTruthy();
    expect(received).toBe(n);
  });

  it('assigns increasing ids', () => {
    svc = new NotificationService(tmpDir);
    const a = svc.push({ title: 'a' });
    const b = svc.push({ title: 'b' });
    const c = svc.push({ title: 'c' });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
  });

  it('getUnreadCount and markRead behave correctly', () => {
    svc = new NotificationService(tmpDir);
    const a = svc.push({ title: 'a' });
    svc.push({ title: 'b' });
    expect(svc.getUnreadCount()).toBe(2);
    svc.markRead(a.id);
    expect(svc.getUnreadCount()).toBe(1);
  });

  it('markAllRead marks every notification read', () => {
    svc = new NotificationService(tmpDir);
    svc.push({ title: 'a' });
    svc.push({ title: 'b' });
    svc.markAllRead();
    expect(svc.getUnreadCount()).toBe(0);
  });

  it('dismiss removes a notification by id', () => {
    svc = new NotificationService(tmpDir);
    const a = svc.push({ title: 'a' });
    svc.push({ title: 'b' });
    svc.dismiss(a.id);
    expect(svc.getAll()).toHaveLength(1);
  });

  it('clearAll empties the list', () => {
    svc = new NotificationService(tmpDir);
    svc.push({ title: 'a' });
    svc.push({ title: 'b' });
    svc.clearAll();
    expect(svc.getAll()).toEqual([]);
  });

  it('getUnreadCountForSession filters by sessionId', () => {
    svc = new NotificationService(tmpDir);
    svc.push({ title: 'a', sessionId: 's1' });
    svc.push({ title: 'b', sessionId: 's2' });
    svc.push({ title: 'c', sessionId: 's1' });
    expect(svc.getUnreadCountForSession('s1')).toBe(2);
    expect(svc.getUnreadCountForSession('s2')).toBe(1);
    expect(svc.getUnreadCountForSession('nope')).toBe(0);
  });

  it('persists state across instances', () => {
    svc = new NotificationService(tmpDir);
    svc.push({ title: 'persisted' });
    svc.stop();
    svc = new NotificationService(tmpDir);
    const all = svc.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('persisted');
  });

  it('processes existing JSON notification files when start() is called', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'one.json'),
      JSON.stringify({ type: 'task-done', title: 'Completed', body: 'Build OK', sessionId: 's1' }),
      'utf8',
    );
    svc = new NotificationService(tmpDir);
    svc.start();
    svc.stop();
    const all = svc.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('task-done');
    expect(all[0].title).toBe('Completed');
    // File is consumed
    expect(fs.existsSync(path.join(tmpDir, 'one.json'))).toBe(false);
  });

  it('deletes invalid JSON notification files', () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{ not json', 'utf8');
    svc = new NotificationService(tmpDir);
    svc.start();
    svc.stop();
    expect(svc.getAll()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, 'bad.json'))).toBe(false);
  });
});
