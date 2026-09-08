/**
 * Backend-neutral short-lived sweep/dead-end claim storage.
 *
 * A claim is identified by (room code, identity). Only one caller may
 * acquire it during the 30-second claim window. Once expired, another
 * caller may acquire the same claim.
 */
export interface SweepClaimStore {
  acquireSweepClaim(
    code: string,
    identity: string,
  ): Promise<boolean>;

  pruneExpiredSweepClaims(): Promise<number>;
}
