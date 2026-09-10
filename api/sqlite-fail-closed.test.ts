import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '@agent-room/sqlite-persistence';

const temps: string[] = [];
function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-room-b4-'));
  temps.push(dir);
  return join(dir, name);
}

afterEach(() => {
  closeDb();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite startup fails closed', () => {
  it('rejects a file that is not a SQLite database', () => {
    const path = tempPath('corrupt.sqlite');
    writeFileSync(path, 'not a sqlite database');
    expect(() => openDb(path, 'open')).toThrow(/Failed to open SQLite database/);
  });

  it('rejects a versioned database whose required schema is missing', () => {
    const path = tempPath('missing-schema.sqlite');
    const raw = new Database(path);
    raw.pragma('user_version = 1');
    raw.close();
    expect(() => openDb(path, 'open')).toThrow(/missing required table/i);
  });

  it('rejects a versioned table with missing required columns', () => {
    const path = tempPath('bad-columns.sqlite');
    openDb(path, 'create');
    closeDb();
    const raw = new Database(path);
    raw.exec('DROP TABLE rooms; CREATE TABLE rooms (code TEXT PRIMARY KEY);');
    raw.close();
    expect(() => openDb(path, 'open')).toThrow(/rooms is missing required column/i);
  });

  it('does not create a missing parent directory in open mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-room-b4-parent-'));
    temps.push(root);
    const parent = join(root, 'must-not-exist');
    const path = join(parent, 'room.sqlite');
    expect(() => openDb(path, 'open')).toThrow(/Database not found/);
    expect(existsSync(parent)).toBe(false);
  });
  it('rejects integrity-check failure instead of creating a replacement', () => {
    const path = tempPath('truncated.sqlite');
    openDb(path, 'create');
    closeDb();
    const bytes = Buffer.alloc(100, 0);
    writeFileSync(path, bytes);
    expect(() => openDb(path, 'open')).toThrow(/Failed to open SQLite database/);
  });
});
