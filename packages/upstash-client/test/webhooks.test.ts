import { describe, expect, it } from 'vitest';
import type { Message, Participant, Room, RoomWebhook } from '@agent-room/shared';
import type { PersistenceStores } from '@agent-room/persistence';
import { RoomNotFoundError } from '../src/errors.js';
import {
  dispatchRoomWebhooksWithStores,
  NotParticipantError,
  registerRoomWebhookWithStores,
} from '../src/webhooks.js';

function p(name: string, extra: Partial<Participant> = {}): Participant {
  return {
    name, role: '', color: '#000', initials: 'AA', client: 'cc',
    joinedAt: 0, lastSeenAt: 0, canSpeak: true, ...extra,
  };
}

function room(code: string, participants: Participant[]): Room {
  return { code, topic: 't', createdAt: 1, createdBy: 'Host', status: 'active', version: 1, participants };
}

function msg(text: string, extra: Partial<Message> = {}): Message {
  return {
    id: 9, type: 'msg', name: 'Host', initials: 'HO', color: '#111',
    role: '', text, client: 'web', time: 1, ...extra,
  };
}

function storesFor(rooms: Room[], hooks: Record<string, RoomWebhook[]> = {}, counts: Record<string, number> = {}) {
  const roomMap = new Map(rooms.map(r => [r.code, r]));
  const hookMap = new Map(Object.entries(hooks).map(([k, v]) => [k, [...v]]));
  const countMap = new Map(Object.entries(counts));
  return {
    rooms: {
      async getRoom(code: string) {
        const r = roomMap.get(code);
        if (!r) throw new RoomNotFoundError(code);
        return r;
      },
    },
    webhooks: {
      async listWebhooks(code: string) { return [...(hookMap.get(code) ?? [])]; },
      async saveWebhooks(code: string, next: RoomWebhook[]) { hookMap.set(code, next); },
      async clearWebhooks(code: string) { hookMap.delete(code); },
    },
    messages: {
      async getMessageTotalCount(code: string) { return countMap.get(code) ?? 1; },
    },
    hookMap,
  } as unknown as PersistenceStores & { hookMap: Map<string, RoomWebhook[]> };
}

describe('dispatchRoomWebhooksWithStores', () => {
  const host = p('Host', { client: 'web' });
  const alpha = p('Grandpa', { identityKey: 'alpha' });
  const beta = p('Grandpa (2)', { identityKey: 'beta' });

  it('wakes identityKey A and not B for a targeted message', async () => {
    const posted: string[] = [];
    const s = storesFor([room('ROOM-A', [host, alpha, beta])], {
      'ROOM-A': [
        { id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 },
        { id: 'wh_b', url: 'https://wake.example/b', registeredBy: 'Grandpa (2)', identityKey: 'beta', createdAt: 1 },
      ],
    });
    const result = await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('hi', { metadata: { targetIdentityKey: 'alpha' } }), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual(['https://wake.example/a']);
    expect(result.delivered).toBe(1);
  });

  it('never wakes beta for @Grandpa when keys differ', async () => {
    const posted: string[] = [];
    const s = storesFor([room('ROOM-A', [host, alpha, beta])], {
      'ROOM-A': [
        { id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 },
        { id: 'wh_b', url: 'https://wake.example/b', registeredBy: 'Grandpa (2)', identityKey: 'beta', createdAt: 1 },
      ],
    });
    await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa hello'), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual(['https://wake.example/a']);
  });

  it('broadcasts to others and does not re-wake the sender', async () => {
    const posted: string[] = [];
    const s = storesFor([room('ROOM-A', [host, alpha, beta])], {
      'ROOM-A': [
        { id: 'wh_h', url: 'https://wake.example/host', registeredBy: 'Host', createdAt: 1 },
        { id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 },
      ],
    });
    await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('everyone', { name: 'Host', client: 'web' }), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual(['https://wake.example/a']);
  });

  it('keeps the message recoverable when dispatch fails and does not drop the hook until 20 fails', async () => {
    const s = storesFor([room('ROOM-A', [host, alpha])], {
      'ROOM-A': [
        { id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1, failCount: 0 },
      ],
    }, { 'ROOM-A': 7 });
    const result = await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa x'), {
      post: async () => ({ ok: false, status: 500 }),
    });
    expect(result.failed).toBe(1);
    expect(result.dropped).toBe(0);
    expect(s.hookMap.get('ROOM-A')![0]!.failCount).toBe(1);
    expect(await s.messages.getMessageTotalCount('ROOM-A')).toBe(7);
  });

  it('does not treat HTTP 200 as processing acknowledgement', async () => {
    const s = storesFor([room('ROOM-A', [host, alpha])], {
      'ROOM-A': [
        { id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 },
      ],
    }, { 'ROOM-A': 3 });
    const result = await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa x'), {
      post: async () => ({ ok: true, status: 200 }),
    });
    expect(result.delivered).toBe(1);
    expect(await s.messages.getMessageTotalCount('ROOM-A')).toBe(3);
  });

  it('retries a wake without collapsing failCount into an ack', async () => {
    const posted: number[] = [];
    const s = storesFor([room('ROOM-A', [host, alpha])], {
      'ROOM-A': [
        { id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 },
      ],
    });
    await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa x'), {
      post: async () => { posted.push(1); return { ok: false, status: 503 }; },
    });
    await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa x'), {
      post: async () => { posted.push(2); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual([1, 2]);
    expect(s.hookMap.get('ROOM-A')![0]!.failCount).toBe(0);
  });

  it('does not dispatch a matched webhook the URL policy refuses', async () => {
    const posted: string[] = [];
    const s = storesFor([room('ROOM-A', [host, alpha])], {
      'ROOM-A': [
        { id: 'wh_a', url: 'http://127.0.0.1:9/wake', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 },
      ],
    });
    const result = await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa x'), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual([]);
    expect(result.attempted).toBe(0);
  });

  it('does not dispatch when the target has no wake transport', async () => {
    const posted: string[] = [];
    const s = storesFor([room('ROOM-A', [host, alpha])], {}, { 'ROOM-A': 4 });
    const result = await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('@Grandpa x'), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual([]);
    expect(result.attempted).toBe(0);
    expect(await s.messages.getMessageTotalCount('ROOM-A')).toBe(4);
  });

  it('does not dispatch a room A event to a room B registration', async () => {
    const posted: string[] = [];
    const s = storesFor([
      room('ROOM-A', [host, alpha]),
      room('ROOM-B', [host, beta]),
    ], {
      'ROOM-A': [{ id: 'wh_a', url: 'https://wake.example/a', registeredBy: 'Grandpa', identityKey: 'alpha', createdAt: 1 }],
      'ROOM-B': [{ id: 'wh_b', url: 'https://wake.example/b', registeredBy: 'Grandpa (2)', identityKey: 'beta', createdAt: 1 }],
    });
    await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('hello all'), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual(['https://wake.example/a']);
  });
});

