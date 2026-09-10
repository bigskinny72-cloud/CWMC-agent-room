import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { closeDb, getDb, getDbPath, openDb } from './db.js';

function validateStandaloneDatabase(path: string): void {
  const check = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('quick_check', { simple: true }) as string;
    if (result !== 'ok') throw new Error(`SQLite quick_check failed: ${result}`);
  } finally {
    check.close();
  }
}

/** Create a transactionally consistent standalone backup from the live DB. */
export async function backupDb(destinationPath: string): Promise<void> {
  const sourcePath = getDbPath();
  if (!sourcePath) throw new Error('SQLite database not open. Call openDb() first.');
  if (!destinationPath?.trim()) throw new Error('Backup destination path is required.');
  if (resolve(destinationPath) === resolve(sourcePath)) throw new Error('Backup destination must differ from the live database path.');
  if (existsSync(destinationPath)) throw new Error(`Backup destination already exists: ${destinationPath}`);
  const parent = dirname(destinationPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  await getDb().backup(destinationPath);
  validateStandaloneDatabase(destinationPath);
}

/**
 * Replace a closed live database with a validated standalone backup.
 * Restore is intentionally offline: replacing a database under a live WAL
 * connection can mix old WAL state with restored main-file state.
 */
export function restoreDbFromBackup(backupPath: string, destinationPath: string): void {
  if (!backupPath?.trim() || !destinationPath?.trim()) throw new Error('Backup and restore destination paths are required.');
  if (!existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);
  if (getDbPath()) throw new Error('Restore requires the SQLite database to be closed. Stop the Agent Room server first.');
  if (resolve(backupPath) === resolve(destinationPath)) throw new Error('Backup source and restore destination must differ.');

  validateStandaloneDatabase(backupPath);
  if (existsSync(destinationPath)) {
    throw new Error(`Restore destination already exists: ${destinationPath}. Move the existing database aside explicitly before restore.`);
  }

  const parent = dirname(destinationPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // SQLite performs the copy itself so the destination is a complete database,
  // not a raw main-file copy that can omit WAL contents.
  const source = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    source.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
  } finally {
    source.close();
  }

  // Reuse normal production startup validation, then leave restore closed.
  openDb(destinationPath, 'open');
  closeDb();
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
