import type { PersistenceStores } from '@agent-room/persistence';
import type { UpstashClient } from './client.js';
import { createUpstashMessageStore } from './messageStore.js';
import { createUpstashReportStore } from './reportStore.js';
import { createUpstashRoomStore } from './roomStore.js';
import { createUpstashSweepClaimStore } from './sweepClaimStore.js';
import { createUpstashTaskBoardStore } from './taskBoardStore.js';
import { createUpstashTurnStateStore } from './turnStateStore.js';
import { createUpstashWebhookStore } from './webhookStore.js';

export function createUpstashPersistenceStores(
  client: UpstashClient,
): PersistenceStores {
  return {
    rooms: createUpstashRoomStore(client),
    messages: createUpstashMessageStore(client),
    turnState: createUpstashTurnStateStore(client),
    taskBoards: createUpstashTaskBoardStore(client),
    webhooks: createUpstashWebhookStore(client),
    reports: createUpstashReportStore(client),
    sweepClaims: createUpstashSweepClaimStore(client),
  };
}
