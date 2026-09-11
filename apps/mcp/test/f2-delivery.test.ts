import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const code = 'F2-TEST-001';
const remote = vi.hoisted(() => ({ messages: [] as any[], reads: [] as number[] }));
vi.mock('../src/roomApi.js', async original => {
  const actual = await original<any>();
  const participant = { name: 'Agent', client: 'cc', canSpeak: true };
  const room = { code: 'F2-TEST-001', topic: 'F2', status: 'active', replyMode: 'open', participants: [participant], participant, createdBy: 'Host' };
  return {
    ...actual,
    createRoomApiClient: () => ({}),
    createRoom: async () => ({ ...room, hostKey: 'host-proof' }),
    getRoom: async () => room,
    joinRoom: async () => room,
    appendMessage: async () => ({}),
    setListenUntil: async () => {},
    getTaskBoard: async () => null,
    readMessages: async (_client: unknown, _code: string, since: number) => {
      remote.reads.push(since);
      return { messages: remote.messages.slice(since), cursor: remote.messages.length };
    },
  };
});

let dir: string;
let state: typeof import('../src/state.js');
let call: (name: string, args?: Record<string, unknown>) => Promise<any>;
let logging: ReturnType<typeof vi.fn>;

async function connect() {
  const { registerTools } = await import('../src/tools.js');
  let handler: any;
  logging = vi.fn(async () => {});
  registerTools({
    setRequestHandler(schema: unknown, callback: unknown) { if (schema === CallToolRequestSchema) handler = callback; },
    sendLoggingMessage: logging,
  } as any);
  call = async (name, args = {}) => JSON.parse((await handler({ params: { name, arguments: { code, since: 0, timeoutMs: 0, ...args } } })).content[0].text);
}

beforeEach(async () => {
  vi.resetModules();
  dir = await fs.mkdtemp(join(tmpdir(), 'agent-room-f2-'));
  vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
  vi.stubEnv('AGENT_ROOM_STATE_FILE', join(dir, 'state.json'));
  vi.stubEnv('AGENT_ROOM_HARNESS', 'chatgpt');
  remote.messages = [{ id: 1, time: 1, name: 'Host', client: 'web', text: 'Please process me', type: 'msg' }];
  remote.reads = [];
  state = await import('../src/state.js');
  await state.setRoom(code, { name: 'Agent', cursor: 0, joinedAt: 1 });
  await connect();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await call('room_unwatch');
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await fs.rm(dir, { recursive: true, force: true });
});

it.each([0, 1000])('delivery at timeoutMs=%s stays unprocessed until explicit acknowledgement', async timeoutMs => {
  const delivered = await call('room_listen', { timeoutMs });
  expect(delivered.messages).toEqual(remote.messages);
  expect(delivered.deliveryId).toEqual(expect.any(String));
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  remote.messages.push({ ...remote.messages[0], id: 2, text: 'Arrived after delivery' });
  const next = await call('room_listen', { since: 999, ack: delivered.deliveryId });
  expect((await state.readState()).rooms[code]?.cursor).toBe(1);
  expect(next.messages.map((m: any) => m.id)).toEqual([2]);
  await call('room_listen', { since: 2, ack: next.deliveryId });
  expect((await state.readState()).rooms[code]?.cursor).toBe(2);
});

it('ordinary history cannot acknowledge or replace a pending delivery', async () => {
  const delivered = await call('room_listen');
  const before = await state.readState();
  const history = await call('room_list_messages', { ack: delivered.deliveryId });
  expect(history.messages).toEqual(remote.messages);
  expect(history.deliveryId).toBeUndefined();
  expect(await state.readState()).toEqual(before);
});

it('lost tool result is redelivered after restart even with an advanced supplied cursor', async () => {
  await call('room_listen'); // the harness drops this result before the agent runs
  vi.resetModules();
  state = await import('../src/state.js');
  await connect();
  const retry = await call('room_listen', { since: 999 });
  expect(retry.messages).toEqual(remote.messages);
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  await call('room_listen', { since: retry.cursor, ack: retry.deliveryId });
  vi.resetModules();
  state = await import('../src/state.js');
  await connect();
  const duplicateAck = await call('room_listen', { since: retry.cursor, ack: retry.deliveryId });
  expect(duplicateAck.messages).toEqual([]);
  expect((await state.readState()).rooms[code]?.cursor).toBe(1);
});

