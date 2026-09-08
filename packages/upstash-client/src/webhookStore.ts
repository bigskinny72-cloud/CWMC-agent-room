import {
  ROOM_TTL_SECONDS,
  type RoomWebhook,
} from '@agent-room/shared';

import type { WebhookStore } from '@agent-room/persistence';
import type { UpstashClient } from './client.js';

function webhooksKey(code: string): string {
  return `room-webhooks:${code}`;
}

export function createUpstashWebhookStore(
  client: UpstashClient,
): WebhookStore {
  return {
    async listWebhooks(
      code: string,
    ): Promise<RoomWebhook[]> {
      const raw = await client.command<string | null>([
        'GET',
        webhooksKey(code),
      ]);

      if (!raw) {
        return [];
      }

      try {
        const parsed = JSON.parse(
          typeof raw === 'string' ? raw : String(raw),
        ) as unknown;

        return Array.isArray(parsed)
          ? parsed as RoomWebhook[]
          : [];
      } catch {
        return [];
      }
    },

    async saveWebhooks(
      code: string,
      hooks: RoomWebhook[],
      roomCreatedAt: number,
    ): Promise<void> {
      const expireAt =
        (
          Number.isFinite(roomCreatedAt)
            ? Math.floor(roomCreatedAt / 1000)
            : Math.floor(Date.now() / 1000)
        ) + ROOM_TTL_SECONDS;

      await client.pipeline([
        ['SET', webhooksKey(code), JSON.stringify(hooks)],
        ['EXPIREAT', webhooksKey(code), expireAt],
      ]);
    },

    async clearWebhooks(
      code: string,
    ): Promise<void> {
      await client.command([
        'DEL',
        webhooksKey(code),
      ]);
    },
  };
}
