import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { mkdirSync } from 'fs';

/**
 * Current schema version. Increment when making breaking schema changes.
 * Stored in PRAGMA user_version (persistent across restarts).
 */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Database connection singleton.
 */
let db: Database.Database | null = null;
let dbPath: string | null = null;

/**
 * Open mode for database initialization.
 * - 'create': fail if database already exists (fresh initialization)
 * - 'open': fail if database does not exist or is corrupt (open existing)
 */
export type DbOpenMode = 'create' | 'open';

/**
 * Open the SQLite database with WAL mode and busy timeout.
 * Must be called once at application startup.
 * Fails closed if the database is corrupt, missing (in 'open' mode), or already exists (in 'create' mode).
 * 
 * @param path - Absolute path to the SQLite database file. Required; no :memory: fallback.
 * @param mode - 'create' for fresh initialization, 'open' for existing database.
 * @returns The database instance.
 */
export function openDb(path: string, mode: DbOpenMode = 'open'): Database.Database {
  if (db) {
    if (dbPath !== path) {
      throw new Error(`Database already open at different path: ${dbPath}`);
    }
    return db;
  }

  if (!path || path.trim() === '') {
    throw new Error('Database path is required. Set AGENT_ROOM_SQLITE_PATH environment variable.');
  }

  if (path === ':memory:') {
    throw new Error('In-memory database (:memory:) is not allowed in production. Provide an explicit file path.');
  }

  const parentDir = dirname(path);
  const fileExists = existsSync(path);

  if (mode === 'create' && fileExists) {
    throw new Error(`Database already exists at ${path}. Use 'open' mode to open existing database.`);
  }

  if (mode === 'open' && !fileExists) {
    throw new Error(`Database not found at ${path}. Use 'create' mode to initialize a new database.`);
  }

  // Creating may create its parent. Opening must not manufacture paths on failure.
  if (mode === 'create' && !existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    db = new Database(path);
    dbPath = path;

    // Enable WAL mode explicitly (redundant with wal: true but explicit)
    db.pragma('journal_mode = WAL');

    // Set busy timeout
    db.pragma('busy_timeout = 5000');

    // Detect damaged SQLite pages before trusting schema/version metadata.
    const quickCheck = db.pragma('quick_check', { simple: true }) as string;
    if (quickCheck !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${quickCheck}`);
    }

    // Verify/initialize schema
    const currentVersion = db.pragma('user_version', { simple: true }) as number;

    if (currentVersion === 0) {
      // Fresh database - run migrations
      if (mode !== 'create') {
        throw new Error(`Database at ${path} has no schema (user_version=0) but was opened in 'open' mode.`);
      }
      runMigrations();
    } else if (currentVersion > CURRENT_SCHEMA_VERSION) {
      // Future schema - fail closed
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}. ` +
        `This binary is too old for the database.`
      );
    } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
      // Schema upgrade needed
      runMigrations();
    }
    // currentVersion === CURRENT_SCHEMA_VERSION: nothing to migrate.
    validateRequiredSchema();

    return db;
  } catch (err) {
    // Fail closed: release any partially-open handle and never silently create
    // an empty replacement. A leaked handle can also block backup/recovery.
    try { db?.close(); } catch { /* preserve the original startup error */ }
    db = null;
    dbPath = null;
    throw new Error(`Failed to open SQLite database: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const REQUIRED_SCHEMA = {
  rooms: ['code', 'roomJson', 'version'],
  messages: ['code', 'seq', 'messageJson'],
  message_counts: ['code', 'totalCount'],
  turn_state: ['code', 'stateJson'],
  task_boards: ['code', 'boardJson', 'version'],
  board_rooms: ['code'],
  webhooks: ['code', 'hooksJson'],
  reports: ['code', 'reportJson', 'expiresAt'],
  sweep_claims: ['code', 'identity', 'expiresAt'],
} as const;

function validateRequiredSchema(): void {
  if (!db) throw new Error('Database not open');
  const findTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`);
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!findTable.get(table)) throw new Error(`Database schema is missing required table: ${table}`);
    const columns = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
    for (const column of requiredColumns) {
      if (!columns.has(column)) throw new Error(`Database schema table ${table} is missing required column: ${column}`);
    }
  }
}
/**
 * Run all schema migrations up to CURRENT_SCHEMA_VERSION.
 * Runs in a single transaction; on success, updates PRAGMA user_version.
 */
