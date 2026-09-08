import type { RoomWebhook } from '@agent-room/shared';

/**
 * Backend-neutral durable webhook storage.
 *
 * Registration rules, participant validation, webhook limits,
 * ID generation, and delivery behavior remain outside this interface.
 */
export interface WebhookStore {
  listWebhooks(
    code: string,
  ): Promise<RoomWebhook[]>;

  saveWebhooks(
    code: string,
    hooks: RoomWebhook[],
    roomCreatedAt: number,
  ): Promise<void>;

  clearWebhooks(
    code: string,
  ): Promise<void>;
}
