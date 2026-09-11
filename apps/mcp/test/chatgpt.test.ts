import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { detectHarness, defaultListenAfterJoin, persistenceSetupHint, mcpTimeoutHint } from '../src/harness.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('ChatGPT turn-based mode', () => {
  it('explicit marker overrides inherited signals and always skips bundled listens', () => {
    const harness = detectHarness({ AGENT_ROOM_HARNESS: 'chatgpt', CLAUDECODE: '1', CODEX_HOME: '/codex', CURSOR_AGENT: '1' });
    expect(harness.kind).toBe('chatgpt');
    for (const explicit of [undefined, false, true]) expect(defaultListenAfterJoin(harness, explicit)).toBe(false);
    expect(persistenceSetupHint(harness)).toBe('');
    expect(mcpTimeoutHint(harness)).toContain('return to the user');
    expect(mcpTimeoutHint(harness)).not.toMatch(/chain|install|hook/);
  });

  it.each(['chatgpt', 'other'])('exposes the appropriate instructions for %s', async marker => {
    vi.stubEnv('AGENT_ROOM_HARNESS', marker);
    vi.resetModules();
    const { registerTools, STDIO_SERVER_INSTRUCTIONS } = await import('../src/tools.js');
    const handlers = new Map();
    registerTools({ setRequestHandler: (schema: unknown, handler: unknown) => handlers.set(schema, handler), sendLoggingMessage: async () => {} } as any);
    const { tools } = await handlers.get(ListToolsRequestSchema)({});
    const text = JSON.stringify(tools) + STDIO_SERVER_INSTRUCTIONS;
    if (marker === 'chatgpt') {
      expect(text).not.toMatch(/never end your turn|PRESENCE LOOP|keep the room_listen loop|After sending, listen again|Stop hook/);
      expect(STDIO_SERVER_INSTRUCTIONS).toContain('return to the user');
      expect(tools.find((t: any) => t.name === 'room_join').inputSchema.properties.listenAfterJoin.description).toContain('always skipped');
    } else {
      expect(STDIO_SERVER_INSTRUCTIONS).toContain('never end your turn');
      expect(text).toContain('PRESENCE LOOP');
    }
  });
});

vi.mock('../src/roomApi.js', async importOriginal => {
  const actual = await importOriginal<any>();
  const participant = { name: 'Tester', client: 'cc', canSpeak: true };
  const room = { code: 'TEST-ONLY', topic: 'test', status: 'active', replyMode: 'open', participants: [participant], participant, createdBy: 'Host' };
  return { ...actual, createRoomApiClient: () => ({}), getRoom: async () => room, joinRoom: vi.fn(async () => room), listMessages: vi.fn(async () => []), readMessages: vi.fn(async () => ({ messages: [], cursor: 0 })), appendMessage: vi.fn(async () => ({})), setListenUntil: vi.fn(async () => {}), getTaskBoard: async () => null };
});
vi.mock('../src/state.js', () => ({ setRoom: vi.fn(), removeRoom: vi.fn(), acknowledgeDelivery: vi.fn(), markSent: vi.fn(), readState: async () => ({ rooms: { 'TEST-ONLY': { cursor: 7 } } }), readRoomStateForJoin: async () => undefined }));

it('joins without polling, posts, and returns after a quiet listen', async () => {
  vi.stubEnv('AGENT_ROOM_HARNESS', 'chatgpt');
  vi.resetModules();
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { registerTools } = await import('../src/tools.js');
  const api = await import('../src/roomApi.js');
  const state = await import('../src/state.js');
  const handlers = new Map();
  registerTools({ setRequestHandler: (schema: unknown, handler: unknown) => handlers.set(schema, handler), sendLoggingMessage: async () => {} } as any);
  const call = async (name: string, args: any) => JSON.parse((await handlers.get(CallToolRequestSchema)({ params: { name, arguments: { code: 'TEST-ONLY', name: 'Tester', ...args } } })).content[0].text);
  const joined = await call('room_join', { listenAfterJoin: true });
  expect(joined.clientKind).toBe('chatgpt');
  expect(api.setListenUntil).not.toHaveBeenCalled();
  expect(joined.hint).toContain('return to the user');
  expect(joined.autoWatchStarted).toBe(false);
  vi.mocked(state.acknowledgeDelivery).mockClear();
  const sent = await call('room_send', { text: 'test' });
  expect(sent.cursor).toBe(7);
  expect(state.acknowledgeDelivery).not.toHaveBeenCalled();
  expect(sent.hint).toContain('return to the user');
  await call('room_status', { text: 'still working' });
  expect(state.acknowledgeDelivery).not.toHaveBeenCalled();
  await call('room_list_messages', { since: 0 });
  expect(state.acknowledgeDelivery).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    const listening = call('room_listen', { since: 0, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    const result = await listening;
    expect(result.messages).toEqual([]);
    expect(result.hint).toContain('return to the user');
    expect(result.hint).not.toMatch(/NEXT TOOL CALL|signal to end your turn|listen again/);
  } finally { vi.useRealTimers(); }
});
