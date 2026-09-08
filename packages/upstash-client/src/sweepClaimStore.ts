import type { SweepClaimStore } from '@agent-room/persistence';

import type { UpstashClient } from './client.js';

const SWEEP_CLAIM_TTL_SECONDS = 30;

function sweepClaimKey(
  code: string,
  identity: string,
): string {
  return `sweepDeadEnd:${code}:${identity}`;
}

export function createUpstashSweepClaimStore(
  client: UpstashClient,
): SweepClaimStore {
  return {
    async acquireSweepClaim(
      code: string,
      identity: string,
    ): Promise<boolean> {
      const won = await client.command<string | null>([
        'SET',
        sweepClaimKey(code, identity),
        '1',
        'NX',
        'EX',
        String(SWEEP_CLAIM_TTL_SECONDS),
      ]);

      return won === 'OK';
    },

    async pruneExpiredSweepClaims(): Promise<number> {
      // Redis expires sweep claims automatically.
      return 0;
    },
  };
}
