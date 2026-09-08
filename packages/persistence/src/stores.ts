import type { RoomStore } from './rooms.js';
import type { MessageStore } from './message.js';
import type { TurnStateStore } from './turnState.js';
import type { TaskBoardStore } from './taskBoard.js';
import type { WebhookStore } from './webhook.js';
import type { ReportStore } from './report.js';
import type { SweepClaimStore } from './sweepClaim.js';

export interface PersistenceStores {
  rooms: RoomStore;
  messages: MessageStore;
  turnState: TurnStateStore;
  taskBoards: TaskBoardStore;
  webhooks: WebhookStore;
  reports: ReportStore;
  sweepClaims: SweepClaimStore;
}
