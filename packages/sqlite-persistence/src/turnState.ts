import { getDb } from './db.js';

export function getStoredTurnState<T = unknown>(
  code: string,
): T | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT stateJson
    FROM turn_state
    WHERE code = ?
  `).get(code) as { stateJson: string } | undefined;

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.stateJson) as T;
  } catch {
    return null;
  }
}

export function setStoredTurnState<T>(
  code: string,
  state: T,
): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO turn_state (code, stateJson)
    VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE
    SET stateJson = excluded.stateJson
  `).run(code, JSON.stringify(state));
}

export function clearStoredTurnState(
  code: string,
): void {
  const db = getDb();

  db.prepare(`
    DELETE FROM turn_state
    WHERE code = ?
  `).run(code);
}

export function mutateStoredTurnState<T>(
  code: string,
  mutator: (current: T | null) => T | null,
): T | null {
  const db = getDb();

  const read = db.prepare(`
    SELECT stateJson
    FROM turn_state
    WHERE code = ?
  `);

  const write = db.prepare(`
    INSERT INTO turn_state (code, stateJson)
    VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE
    SET stateJson = excluded.stateJson
  `);

  const remove = db.prepare(`
    DELETE FROM turn_state
    WHERE code = ?
  `);

  const tx = db.transaction(() => {
    const row = read.get(code) as
      | { stateJson: string }
      | undefined;

    let current: T | null = null;

    if (row) {
      try {
        current = JSON.parse(row.stateJson) as T;
      } catch {
        current = null;
      }
    }

    const next = mutator(current);

    if (next === null) {
      if (row) {
        remove.run(code);
      }
      return null;
    }

    write.run(code, JSON.stringify(next));
    return next;
  });

  return tx.immediate();
}
