import type { TaskBoard } from '@agent-room/shared';

import { getDb } from './db.js';
import { ConcurrencyError } from './rooms.js';

function emptyBoard(code: string): TaskBoard {
  return {
    code,
    tasks: [],
    version: 0,
  };
}

export function getStoredTaskBoard(
  code: string,
): TaskBoard | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT boardJson
    FROM task_boards
    WHERE code = ?
  `).get(code) as { boardJson: string } | undefined;

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.boardJson) as TaskBoard;
  } catch {
    return null;
  }
}

export function registerBoardRoom(
  code: string,
): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO board_rooms (code)
    VALUES (?)
    ON CONFLICT(code) DO NOTHING
  `).run(code);
}

export function unregisterBoardRoom(
  code: string,
): void {
  const db = getDb();

  db.prepare(`
    DELETE FROM board_rooms
    WHERE code = ?
  `).run(code);
}

export function listBoardRooms(): string[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT code
    FROM board_rooms
    ORDER BY code ASC
  `).all() as Array<{ code: string }>;

  return rows.map(row => row.code);
}

export function clearStoredTaskBoard(
  code: string,
): void {
  const db = getDb();

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM task_boards
      WHERE code = ?
    `).run(code);

    db.prepare(`
      DELETE FROM board_rooms
      WHERE code = ?
    `).run(code);
  });

  tx.immediate();
}

export function mutateStoredTaskBoard(
  code: string,
  mutator: (current: TaskBoard) => TaskBoard,
): TaskBoard {
  const db = getDb();

  const read = db.prepare(`
    SELECT boardJson, version
    FROM task_boards
    WHERE code = ?
  `);

  const insert = db.prepare(`
    INSERT INTO task_boards (
      code,
      boardJson,
      version
    )
    VALUES (?, ?, ?)
  `);

  const update = db.prepare(`
    UPDATE task_boards
    SET boardJson = ?, version = ?
    WHERE code = ? AND version = ?
  `);

  const tx = db.transaction(() => {
    const row = read.get(code) as
      | { boardJson: string; version: number }
      | undefined;

    let current: TaskBoard;

    if (!row) {
      current = emptyBoard(code);
    } else {
      try {
        current = JSON.parse(row.boardJson) as TaskBoard;
      } catch {
        current = emptyBoard(code);
      }
    }

    const next = mutator(current);

    const updated: TaskBoard = {
      ...next,
      code,
      version: current.version + 1,
    };

    if (!row) {
      try {
        insert.run(
          code,
          JSON.stringify(updated),
          updated.version,
        );
      } catch {
        throw new ConcurrencyError();
      }
    } else {
      const result = update.run(
        JSON.stringify(updated),
        updated.version,
        code,
        row.version,
      );

      if (result.changes !== 1) {
        throw new ConcurrencyError();
      }
    }

    return updated;
  });

  return tx.immediate();
}
