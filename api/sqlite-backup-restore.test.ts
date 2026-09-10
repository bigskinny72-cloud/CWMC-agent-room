import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupDb, closeDb, getDb, openDb, restoreDbFromBackup,
} from '@agent-room/sqlite-persistence';

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-room-b5-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  closeDb();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite-safe backup and restore', () => {
  it('backs up committed WAL data into a standalone database', async () => {
    const dir = tempDir();
    const live = join(dir, 'live.sqlite');
    const backup = join(dir, 'backups', 'room.sqlite');
    openDb(live, 'create');
    getDb().prepare('INSERT INTO message_counts (code, totalCount) VALUES (?, ?)').run('B5', 41);
    await backupDb(backup);
    expect(existsSync(backup)).toBe(true);
    const check = new (await import('better-sqlite3')).default(backup, { readonly: true });
    expect(check.prepare('SELECT totalCount FROM message_counts WHERE code = ?').get('B5')).toEqual({ totalCount: 41 });
    expect(check.pragma('quick_check', { simple: true })).toBe('ok');
    check.close();
  });

  it('restores only while offline and preserves the backed-up state', async () => {
    const dir = tempDir();
    const live = join(dir, 'live.sqlite');
    const backup = join(dir, 'backup.sqlite');
    const restored = join(dir, 'restored.sqlite');
    openDb(live, 'create');
    getDb().prepare('INSERT INTO message_counts (code, totalCount) VALUES (?, ?)').run('B5', 7);
    await backupDb(backup);
    expect(() => restoreDbFromBackup(backup, restored)).toThrow(/requires.*closed/i);
    closeDb();
    restoreDbFromBackup(backup, restored);
    openDb(restored, 'open');
    expect(getDb().prepare('SELECT totalCount FROM message_counts WHERE code = ?').get('B5')).toEqual({ totalCount: 7 });
  });

  it('refuses destructive or ambiguous backup/restore targets', async () => {
    const dir = tempDir();
    const live = join(dir, 'live.sqlite');
    const backup = join(dir, 'backup.sqlite');
    openDb(live, 'create');
    await expect(backupDb(live)).rejects.toThrow(/must differ/i);
    await backupDb(backup);
    await expect(backupDb(backup)).rejects.toThrow(/already exists/i);
    closeDb();
    expect(() => restoreDbFromBackup(backup, live)).toThrow(/already exists/i);
  });
});