it('rejects unknown, cross-room and superseded receipts without skipping work', async () => {
  const first = await call('room_listen');
  const retry = await call('room_listen', { since: 1 });
  for (const ack of ['unknown', first.deliveryId, 1, null]) {
    await expect(call('room_listen', { ack })).rejects.toThrow();
    expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  }
  await state.setRoom('OTHER', { name: 'Agent', cursor: 0, joinedAt: 1 });
  await expect(call('room_listen', { code: 'OTHER', ack: retry.deliveryId })).rejects.toThrow();
  expect((await call('room_listen', { since: 999 })).messages).toEqual(remote.messages);
});

it.each([-1, 0.5, NaN, Infinity, '1'])('rejects invalid since=%s before acknowledgement', async since => {
  const delivered = await call('room_listen');
  await expect(call('room_listen', { since, ack: delivered.deliveryId })).rejects.toThrow();
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
});

it.each(['room_create', 'room_join'])('%s without bundled listen keeps initial messages recoverable', async tool => {
  await state.removeRoom(code);
  const joined = await call(tool, { name: 'Agent', topic: 'F2', listenAfterJoin: false });
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  expect((await call('room_listen', { since: joined.cursor })).messages).toEqual(remote.messages);
});

it.each(['room_create', 'room_join'])('%s bundled listen returns a receipt without committing', async tool => {
  vi.stubEnv('AGENT_ROOM_HARNESS', 'claude-code');
  await state.removeRoom(code);
  await connect();
  const joined = await call(tool, { name: 'Agent', topic: 'F2', listenAfterJoin: true, listenTimeoutMs: 1000 });
  expect(joined.messages).toEqual(remote.messages);
  expect(joined.deliveryId).toEqual(expect.any(String));
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
});

it('rejoin preserves the unacknowledged receipt and host capability', async () => {
  await state.setRoom(code, { name: 'Agent', cursor: 0, joinedAt: 1, hostKey: 'proof' });
  const delivered = await call('room_listen');
  await call('room_join', { name: 'Agent', listenAfterJoin: false });
  expect((await state.readState()).rooms[code]).toMatchObject({ cursor: 0, hostKey: 'proof', pendingDelivery: { id: delivered.deliveryId } });
  await call('room_listen', { since: 1, ack: delivered.deliveryId });
  expect((await state.readState()).rooms[code]?.cursor).toBe(1);
});

it('failed atomic acknowledgement write leaves the receipt retryable', async () => {
  const delivered = await call('room_listen');
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated interruption'));
  await expect(call('room_listen', { since: 1, ack: delivered.deliveryId })).rejects.toThrow('simulated interruption');
  rename.mockRestore();
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  await call('room_listen', { since: 1, ack: delivered.deliveryId });
  expect((await state.readState()).rooms[code]?.cursor).toBe(1);
});