describe('registerRoomWebhookWithStores identity', () => {
  it('binds the registrant identityKey rather than a same-name neighbor', async () => {
    const host = p('Host', { client: 'web' });
    const alpha = p('Grandpa', { identityKey: 'alpha' });
    const beta = p('Grandpa (2)', { identityKey: 'beta' });
    const s = storesFor([room('ROOM-A', [host, alpha, beta])]);
    const hook = await registerRoomWebhookWithStores(s, 'ROOM-A', {
      url: 'https://wake.example/a',
      registeredBy: 'Grandpa',
      identityKey: 'alpha',
    });
    expect(hook.identityKey).toBe('alpha');
    expect(hook.registeredBy).toBe('Grandpa');
  });

  it('rejects a keyed participant claiming a different identityKey', async () => {
    const host = p('Host', { client: 'web' });
    const alpha = p('Grandpa', { identityKey: 'alpha' });
    const beta = p('Grandpa (2)', { identityKey: 'beta' });
    const s = storesFor([room('ROOM-A', [host, alpha, beta])]);
    await expect(registerRoomWebhookWithStores(s, 'ROOM-A', {
      url: 'https://wake.example/a',
      registeredBy: 'Grandpa',
      identityKey: 'beta',
    })).rejects.toBeInstanceOf(NotParticipantError);
  });

  it('does not adopt a claimed identityKey for a legacy unkeyed participant', async () => {
    const host = p('Host', { client: 'web' });
    const legacy = p('Grandpa');
    const beta = p('Grandpa (2)', { identityKey: 'beta' });
    const s = storesFor([room('ROOM-A', [host, legacy, beta])]);
    const hook = await registerRoomWebhookWithStores(s, 'ROOM-A', {
      url: 'https://wake.example/legacy',
      registeredBy: 'Grandpa',
      identityKey: 'beta',
    });
    expect(hook.identityKey).toBeUndefined();
    expect(hook.registeredBy).toBe('Grandpa');
    const posted: string[] = [];
    await dispatchRoomWebhooksWithStores(s, 'ROOM-A', msg('hi', { metadata: { targetIdentityKey: 'beta' } }), {
      post: async ({ url }) => { posted.push(url); return { ok: true, status: 200 }; },
    });
    expect(posted).toEqual([]);
  });
});
