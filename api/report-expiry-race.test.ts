import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoomReport } from '@agent-room/shared';
import {
  closeDb,
  getDb,
  getStoredRoomReport,
  openDb,
  REPORT_TTL_SECONDS,
  saveStoredRoomReport,
} from '@agent-room/sqlite-persistence';

let tempDir: string;

function report(code: string, exportedAt: number): RoomReport {
  return {
    code,
    topic: 'B2b report expiry race',
    createdAt: 1,
    exportedAt,
    participants: [],
    messageCount: 0,
    summary: `report-${exportedAt}`,
    highlights: [],    decisions: [],
    actionItems: [],
    artifacts: [],
    transcript: [],
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-room-b2b-'));
  openDb(join(tempDir, 'test.sqlite'), 'create');
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test('expired cleanup does not delete a concurrently refreshed report', () => {
  const code = 'B2B-RACE-001';
  const expiredSavedAt = 1_000;
  const readAt = expiredSavedAt + REPORT_TTL_SECONDS * 1000 + 1;
  const freshSavedAt = readAt + 10_000;
  const expired = report(code, expiredSavedAt);
  const fresh = report(code, freshSavedAt);

  saveStoredRoomReport(code, expired, expiredSavedAt);
  const db = getDb();
  const observed = db.prepare(`
    SELECT expiresAt FROM reports WHERE code = ?
  `).get(code) as { expiresAt: number };

  // Simulate the race: a writer refreshes the report after the reader observed
  // the expired row but before that reader performs its lazy cleanup DELETE.
  saveStoredRoomReport(code, fresh, freshSavedAt);

  const result = db.prepare(`
    DELETE FROM reports
    WHERE code = ? AND expiresAt = ? AND expiresAt <= ?
  `).run(code, observed.expiresAt, readAt);

  expect(result.changes).toBe(0);
  expect(getStoredRoomReport(code, readAt)).toEqual(fresh);
});

test('expired cleanup still removes the expired version when unchanged', () => {
  const code = 'B2B-EXP-0001';
  const savedAt = 2_000;
  const readAt = savedAt + REPORT_TTL_SECONDS * 1000;
  saveStoredRoomReport(code, report(code, savedAt), savedAt);

  expect(getStoredRoomReport(code, readAt)).toBeNull();
  const remaining = getDb().prepare('SELECT code FROM reports WHERE code = ?').get(code);
  expect(remaining).toBeUndefined();
});