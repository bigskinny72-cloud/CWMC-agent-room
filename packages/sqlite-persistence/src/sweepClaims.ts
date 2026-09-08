import { getDb } from './db.js';

export const SWEEP_CLAIM_TTL_MS = 30_000;

export function claimStoredSweepDeadEnd(
  code: string,
  identity: string,
  now: number = Date.now(),
): boolean {
  const db = getDb();

  const expiresAt = now + SWEEP_CLAIM_TTL_MS;

  const result = db.prepare(`
    INSERT INTO sweep_claims (
      code,
      identity,
      expiresAt
    )
    VALUES (?, ?, ?)
    ON CONFLICT(code, identity) DO UPDATE
    SET expiresAt = excluded.expiresAt
    WHERE sweep_claims.expiresAt <= ?
  `).run(
    code,
    identity,
    expiresAt,
    now,
  );

  return result.changes === 1;
}

export function pruneExpiredSweepClaims(
  now: number = Date.now(),
): number {
  const db = getDb();

  const result = db.prepare(`
    DELETE FROM sweep_claims
    WHERE expiresAt <= ?
  `).run(now);

  return result.changes;
}
