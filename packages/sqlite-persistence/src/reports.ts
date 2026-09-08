import type { RoomReport } from '@agent-room/shared';

import { getDb } from './db.js';

export const REPORT_TTL_SECONDS = 24 * 60 * 60;

export function saveStoredRoomReport(
  code: string,
  report: RoomReport,
  now: number = Date.now(),
): void {
  const db = getDb();

  const expiresAt = now + REPORT_TTL_SECONDS * 1000;

  db.prepare(`
    INSERT INTO reports (
      code,
      reportJson,
      expiresAt
    )
    VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE
    SET
      reportJson = excluded.reportJson,
      expiresAt = excluded.expiresAt
  `).run(
    code,
    JSON.stringify(report),
    expiresAt,
  );
}

export function getStoredRoomReport(
  code: string,
  now: number = Date.now(),
): RoomReport | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT reportJson, expiresAt
    FROM reports
    WHERE code = ?
  `).get(code) as
    | { reportJson: string; expiresAt: number }
    | undefined;

  if (!row) {
    return null;
  }

  if (row.expiresAt <= now) {
    db.prepare(`
      DELETE FROM reports
      WHERE code = ?
    `).run(code);

    return null;
  }

  return JSON.parse(row.reportJson) as RoomReport;
}

export function clearStoredRoomReport(
  code: string,
): void {
  const db = getDb();

  db.prepare(`
    DELETE FROM reports
    WHERE code = ?
  `).run(code);
}

export function pruneExpiredRoomReports(
  now: number = Date.now(),
): number {
  const db = getDb();

  const result = db.prepare(`
    DELETE FROM reports
    WHERE expiresAt <= ?
  `).run(now);

  return result.changes;
}
