import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeStates, type AgentRoomState } from '../src/state.js';

async function makeStateDir(prefix: string) {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mergeStates', () => {
  it('keeps the highest cursor for rooms found in multiple PPID state files', () => {
    const older: AgentRoomState = {
      version: 1,
      blockStreak: 2,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 10,
          joinedAt: 100,
        },
      },
    };
    const newer: AgentRoomState = {
      version: 1,
      blockStreak: 5,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 14,
          joinedAt: 200,
          lastSentAt: 300,
        },
      },
    };

    expect(mergeStates([older, newer])).toEqual({
      version: 1,
      blockStreak: 5,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 14,
          joinedAt: 200,
          lastSentAt: 300,
        },
      },
    });
  });

  it('preserves separate rooms while merging block streaks', () => {
    const first: AgentRoomState = {
      version: 1,
      blockStreak: 1,
      rooms: {
        'AAA-BBB-CCC': { name: 'Cursor', cursor: 2, joinedAt: 100 },
      },
    };
    const second: AgentRoomState = {
      version: 1,
      blockStreak: 3,
      rooms: {
        'DDD-EEE-FFF': { name: 'Cursor', cursor: 7, joinedAt: 200 },
      },
    };

    expect(mergeStates([first, second])).toEqual({
      version: 1,
      blockStreak: 3,
      rooms: {
        'AAA-BBB-CCC': { name: 'Cursor', cursor: 2, joinedAt: 100 },
        'DDD-EEE-FFF': { name: 'Cursor', cursor: 7, joinedAt: 200 },
      },
    });
  });
});

describe('state harness files', () => {
  beforeEach(() => {
    // detectHarness matches Claude Code's env vars before CODEX_RUN_ID —
    // clear them so the tests pass when the suite runs inside Claude Code.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
  });

  it('writes stable Codex harness state alongside the PPID-scoped state', async () => {
    const dir = await makeStateDir('agent-room-state-codex-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    const { setRoom } = await import('../src/state.js');
    await setRoom('ABC-DEF-GHJ', {
      name: 'Codex',
      cursor: 2,
      joinedAt: 123,
    });

    const files = await fs.readdir(dir);
    expect(files).toContain('state-harness-codex.json');

    const harnessRaw = await fs.readFile(join(dir, 'state-harness-codex.json'), 'utf8');
    expect(JSON.parse(harnessRaw).rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 2,
    });
  });

  it('reads Codex harness state when the hook PPID state is empty', async () => {
    const dir = await makeStateDir('agent-room-state-codex-read-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    await fs.writeFile(
      join(dir, 'state-harness-codex.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Codex',
            cursor: 7,
            joinedAt: 456,
          },
        },
      }),
      'utf8'
    );

    const { readHarnessStateOrMerged } = await import('../src/state.js');
    const state = await readHarnessStateOrMerged();
    expect(state.rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 7,
    });
  });

  it('finds a same-name prior room state after the PPID state changes', async () => {
    const dir = await makeStateDir('agent-room-state-rejoin-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);

    await fs.writeFile(
      join(dir, 'state-111.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Claude',
            cursor: 7,
            joinedAt: 456,
          },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      join(dir, 'state-222.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Codex',
            cursor: 12,
            joinedAt: 789,
          },
        },
      }),
      'utf8'
    );

    const { readRoomStateForJoin } = await import('../src/state.js');
    const state = await readRoomStateForJoin('ABC-DEF-GHJ', 'Claude');
    expect(state).toMatchObject({
      name: 'Claude',
      cursor: 7,
    });
  });

  it('recovers one established Grandpa lifecycle from a stale numbered local name', async () => {
    const dir = await makeStateDir('agent-room-state-lineage-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);

    await fs.writeFile(
      join(dir, 'state-333.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Grandpa (2)',
            identityKey: 'g-key',
            cursor: 4,
            joinedAt: 10,
          },
        },
      }),
      'utf8'
    );

    const { readRoomStateForJoin } = await import('../src/state.js');
    const recovered = await readRoomStateForJoin('ABC-DEF-GHJ', 'Grandpa');
    expect(recovered).toMatchObject({
      name: 'Grandpa (2)',
      identityKey: 'g-key',
    });
  });

  it('does not inherit alpha or beta when two Grandpa-family keys exist locally', async () => {
    const dir = await makeStateDir('agent-room-state-ambiguous-grandpa-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);

    await fs.writeFile(
      join(dir, 'state-111.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Grandpa',
            identityKey: 'alpha',
            cursor: 1,
            joinedAt: 10,
          },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      join(dir, 'state-222.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Grandpa (2)',
            identityKey: 'beta',
            cursor: 2,
            joinedAt: 20,
          },
        },
      }),
      'utf8'
    );

    const { readRoomStateForJoin } = await import('../src/state.js');
    await expect(readRoomStateForJoin('ABC-DEF-GHJ', 'Grandpa')).resolves.toBeUndefined();
  });

  it('keeps room-keyed state isolated when merging', async () => {
    const first: AgentRoomState = {
      version: 1,
      rooms: {
        'ROOM-AAA': { name: 'Grandpa', identityKey: 'a', cursor: 1, joinedAt: 1 },
      },
    };
    const second: AgentRoomState = {
      version: 1,
      rooms: {
        'ROOM-BBB': { name: 'Grandpa', identityKey: 'b', cursor: 2, joinedAt: 2 },
      },
    };
    const merged = mergeStates([first, second]);
    expect(merged.rooms['ROOM-AAA']?.identityKey).toBe('a');
    expect(merged.rooms['ROOM-BBB']?.identityKey).toBe('b');
  });
});

