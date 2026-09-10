import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, createSqlitePersistenceStores } from '@agent-room/sqlite-persistence';
import { newModeratorTurn } from '@agent-room/upstash-client';
import type { ClientKind, Message, Participant } from '@agent-room/shared';
import * as web from '../apps/web/src/lib/roomApi';
import * as mcp from '../apps/mcp/src/roomApi';

let handler: typeof import('./room').default;
let temp: string;
const originalPath = process.env.AGENT_ROOM_SQLITE_PATH;
const stores = createSqlitePersistenceStores();
const keys = new Map<string, string>();
const actions = new Set<string>();
const unexpectedRequests: string[] = [];
let client: mcp.RoomApiClient;

async function request(body: Record<string, unknown>) {
  let status = 200;
  let result: any;
  const res: any = { status(n: number) { status = n; return res; }, json(v: unknown) { result = v; return res; } };
  actions.add(String(body.action));
  await handler({ method: 'POST', body } as any, res);
  return { status, result };
}

function participant(name: string, client: ClientKind = 'cc'): Participant {
  return { name, client, role: 'member', color: '#000000', initials: 'AR', canSpeak: true, joinedAt: 1, lastSeenAt: 1 };
}

function message(name: string, client: ClientKind, text: string, type: Message['type'] = 'msg'): Message {
  return { id: Date.now(), time: Date.now(), name, client, text, type, role: '', initials: 'AR', color: '#000000' };
}

async function room(code: string) {
  const created = await web.createRoom({ code, topic: 'Boundary regression', createdBy: 'Host' });
  keys.set(`room:${code}:hostKey`, created.hostKey);
  await mcp.joinRoom(client, code, participant('Host', 'web'), { hostKey: created.hostKey });
  for (const name of ['Agent', 'Reviewer']) await mcp.joinRoom(client, code, participant(name));
  return created;
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'agent-room-boundary-'));
  process.env.AGENT_ROOM_SQLITE_PATH = join(temp, 'test.sqlite');
  openDb(process.env.AGENT_ROOM_SQLITE_PATH, 'create');
  handler = (await import('./room')).default;
  vi.stubEnv('AGENT_ROOM_BASE_URL', 'http://agent-room.test');
  vi.stubGlobal('localStorage', { getItem: (key: string) => keys.get(key) ?? null });
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== '/api/room' && url !== 'http://agent-room.test/api/room') {
      unexpectedRequests.push(url);
      throw new Error(`Non-API network access forbidden: ${url}`);
    }
    const { status, result } = await request(JSON.parse(init.body as string));
    return { ok: status === 200, status, json: async () => result };
  });
  client = mcp.createRoomApiClient();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeDb();
  if (originalPath === undefined) delete process.env.AGENT_ROOM_SQLITE_PATH;
  else process.env.AGENT_ROOM_SQLITE_PATH = originalPath;
  rmSync(temp, { recursive: true, force: true });
});

