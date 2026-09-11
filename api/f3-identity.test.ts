import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, createSqlitePersistenceStores } from '@agent-room/sqlite-persistence';
import type { ClientKind, Participant } from '@agent-room/shared';

let handler: typeof import('./room').default;
let temp: string;
const originalPath = process.env.AGENT_ROOM_SQLITE_PATH;
const stores = createSqlitePersistenceStores();

async function request(body: Record<string, unknown>) {
  let status = 200;
  let result: any;
  const res: any = { status(n: number) { status = n; return res; }, json(v: unknown) { result = v; return res; } };
  await handler({ method: 'POST', body } as any, res);
  return { status, result };
}

function participant(name: string, extra: Partial<Participant> = {}): Participant {
  return {
    name,
    client: 'cc' as ClientKind,
    role: 'member',
    color: '#000000',
    initials: 'AR',
    canSpeak: true,
    joinedAt: 1,
    lastSeenAt: 1,
    ...extra,
  };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  temp = mkdtempSync(join(tmpdir(), 'agent-room-f3-'));
  process.env.AGENT_ROOM_SQLITE_PATH = join(temp, 'test.sqlite');
  openDb(process.env.AGENT_ROOM_SQLITE_PATH, 'create');
  handler = (await import('./room')).default;
});

afterAll(() => {
  closeDb();
  if (originalPath === undefined) delete process.env.AGENT_ROOM_SQLITE_PATH;
  else process.env.AGENT_ROOM_SQLITE_PATH = originalPath;
  vi.useRealTimers();
  rmSync(temp, { recursive: true, force: true });
});

test('API join reclaims the same identityKey 20 times without duplicate Grandpas', async () => {
  const created = await request({ action: 'create', code: 'F3-ID-001', topic: 'F3 identity', createdBy: 'Host' });
  expect(created.status).toBe(200);
  const hostKey = created.result.hostKey as string;
  expect((await request({
    action: 'join', code: 'F3-ID-001', participant: participant('Host', { client: 'web' }), hostKey,
  })).status).toBe(200);
  expect((await request({
    action: 'join', code: 'F3-ID-001', participant: participant('Reviewer', { identityKey: 'reviewer' }),
  })).status).toBe(200);

  const key = 'grandpa-1';
  for (let i = 0; i < 20; i++) {
    const joined = await request({
      action: 'join',
      code: 'F3-ID-001',
      participant: participant('Grandpa', { identityKey: key, lastSeenAt: 10 + i }),
      priorIdentity: { name: 'Grandpa', client: 'cc', identityKey: key },
    });
    expect(joined.status).toBe(200);
    const grandpas = joined.result.participants.filter((p: Participant) => p.name.startsWith('Grandpa'));
    expect(grandpas).toHaveLength(1);
    expect(grandpas[0].name).toBe('Grandpa');
    expect(grandpas[0].identityKey).toBe(key);
    expect(joined.result.participants.some((p: Participant) => p.name === 'Reviewer')).toBe(true);
  }
});

test('API join keeps a true name collision on a different identityKey', async () => {
  const created = await request({ action: 'create', code: 'F3-ID-002', topic: 'F3 collision', createdBy: 'Host' });
  const hostKey = created.result.hostKey as string;
  expect((await request({
    action: 'join', code: 'F3-ID-002', participant: participant('Host', { client: 'web' }), hostKey,
  })).status).toBe(200);
  expect((await request({
    action: 'join',
    code: 'F3-ID-002',
    participant: participant('Grandpa', { identityKey: 'alpha' }),
    priorIdentity: { name: 'Grandpa', client: 'cc', identityKey: 'alpha' },
  })).status).toBe(200);
  const second = await request({
    action: 'join',
    code: 'F3-ID-002',
    participant: participant('Grandpa', { identityKey: 'beta' }),
    priorIdentity: { name: 'Grandpa', client: 'cc', identityKey: 'beta' },
  });
  expect(second.status).toBe(200);
  expect(second.result.participant.name).toBe('Grandpa (2)');
  expect(second.result.participants.filter((p: Participant) => p.identityKey === 'alpha')).toHaveLength(1);
});

test('identity activity in one SQLite room does not mutate another', async () => {
  for (const code of ['F3-ID-A', 'F3-ID-B']) {
    const created = await request({ action: 'create', code, topic: 'F3 isolation', createdBy: 'Host' });
    expect((await request({
      action: 'join', code, participant: participant('Host', { client: 'web' }), hostKey: created.result.hostKey,
    })).status).toBe(200);
  }
  await request({
    action: 'join',
    code: 'F3-ID-A',
    participant: participant('Grandpa', { identityKey: 'shared-looking' }),
    priorIdentity: { name: 'Grandpa', client: 'cc', identityKey: 'shared-looking' },
  });
  await request({
    action: 'join',
    code: 'F3-ID-B',
    participant: participant('Keep', { identityKey: 'keep-b' }),
  });
  const beforeB = await stores.rooms.getRoom('F3-ID-B');
  await request({
    action: 'join',
    code: 'F3-ID-A',
    participant: participant('Grandpa', { identityKey: 'shared-looking', lastSeenAt: 99 }),
    priorIdentity: { name: 'Grandpa', client: 'cc', identityKey: 'shared-looking' },
  });
  expect(await stores.rooms.getRoom('F3-ID-B')).toEqual(beforeB);
});
