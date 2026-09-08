import type { Room } from '@agent-room/shared';
import {
  ConcurrencyError,
  RoomNotFoundError,
} from '@agent-room/persistence';
import { getDb } from './db.js';

export { ConcurrencyError, RoomNotFoundError };

export function insertRoom(room: Room): Room {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO rooms (code, roomJson, version)
    VALUES (?, ?, ?)
  `);
  stmt.run(room.code, JSON.stringify(room), room.version);
  return room;
}

export function getRoom(code: string): Room {
  const db = getDb();
  const row = db.prepare(`
    SELECT roomJson
    FROM rooms
    WHERE code = ?
  `).get(code) as { roomJson: string } | undefined;

  if (!row) throw new RoomNotFoundError(code);

  return JSON.parse(row.roomJson) as Room;
}

export function casRoom(
  code: string,
  expectedVersion: number,
  next: Room
): Room {
  const db = getDb();

  const write = db.prepare(`
    UPDATE rooms
    SET roomJson = ?, version = ?
    WHERE code = ? AND version = ?
  `);

  const tx = db.transaction(() => {
    const newVersion = expectedVersion + 1;
    const updated: Room = { ...next, version: newVersion };

    const result = write.run(
      JSON.stringify(updated),
      newVersion,
      code,
      expectedVersion
    );

    if (result.changes !== 1) {
      const exists = db.prepare(`
        SELECT 1
        FROM rooms
        WHERE code = ?
      `).get(code);

      if (!exists) throw new RoomNotFoundError(code);

      throw new ConcurrencyError();
    }

    return updated;
  });

  return tx();
}