test('browser, MCP and shell create contracts return the authoritative room and host key', async () => {
  const browser = await room('API-NEW-001');
  expect((await web.getRoom(browser.code)).topic).toBe('Boundary regression');
  const created = await mcp.createRoom(client, { topic: 'MCP created', createdBy: 'MCP Host' });
  expect(created.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  expect(created.hostKey).toHaveLength(32);
  expect(created.topic).toBe('MCP created');
  expect((await mcp.getRoom(client, created.code)).createdBy).toBe('MCP Host');
  const shell = await request({ action: 'create', topic: 'Shell created', createdBy: 'Shell Host' });
  expect(shell.status).toBe(200);
  expect(shell.result.hostKey).toHaveLength(32);
  expect((await stores.rooms.getRoom(shell.result.code)).topic).toBe('Shell created');
  expect((await mcp.removeParticipant(client, browser.code, 'Host', 'Reviewer', 'cc')).participants.map(p => p.name)).not.toContain('Reviewer');
});

test('browser host controls and MCP turn contracts mutate SQLite with host authorization', async () => {
  const { code, hostKey } = await room('API-CTL-001');
  await expect(mcp.endRoom(client, code, 'Host', 'wrong')).rejects.toBeInstanceOf(mcp.NotHostError);
  await expect(web.setMuted(code, 'Agent', 'Reviewer', 'cc', true)).rejects.toMatchObject({ name: 'NotHostError' });
  expect((await web.setMuted(code, 'Host', 'Agent', 'cc', true)).participants.find(p => p.name === 'Agent')?.canSpeak).toBe(false);
  await expect(mcp.appendMessage(client, code, message('Agent', 'cc', 'Muted'))).rejects.toBeInstanceOf(mcp.MutedError);
  await web.setMuted(code, 'Host', 'Agent', 'cc', false);
  expect((await web.endRoom(code, 'Host')).status).toBe('ended');
  expect((await web.reactivateRoom(code, 'Host')).status).toBe('active');
  await web.setReplyMode(code, 'Host', 'sequential', { leadAgentName: 'Agent', leadAgentClient: 'cc' });
  await web.appendMessage(code, message('Host', 'web', 'Start a turn'));
  expect((await web.getTurnState(code))?.currentName).toBe('Agent');
  expect(await web.directInvoke(code, 'Host', { name: 'Reviewer', client: 'cc' }, 'host')).toBe(true);
  expect((await mcp.getTurnState(client, code))?.hostDirected).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Reviewer', source: 'host' })]));
  expect((await web.hostSkipCurrent(code, 'Host'))?.name).toBe('Agent');
  await web.appendSystemMessage(code, 'Host', message('system', 'cc', 'Host skipped Agent', 'sys'));
  await mcp.appendSystemMessage(client, code, 'Host', hostKey, message('system', 'cc', 'Mode notice', 'sys'));
  expect((await mcp.listMessages(client, code, 0)).map(m => m.text)).toContain('Mode notice');
  await mcp.setReplyMode(client, code, 'Host', hostKey, 'open', undefined);
  expect(await web.getTurnState(code)).toBeNull();
  expect((await mcp.endRoom(client, code, 'Host', hostKey)).status).toBe('ended');
  expect((await mcp.reactivateRoom(client, code, 'Host', hostKey)).status).toBe('active');
  expect((await stores.rooms.getRoom(code)).replyMode).toBe('open');
});

test('MCP task lifecycle, role reassignment and report readers share server-owned state', async () => {
  const { code, hostKey } = await room('API-TSK-001');
  expect((await mcp.getTaskBoard(client, code)).tasks).toEqual([]);
  const { task } = await mcp.createTask(client, code, 'Agent', { title: 'Implement B1', owner: 'Agent', verifier: 'Reviewer', dod: 'API regression passes' });
  expect((await mcp.claimTask(client, code, task.id, 'Agent', 'cc')).task.state).toBe('in_progress');
  expect((await mcp.submitTask(client, code, task.id, 'Agent', 'cc', { fileListing: 'api/room.ts', fileExcerpt: 'stores.rooms', runOutput: 'PASS', exitCode: 0 })).task.state).toBe('awaiting_review');
  await expect(mcp.verifyTask(client, code, task.id, 'Agent', 'cc', 'done')).rejects.toBeInstanceOf(mcp.OwnerCannotVerifyError);
  expect((await mcp.verifyTask(client, code, task.id, 'Reviewer', 'cc', 'done')).task.state).toBe('done');
  const second = await mcp.createTask(client, code, 'Host', { title: 'Review follow-up', owner: 'Agent' });
  await expect(mcp.reassignTaskRoles(client, code, second.task.id, 'Agent', 'cc', { owner: 'Reviewer' })).rejects.toBeInstanceOf(mcp.NotHostError);
  const reassigned = await mcp.reassignTaskRoles(client, code, second.task.id, 'Host', 'web', { owner: 'Reviewer', ownerClient: 'cc' }, hostKey);
  expect(reassigned.task.owner).toBe('Reviewer');
  expect(await stores.taskBoards.getTaskBoard(code)).toEqual(await mcp.getTaskBoard(client, code));
  expect(await stores.taskBoards.listBoardRooms()).toContain(code);
  await mcp.appendMessage(client, code, message('Agent', 'cc', 'Decision: the API owns persistence'));
  const report = await web.createRoomReport(code);
  expect(report.transcript.map(m => m.text)).toContain('Decision: the API owns persistence');
  expect(report.summary).toContain('1 task(s) verified done');
  expect(await web.getRoomReport(code)).toEqual(report);
  expect(await stores.reports.getReport(code)).toEqual(report);
  expect((await mcp.createRoomReport(client, code)).topic).toBe(report.topic);
  for (const render of [(await import('./report-page')).default, (await import('./report-og')).default]) {
    let output = '';
    const res: any = { status(n: number) { expect(n).toBe(200); return res; }, setHeader() { return res; }, send(s: string) { output = s; return res; } };
    await render({ method: 'GET', query: { code } } as any, res);
    expect(output).toContain('Boundary regression');
  }
});

test('shell webhook contracts persist registration, update and removal without Redis', async () => {
  const { code } = await room('API-WHK-001');
  const payload = { action: 'webhookSet', code, requesterName: 'Agent', url: 'https://receiver.invalid/hook', secret: 'disposable-test-secret' };
  expect((await request({ ...payload, requesterName: 'Absent' })).status).toBe(403);
  expect((await request({ ...payload, url: 'file:///invalid' })).status).toBe(400);
  const created = await request(payload);
  expect(created.status).toBe(200);
  const updated = await request({ ...payload, secret: 'replacement' });
  expect(updated.result.webhook.id).toBe(created.result.webhook.id);
  expect((await request({ action: 'webhookList', code })).result.webhooks).toEqual(await stores.webhooks.listWebhooks(code));
  expect((await stores.webhooks.listWebhooks(code))[0].secret).toBe('replacement');
  expect((await request({ action: 'webhookDelete', code, requesterName: 'Agent', id: payload.url })).result.removed).toBe(true);
  expect(await stores.webhooks.listWebhooks(code)).toEqual([]);
});

test('moderator invoke, delegated reassignment and timeout sweep use SQLite turn and claim stores', async () => {
  const { code, hostKey } = await room('API-SWP-001');
  let configured = await mcp.setReplyMode(client, code, 'Host', hostKey, 'moderator', { moderatorAgentName: 'Agent', moderatorAgentClient: 'cc' });
  await web.appendMessage(code, message('Host', 'web', 'Coordinate this turn'));
  await expect(mcp.directInvoke(client, code, 'Reviewer', undefined, { name: 'Agent', client: 'cc' }, 'host')).rejects.toBeInstanceOf(mcp.NotHostError);
  expect(await mcp.directInvoke(client, code, 'Agent', undefined, { name: 'Reviewer', client: 'cc' }, 'host')).toBe(true);
  expect((await mcp.getTurnState(client, code))?.hostDirected?.[0].source).toBe('moderator');
  expect((await mcp.listMessages(client, code, 0)).some(m => m.metadata?.eventType === 'moderator_dispatched')).toBe(true);
  const { task } = await mcp.createTask(client, code, 'Agent', { title: 'Delegated task', owner: 'Agent' });
  expect((await mcp.reassignTaskRoles(client, code, task.id, 'Agent', 'cc', { owner: 'Reviewer' })).task.owner).toBe('Reviewer');
  const expired = newModeratorTurn(configured, 1, 1)!;
  await stores.turnState.setTurnState(code, expired);
  configured = await mcp.sweepRoom(client, code);
  expect(configured.modeConfig?.moderatorAgentName).toBe('Reviewer');
  expect((await stores.turnState.getTurnState(code))?.moderatorName).toBe('Reviewer');
  expect(await stores.sweepClaims.acquireSweepClaim(code, `mod:Agent:cc:${expired.deadline}`)).toBe(false);
  expect((await mcp.listMessages(client, code, 0)).some(m => m.metadata?.eventType === 'moderator_handoff')).toBe(true);
  expect((await mcp.hostSkipCurrent(client, code, 'Host', hostKey))?.name).toBe('Reviewer');
});

test('finite B1 action set is exercised and active clients do not import persistence implementations', () => {
  for (const action of ['create', 'remove-participant', 'setMuted', 'end', 'reactivate', 'setReplyMode', 'turnState', 'directInvoke', 'skipCurrent', 'systemMessage', 'sweep', 'taskBoard', 'taskCreate', 'taskClaim', 'taskSubmit', 'taskVerify', 'taskReassign', 'createReport', 'getReport', 'webhookSet', 'webhookList', 'webhookDelete']) {
    expect(actions.has(action), action).toBe(true);
  }
  expect(unexpectedRequests).toEqual([]);
  for (const file of ['apps/web/src/screens/Room.tsx', 'apps/web/src/screens/Report.tsx', 'apps/web/src/screens/Join.tsx', 'apps/web/src/lib/roomApi.ts', 'apps/mcp/src/roomApi.ts', 'api/report-page.ts', 'api/report-og.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source, file).not.toMatch(/createClient\(|ENV\.upstash|UPSTASH_REDIS|sqlite-persistence/);
  }
});