it('a separate process can acknowledge a persisted receipt after restart', async () => {
  const delivered = await call('room_listen');
  const moduleUrl = new URL('../src/state.ts', import.meta.url).href;
  const script = `const state = await import(${JSON.stringify(moduleUrl)});
    await state.acknowledgeDelivery(${JSON.stringify(code)}, ${JSON.stringify(delivered.deliveryId)});
    console.log(JSON.stringify(await state.readState()));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, AGENT_ROOM_STATE_DIR: dir, AGENT_ROOM_STATE_FILE: join(dir, 'state.json'), AGENT_ROOM_HARNESS: 'chatgpt' },
  });
  expect(JSON.parse(stdout).rooms[code].cursor).toBe(1);
  expect((await call('room_listen', { since: 1 })).messages).toEqual([]);
});

it('retry repairs a harness mirror interrupted after the scoped acknowledgement committed', async () => {
  vi.stubEnv('AGENT_ROOM_STATE_FILE', '');
  vi.stubEnv('AGENT_ROOM_HARNESS', '');
  vi.stubEnv('CLAUDECODE', '');
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
  vi.stubEnv('CODEX_RUN_ID', 'f2-harness');
  vi.resetModules();
  state = await import('../src/state.js');
  await state.setRoom(code, { name: 'Agent', cursor: 0, joinedAt: 1 });
  await connect();
  const delivered = await call('room_listen');
  const harnessFile = join(dir, 'state-harness-codex.json');
  const rename = fs.rename.bind(fs);
  const failingMirror = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === harnessFile) throw new Error('mirror interrupted');
    await rename(from, to);
  });
  await expect(call('room_listen', { since: 1, ack: delivered.deliveryId })).rejects.toThrow('mirror interrupted');
  failingMirror.mockRestore();
  expect((await state.readState()).rooms[code]?.cursor).toBe(1);
  expect((await state.readHarnessStateOrMerged()).rooms[code]?.cursor).toBe(0);
  await call('room_listen', { since: 1, ack: delivered.deliveryId });
  expect((await state.readHarnessStateOrMerged()).rooms[code]?.cursor).toBe(1);
});

it('lock contention refuses acknowledgement without modifying durable state', async () => {
  const delivered = await call('room_listen');
  const before = await fs.readFile(join(dir, 'state.json'), 'utf8');
  const mkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: any[]) => {
    if (args[0] === join(dir, '.state-lock')) throw new Error('lock held');
    return (mkdir as any)(...args);
  });
  // A disappearing lock repeatedly loses acquisition, deterministically
  // exhausting the existing retry budget without wall-clock sleeps.
  await expect(call('room_listen', { since: 1, ack: delivered.deliveryId })).rejects.toThrow('state is busy');
  expect(await fs.readFile(join(dir, 'state.json'), 'utf8')).toBe(before);
});

it('receipt persistence failure cannot turn a fetch into processed work', async () => {
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('receipt write interrupted'));
  await expect(call('room_listen')).rejects.toThrow('receipt write interrupted');
  rename.mockRestore();
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  expect((await call('room_listen', { since: 999 })).messages).toEqual(remote.messages);
});

it('legacy watch-once output leaves its existing cursor file untouched', async () => {
  const cursorFile = join(dir, 'room-cursor.txt');
  await fs.writeFile(cursorFile, '1');
  const scriptUrl = new URL('../../../scripts/watch-once.mjs', import.meta.url).href;
  const script = `globalThis.fetch = async (_url, init) => {
    if (JSON.parse(init.body)[2] !== 1) throw new Error('wrong scan cursor');
    return { json: async () => ({ result: [JSON.stringify({name:'Host',text:'unprocessed',time:1})] }) };
  };
  await import(${JSON.stringify(scriptUrl)});`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir, CODE: code, UPSTASH_REDIS_REST_URL: 'https://unused.invalid', UPSTASH_REDIS_REST_TOKEN: 'test' },
  });
  expect(stdout).toContain('unprocessed');
  expect(await fs.readFile(cursorFile, 'utf8')).toBe('1');
});

it.each([
  { hook_event_name: 'Stop' },
  { status: 'completed', loop_count: 0 },
  { hook_event_name: 'UserPromptSubmit' },
  { hook_event_name: 'SessionStart' },
])('hook $hook_event_name $status previews survive dropped or failed handoff', async input => {
  const stdin = new PassThrough();
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as any);
  const exited = new Error('hook exit');
  vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const { runHook } = await import('../src/hook.js');
  let running = runHook();
  stdin.write(JSON.stringify(input));
  stdin.emit('end');
  await expect(running).rejects.toBe(exited);
  expect(String(output.mock.calls[0]?.[0])).toContain('room_listen');
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  output.mockImplementationOnce(() => { throw new Error('broken continuation pipe'); });
  running = runHook();
  stdin.write(JSON.stringify(input));
  stdin.emit('end');
  await expect(running).rejects.toThrow('broken continuation pipe');
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  const resumed = await call('room_listen');
  expect(resumed.messages).toEqual(remote.messages);
  await call('room_listen', { since: 1, ack: resumed.deliveryId });
  expect((await state.readState()).rooms[code]?.cursor).toBe(1);
});

it('failed and ignored watcher notifications replay until a listen is acknowledged', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  logging.mockRejectedValueOnce(new Error('handoff failed'));
  await call('room_watch', { name: 'Agent' });
  await vi.waitFor(() => expect(logging).toHaveBeenCalledTimes(1));
  expect((await state.readState()).rooms[code]?.cursor).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(logging).toHaveBeenCalledTimes(2));
  expect(remote.reads).toEqual([0, 0]);
  const delivered = await call('room_listen');
  await call('room_listen', { since: 1, ack: delivered.deliveryId });
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(remote.reads.at(-1)).toBe(1));
  expect(logging).toHaveBeenCalledTimes(2);
});
