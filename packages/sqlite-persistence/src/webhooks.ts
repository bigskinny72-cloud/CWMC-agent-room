export interface StoredRoomWebhook {
  id: string;
  url: string;
  registeredBy: string;
  secret?: string;
  createdAt: number;
  failCount?: number;
}

import { getDb } from './db.js';

export function listStoredRoomWebhooks(
  code: string,
): StoredRoomWebhook[] {
  const db = getDb();

  const row = db.prepare(`
    SELECT hooksJson
    FROM webhooks
    WHERE code = ?
  `).get(code) as { hooksJson: string } | undefined;

  if (!row) {
    return [];
  }

  try {
    const parsed = JSON.parse(row.hooksJson) as unknown;

    return Array.isArray(parsed)
      ? parsed as StoredRoomWebhook[]
      : [];
  } catch {
    return [];
  }
}

export function saveStoredRoomWebhooks(
  code: string,
  hooks: StoredRoomWebhook[],
): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO webhooks (code, hooksJson)
    VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE
    SET hooksJson = excluded.hooksJson
  `).run(code, JSON.stringify(hooks));
}

export function clearStoredRoomWebhooks(
  code: string,
): void {
  const db = getDb();

  db.prepare(`
    DELETE FROM webhooks
    WHERE code = ?
  `).run(code);
}
