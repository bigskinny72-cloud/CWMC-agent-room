import type { SweepClaimStore } from '@agent-room/persistence';

import {
  claimStoredSweepDeadEnd,
  pruneExpiredSweepClaims,
} from './sweepClaims.js';

export function createSqliteSweepClaimStore(): SweepClaimStore {
  return {
    async acquireSweepClaim(
      code: string,
      identity: string,
    ): Promise<boolean> {
      return claimStoredSweepDeadEnd(code, identity);
    },

    async pruneExpiredSweepClaims(): Promise<number> {
      return pruneExpiredSweepClaims();
    },
  };
}
