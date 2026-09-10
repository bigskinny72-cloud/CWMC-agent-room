import type { PersistenceStores } from '@agent-room/persistence';
import { runInTransaction } from './db.js';
import { sqliteRoomStore } from './roomStore.js';
import { createSqliteMessageStore } from './messageStore.js';
import { createSqliteReportStore } from './reportStore.js';
import { createSqliteSweepClaimStore } from './sweepClaimStore.js';
import { createSqliteTaskBoardStore } from './taskBoardStore.js';
import { createSqliteTurnStateStore } from './turnStateStore.js';
import { createSqliteWebhookStore } from './webhookStore.js';

export function createSqlitePersistenceStores(): PersistenceStores {
  return {
    rooms: sqliteRoomStore,
    messages: createSqliteMessageStore(),
    turnState: createSqliteTurnStateStore(),
    taskBoards: createSqliteTaskBoardStore(),
    webhooks: createSqliteWebhookStore(),
    reports: createSqliteReportStore(),
    sweepClaims: createSqliteSweepClaimStore(),
    runInTransaction,
  };
}
