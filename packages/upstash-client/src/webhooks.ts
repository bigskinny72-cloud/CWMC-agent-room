import type { PersistenceStores } from '@agent-room/persistence';
import { createUpstashPersistenceStores } from './persistenceStores.js';
import { createHmac } from 'node:crypto';
import {
  WEBHOOK_DISPATCH_TIMEOUT_MS,
  WEBHOOK_FAIL_DROP,
  resolveWakeRecipients,
  webhookMatchesParticipant,
  webhookTransportReady,
  type Message,
  type RoomWebhook,
} from '@agent-room/shared';
import { getRoomWithStores } from './rooms.js';
import { getMessageTotalCountWithStores } from './messages.js';
import type { UpstashClient } from './client.js';

export type { RoomWebhook } from '@agent-room/shared';
export {
  resolveWakeRecipients,
  webhookMatchesParticipant,
  webhookUrlAllowed,
} from '@agent-room/shared';

export const MAX_WEBHOOKS_PER_ROOM = 5;

function randomId(): string {
  return 'wh_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export type WebhookPostFn = (input: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number }>;

async function defaultWebhookPost(input: Parameters<WebhookPostFn>[0]): Promise<{ ok: boolean; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEBHOOK_DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(input.url, {
      method: 'POST',
      headers: input.headers,
      body: input.body,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export interface WakeDispatchResult {
  attempted: number;
  delivered: number;
  failed: number;
  dropped: number;
}

export async function listRoomWebhooksWithStores(
  stores: PersistenceStores,
  code: string,
): Promise<RoomWebhook[]> {
  return stores.webhooks.listWebhooks(code);
}

export async function listRoomWebhooks(
  client: UpstashClient,
  code: string,
): Promise<RoomWebhook[]> {
  return listRoomWebhooksWithStores(createUpstashPersistenceStores(client), code);
}

export async function saveRoomWebhooksWithStores(
  stores: PersistenceStores,
  code: string,
  hooks: RoomWebhook[],
  roomCreatedAt: number,
): Promise<void> {
  await stores.webhooks.saveWebhooks(
    code,
    hooks,
    roomCreatedAt,
  );
}

export async function saveRoomWebhooks(
  client: UpstashClient,
  code: string,
  hooks: RoomWebhook[],
  roomCreatedAt: number,
): Promise<void> {
  return saveRoomWebhooksWithStores(createUpstashPersistenceStores(client), code, hooks, roomCreatedAt);
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
export async function registerRoomWebhookWithStores(
  stores: PersistenceStores,
  code: string,
  input: { url: string; registeredBy: string; secret?: string; identityKey?: string },
): Promise<RoomWebhook> {
  const room = await getRoomWithStores(stores, code); // throws RoomNotFoundError when gone
  const registrant = room.participants.find(p => p.name === input.registeredBy);
  if (!registrant) {
    throw new NotParticipantError(input.registeredBy);
  }
  if (input.identityKey && registrant.identityKey && registrant.identityKey !== input.identityKey) {
    throw new NotParticipantError(input.registeredBy);
  }
  // A claimed key is evidence only when the roster row already has that same key.
  const identityKey = registrant.identityKey;
  const hooks = await listRoomWebhooksWithStores(stores, code);
  const existing = hooks.find(h => h.url === input.url);
  if (existing) {
    existing.registeredBy = registrant.name;
    if (identityKey) existing.identityKey = identityKey;
    else delete existing.identityKey;
    existing.secret = input.secret;
    existing.failCount = 0;
    await saveRoomWebhooksWithStores(stores, code, hooks, room.createdAt);
    return existing;
  }
  if (hooks.length >= MAX_WEBHOOKS_PER_ROOM) throw new WebhookLimitError();
  const hook: RoomWebhook = {
    id: randomId(),
    url: input.url,
    registeredBy: registrant.name,
    ...(identityKey ? { identityKey } : {}),
    ...(input.secret ? { secret: input.secret } : {}),
    createdAt: Date.now(),
  };
  hooks.push(hook);
  await saveRoomWebhooksWithStores(stores, code, hooks, room.createdAt);
  return hook;
}

export async function registerRoomWebhook(
  client: UpstashClient,
  code: string,
  input: { url: string; registeredBy: string; secret?: string },
): Promise<RoomWebhook> {
  return registerRoomWebhookWithStores(createUpstashPersistenceStores(client), code, input);
}

// Remove by id or exact URL. Returns true when something was removed.
export async function unregisterRoomWebhookWithStores(
  stores: PersistenceStores,
  code: string,
  idOrUrl: string,
): Promise<boolean> {
  const room = await getRoomWithStores(stores, code);
  const hooks = await listRoomWebhooksWithStores(stores, code);
  const next = hooks.filter(h => h.id !== idOrUrl && h.url !== idOrUrl);
  if (next.length === hooks.length) return false;
  await saveRoomWebhooksWithStores(stores, code, next, room.createdAt);
  return true;
}

export async function unregisterRoomWebhook(
  client: UpstashClient,
  code: string,
  idOrUrl: string,
): Promise<boolean> {
  return unregisterRoomWebhookWithStores(createUpstashPersistenceStores(client), code, idOrUrl);
}

export async function dispatchRoomWebhooksWithStores(
  stores: PersistenceStores,
  code: string,
  message: Message,
  options: { post?: WebhookPostFn; kind?: 'message' | 'status' } = {},
): Promise<WakeDispatchResult> {
  const result: WakeDispatchResult = { attempted: 0, delivered: 0, failed: 0, dropped: 0 };
  if (message.type !== 'msg' || options.kind === 'status') return result;

  const room = await getRoomWithStores(stores, code);
  const hooks = await listRoomWebhooksWithStores(stores, code);
  if (hooks.length === 0) return result;

  const { recipients } = resolveWakeRecipients(room, message);
  const selected = hooks.filter((hook) =>
    webhookTransportReady(hook)
    && recipients.some((p) => webhookMatchesParticipant(hook, p)),
  );
  if (selected.length === 0) return result;

  const cursor = (await getMessageTotalCountWithStores(stores, code)) ?? 0;
  const post = options.post ?? defaultWebhookPost;
  let dirty = false;
  const next = [...hooks];

  for (const hook of selected) {
    result.attempted += 1;
    const body = JSON.stringify({
      event: 'message',
      code: room.code,
      topic: room.topic,
      message: {
        id: message.id,
        name: message.name,
        client: message.client,
        role: message.role,
        text: message.text,
        time: message.time,
      },
      cursor,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-agentroom-room': room.code,
      'x-agentroom-webhook-id': hook.id,
    };
    if (hook.secret) {
      headers['x-agentroom-signature'] = `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`;
    }
    const idx = next.findIndex((h) => h.id === hook.id);
    try {
      const res = await post({ url: hook.url, headers, body });
      if (res.ok) {
        result.delivered += 1;
        if (idx >= 0) {
          next[idx] = { ...next[idx]!, failCount: 0, lastDeliveredAt: Date.now() };
          dirty = true;
        }
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      result.failed += 1;
      if (idx >= 0) {
        const failCount = (next[idx]!.failCount ?? 0) + 1;
        if (failCount >= WEBHOOK_FAIL_DROP) {
          next.splice(idx, 1);
          result.dropped += 1;
        } else {
          next[idx] = { ...next[idx]!, failCount };
        }
        dirty = true;
      }
    }
  }

  if (dirty) await saveRoomWebhooksWithStores(stores, code, next, room.createdAt);
  return result;
}

export async function dispatchRoomWebhooks(
  client: UpstashClient,
  code: string,
  message: Message,
  options: { post?: WebhookPostFn; kind?: 'message' | 'status' } = {},
): Promise<WakeDispatchResult> {
  return dispatchRoomWebhooksWithStores(createUpstashPersistenceStores(client), code, message, options);
}