describe('state lock', () => {
  it('serializes concurrent acknowledgement retries (no lost updates)', async () => {
    const dir = await makeStateDir('agent-room-state-lock-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const { setRoom, prepareDelivery, acknowledgeDelivery, readMergedState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1 });

    const receipt = await prepareDelivery('AAA-BBB-CCC', 20);
    await Promise.all(Array.from({ length: 20 }, () => acknowledgeDelivery('AAA-BBB-CCC', receipt)));

    const state = await readMergedState();
    expect(state.rooms['AAA-BBB-CCC']?.cursor).toBe(20);
  });

  it('writes state files with 0600 permissions', async () => {
    const dir = await makeStateDir('agent-room-state-mode-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const { setRoom } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1, hostKey: 'secret' });

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const st = await fs.stat(join(dir, f));
      // eslint-disable-next-line no-bitwise
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('recovers a dead lock owner and then writes', async () => {
    const dir = await makeStateDir('agent-room-state-dead-lock-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const lockDir = join(dir, '.state-lock');
    await fs.mkdir(lockDir);
    await fs.writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: 0 }));

    const { setRoom, readState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'Grandpa', identityKey: 'g', cursor: 1, joinedAt: 1 });
    const state = await readState();
    expect(state.rooms['AAA-BBB-CCC']?.name).toBe('Grandpa');
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not steal a live lock owner and does not write unlocked', async () => {
    const dir = await makeStateDir('agent-room-state-live-lock-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const lockDir = join(dir, '.state-lock');
    await fs.mkdir(lockDir);
    await fs.writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    const { setRoom } = await import('../src/state.js');
    await expect(setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1 })).rejects.toThrow(/busy/);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
    const owner = JSON.parse(await fs.readFile(join(lockDir, 'owner.json'), 'utf8')) as { pid: number };
    expect(owner.pid).toBe(process.pid);
  });

  it('does not immediately steal a fresh lock with corrupt owner metadata', async () => {
    const dir = await makeStateDir('agent-room-state-corrupt-lock-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const lockDir = join(dir, '.state-lock');
    await fs.mkdir(lockDir);
    await fs.writeFile(join(lockDir, 'owner.json'), '{not-json');

    const { setRoom } = await import('../src/state.js');
    await expect(setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1 })).rejects.toThrow(/busy/);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    await fs.stat(lockDir);
  });

  it('recovers from an interrupted tmp write without losing later state', async () => {
    const dir = await makeStateDir('agent-room-state-tmp-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('AGENT_ROOM_STATE_FILE', join(dir, 'state.json'));

    await fs.writeFile(join(dir, 'state.json.tmp'), '{not-json', 'utf8');

    const { setRoom, readState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'Grandpa', identityKey: 'g', cursor: 9, joinedAt: 1 });
    const state = await readState();
    expect(state.rooms['AAA-BBB-CCC']).toMatchObject({ name: 'Grandpa', cursor: 9, identityKey: 'g' });
  });
});
