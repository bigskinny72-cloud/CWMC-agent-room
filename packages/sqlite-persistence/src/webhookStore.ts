import type { RoomWebhook } from '@agent-room/shared';
import type { WebhookStore } from '@agent-room/persistence';

import {
  listStoredRoomWebhooks,
  saveStoredRoomWebhooks,
  clearStoredRoomWebhooks,
} from './webhooks.js';

export function createSqliteWebhookStore(): WebhookStore {
  return {
    async listWebhooks(
      code: string,
    ): Promise<RoomWebhook[]> {
      return listStoredRoomWebhooks(code);
    },

    async saveWebhooks(
      code: string,
      hooks: RoomWebhook[],
      _roomCreatedAt: number,
    ): Promise<void> {
      saveStoredRoomWebhooks(code, hooks);
    },

    async clearWebhooks(
      code: string,
    ): Promise<void> {
      clearStoredRoomWebhooks(code);
    },
  };
}

