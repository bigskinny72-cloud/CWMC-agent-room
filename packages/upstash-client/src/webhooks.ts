// Per-room outbound webhooks.
//
// Resident agents (OpenClaw, Hermes, and other gateway-style assistants)
// don't run a room_listen loop — they sleep until something POSTs at them.
// A room webhook is that wake-up call: register a URL for a room and the
// server POSTs to it whenever someone else's chat message lands. The woken
// agent then reads the room (room_list_messages from its own cursor) and
// replies via room_send like any other participant.
//
// Storage is a single JSON array under `room-webhooks:{code}`, capped small
// and expiring on the room's fixed 24h deadline like every other room key.
// Writes are read-modify-write on that one key; registration is rare and
// low-stakes enough that we accept the (tiny) lost-update window instead of
// pulling in a CAS loop.

import type { RoomWebhook } from '@agent-room/shared';
export type { RoomWebhook } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { createUpstashWebhookStore } from './webhookStore.js';
import { getRoom } from './rooms.js';

export const MAX_WEBHOOKS_PER_ROOM = 5;




function randomId(): string {
  return 'wh_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export async function listRoomWebhooks(
  client: UpstashClient,
  code: string,
): Promise<RoomWebhook[]> {
  return createUpstashWebhookStore(client).listWebhooks(code);
}

export async function saveRoomWebhooks(
  client: UpstashClient,
  code: string,
  hooks: RoomWebhook[],
  roomCreatedAt: number,
): Promise<void> {
  await createUpstashWebhookStore(client).saveWebhooks(
    code,
    hooks,
    roomCreatedAt,
  );
}

export class WebhookLimitError extends Error {
  constructor() {
    super(`A room can have at most ${MAX_WEBHOOKS_PER_ROOM} webhooks.`);
    this.name = 'WebhookLimitError';
  }
}

export class NotParticipantError extends Error {
  constructor(name: string) {
    super(`"${name}" is not a participant of this room — join it before registering a webhook.`);
    this.name = 'NotParticipantError';
  }
}

// Register (or update, keyed by URL) a webhook. The registrant must currently
// be in the room — webhooks are a participant feature, not an anonymous tap
// on someone else's conversation.
export async function registerRoomWebhook(
  client: UpstashClient,
  code: string,
  input: { url: string; registeredBy: string; secret?: string },
): Promise<RoomWebhook> {
  const room = await getRoom(client, code); // throws RoomNotFoundError when gone
  if (!room.participants.some(p => p.name === input.registeredBy)) {
    throw new NotParticipantError(input.registeredBy);
  }
  const hooks = await listRoomWebhooks(client, code);
  const existing = hooks.find(h => h.url === input.url);
  if (existing) {
    existing.registeredBy = input.registeredBy;
    existing.secret = input.secret;
    existing.failCount = 0;
    await saveRoomWebhooks(client, code, hooks, room.createdAt);
    return existing;
  }
  if (hooks.length >= MAX_WEBHOOKS_PER_ROOM) throw new WebhookLimitError();
  const hook: RoomWebhook = {
    id: randomId(),
    url: input.url,
    registeredBy: input.registeredBy,
    ...(input.secret ? { secret: input.secret } : {}),
    createdAt: Date.now(),
  };
  hooks.push(hook);
  await saveRoomWebhooks(client, code, hooks, room.createdAt);
  return hook;
}

// Remove by id or exact URL. Returns true when something was removed.
export async function unregisterRoomWebhook(
  client: UpstashClient,
  code: string,
  idOrUrl: string,
): Promise<boolean> {
  const room = await getRoom(client, code);
  const hooks = await listRoomWebhooks(client, code);
  const next = hooks.filter(h => h.id !== idOrUrl && h.url !== idOrUrl);
  if (next.length === hooks.length) return false;
  await saveRoomWebhooks(client, code, next, room.createdAt);
  return true;
}




