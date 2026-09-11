import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

describe('F2 cursor is independent of wake dispatch', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agent-room-f4-'));
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('successful dispatch without acknowledgement does not advance the processed cursor', async () => {
    const { setRoom, prepareDelivery, readMergedState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'Grandpa', identityKey: 'alpha', cursor: 4, joinedAt: 1 });
    const id = await prepareDelivery('AAA-BBB-CCC', 9);
    expect(id).toBeTruthy();
    expect((await readMergedState()).rooms['AAA-BBB-CCC']?.cursor).toBe(4);
    expect((await readMergedState()).rooms['AAA-BBB-CCC']?.pendingDelivery?.cursor).toBe(9);
  });

  it('acknowledgement after a processing opportunity advances the cursor exactly once', async () => {
    const { setRoom, prepareDelivery, acknowledgeDelivery, readMergedState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'Grandpa', identityKey: 'alpha', cursor: 4, joinedAt: 1 });
    const id = await prepareDelivery('AAA-BBB-CCC', 9);
    await acknowledgeDelivery('AAA-BBB-CCC', id);
    await acknowledgeDelivery('AAA-BBB-CCC', id);
    expect((await readMergedState()).rooms['AAA-BBB-CCC']?.cursor).toBe(9);
  });
});