function runMigrations(): void {
  if (!db) throw new Error('Database not open');

  const startingVersion = db.pragma('user_version', { simple: true }) as number;

  if (startingVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${startingVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`
    );
  }

  const migrationTx = db.transaction(() => {
    let version = startingVersion;

    if (version < 1) {
      migrateV1();
      version = 1;
      db!.pragma('user_version = 1');
    }

    // Future migrations are applied sequentially:
    //
    // if (version < 2) {
    //   migrateV2();
    //   version = 2;
    //   db!.pragma('user_version = 2');
    // }

    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Migration stopped at schema version ${version}; expected ${CURRENT_SCHEMA_VERSION}.`
      );
    }
  });

  migrationTx();
}

/**
 * Schema version 1: Initial tables for Agent Room persistence.
 */
function migrateV1(): void {
  if (!db) throw new Error('Database not open');

  // Room is the authoritative Agent Room Room object, stored intact as JSON.
  // version is duplicated as a column solely for atomic optimistic CAS.
  // Rooms have no automatic expiry in the local SQLite backend.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      roomJson TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0)
    );
  `);

  // Messages preserve the exact Message object as JSON.
  // seq is the absolute per-room sequence used by listMessages cursors.
  // Only the newest 500 rows are retained, but seq/totalCount never reset.
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      code TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      messageJson TEXT NOT NULL,
      PRIMARY KEY (code, seq)
    );
  `);

  // Absolute number of messages ever appended to each room.
  // This remains monotonic even when old message rows are trimmed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_counts (
      code TEXT PRIMARY KEY,
      totalCount INTEGER NOT NULL DEFAULT 0 CHECK (totalCount >= 0)
    );
  `);

  // Exact TurnState object for the room.
  // Turn state is durable across process/server restart and is cleared only
  // by the existing Agent Room turn-state lifecycle.
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_state (
      code TEXT PRIMARY KEY,
      stateJson TEXT NOT NULL
    );
  `);

  // Exact TaskBoard object for the room.
  // version is duplicated for atomic whole-board optimistic CAS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_boards (
      code TEXT PRIMARY KEY,
      boardJson TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0)
    );
  `);

  // SQLite equivalent of Redis set task-board:rooms.
  // This is a coordination/discovery index, not authoritative task data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_rooms (
      code TEXT PRIMARY KEY
    );
  `);

  // Exact RoomWebhook[] array for the room.
  // Webhooks follow the room lifecycle and do not independently expire.
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      code TEXT PRIMARY KEY,
      hooksJson TEXT NOT NULL
    );
  `);

  // Exact RoomReport object plus its independent retention deadline.
  // Reports expire 24 hours after report creation/export; room data does not.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      code TEXT PRIMARY KEY,
      reportJson TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    );
  `);

  // Short-lived coordination claim used by the board/dead-end sweep.
  // Acquisition/reclaim must later be implemented atomically.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sweep_claims (
      code TEXT NOT NULL,
      identity TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      PRIMARY KEY (code, identity)
    );
  `);

  // Expired reports can be found efficiently without affecting room state.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reports_expires
      ON reports(expiresAt);
  `);

  // Expired sweep claims can be located/reclaimed efficiently.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sweep_claims_expires
      ON sweep_claims(expiresAt);
  `);
}

/**
 * Close the database connection.
 * Call at application shutdown.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}

/**
 * Get the current database instance.
 * Throws if database is not open.
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error('SQLite database not open. Call openDb() first.');
  }
  return db;
}

/**
 * Run async work inside one SQLite transaction that stays open across awaits.
 *
 * Must not use better-sqlite3's synchronous `db.transaction(async () => …)`
 * wrapper — that commits when the async function returns a Promise, before
 * awaited work finishes. Manual BEGIN/COMMIT/ROLLBACK keeps the boundary
 * open for the full async fn. Nested `db.transaction()` calls become
 * SAVEPOINTs under this outer transaction.
 */
export async function runInTransaction<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const conn = getDb();

  if (conn.inTransaction) {
    return fn();
  }

  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    if (conn.inTransaction) {
      conn.exec('ROLLBACK');
    }
    throw err;
  }
}

/**
 * Get the current database path.
 */
export function getDbPath(): string | null {
  return dbPath;
}

/**
 * Check if database is open.
 */
export function isDbOpen(): boolean {
  return db !== null;
}

/**
 * Get current schema version from the database.
 */
export function getSchemaVersion(): number {
  if (!db) throw new Error('Database not open');
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Schema version for migration tracking.
 * Increment this when making breaking schema changes.
 */
export { CURRENT_SCHEMA_VERSION };






