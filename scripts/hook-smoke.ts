// Smoke test for the agent-room-mcp hook subcommand.
//
// Creates a real room on the public Upstash demo, writes a state-file entry
// for it, posts a message from a different client name, runs the hook with
// each event type and checks the output shape. Cleans up afterwards.
//
// Run: node --import tsx scripts/hook-smoke.ts

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  createClient,
  createRoom,
  joinRoom,
  appendMessage,
} from '../packages/upstash-client/src/index.ts';
import { generateCode } from '../packages/shared/src/index.ts';
import type { Participant, Message } from '../packages/shared/src/types.ts';

const url = process.env.UPSTASH_REDIS_REST_URL || 'https://current-wasp-67710.upstash.io';
const token = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAQh-AAIncDE0MTY0MDY0NDdiOWE0ODE5YTVhMzJmNmNlZTk0MTM3OHAxNjc3MTA';

// Use a dedicated state file for the test so we don't touch the user's real
// per-session state. The MCP entrypoint honors AGENT_ROOM_STATE_FILE.
const STATE_FILE = join(homedir(), '.agent-room', `state-smoke-${process.pid}.json`);
const HOOK_BIN = join(__dirname, '..', 'apps', 'mcp', 'dist', 'index.js');

async function cleanupState(): Promise<void> {
  try { await fs.unlink(STATE_FILE); } catch { /* ok */ }
}

interface HookResult { stdout: string; stderr: string; code: number }

async function runHook(payload: object): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_BIN, 'hook'], {
      env: {
        ...process.env,
        UPSTASH_REDIS_REST_URL: url,
        UPSTASH_REDIS_REST_TOKEN: token,
        AGENT_ROOM_STATE_FILE: STATE_FILE,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function main() {
  const client = createClient({ url, token });
  const code = generateCode();
  const selfName = 'hook-smoke-self';
  const otherName = 'hook-smoke-other';

  console.log(`room: ${code}`);
  await createRoom(client, { code, topic: 'hook smoke test', createdBy: selfName });
  const selfP: Participant = { name: selfName, role: '', color: '#000', initials: 'SM', client: 'cc', joinedAt: Date.now(), lastSeenAt: Date.now() };
  await joinRoom(client, code, selfP);

  const otherMsg: Message = {
    id: Date.now(),
    type: 'msg',
    name: otherName,
    initials: 'OT',
    color: '#111',
    role: 'PM',
    text: 'hello from another agent',
    client: 'web',
    time: Date.now(),
  };
  await appendMessage(client, code, otherMsg);

  try {
    await fs.mkdir(join(homedir(), '.agent-room'), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({
      version: 1,
      rooms: { [code]: { name: selfName, cursor: 0, joinedAt: Date.now() } },
    }, null, 2));

    let passed = 0, failed = 0;
    const check = (name: string, cond: boolean, detail = '') => {
      if (cond) { console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); passed++; }
      else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
    };

    // 1. Stop event with messages → decision: block + reason
    {
      const r = await runHook({ hook_event_name: 'Stop', stop_hook_active: false });
      check('Stop exits 0', r.code === 0, `code=${r.code}`);
      let parsed: any = null;
      try { parsed = JSON.parse(r.stdout); } catch { /* */ }
      check('Stop emits JSON', parsed !== null);
      check('Stop decision=block', parsed?.decision === 'block');
      check('Stop reason mentions other agent', typeof parsed?.reason === 'string' && parsed.reason.includes(otherName));
    }

    // 2. Output is not acknowledgement → next Stop redelivers
    {
      const r = await runHook({ hook_event_name: 'Stop', stop_hook_active: false });
      check('Stop without acknowledgement redelivers', JSON.parse(r.stdout).reason.includes(otherName));
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      check('Stop output leaves processed cursor unchanged', stateNow.rooms[code].cursor === 0);
    }

    // 3a. stop_hook_active=true + new messages + streak under cap → still blocks
    //     (this is the v0.6.0 change: agent-to-agent chat can continue past
    //     the first auto-continue, up to MAX_BLOCKS_PER_CYCLE)
    {
      await appendMessage(client, code, { ...otherMsg, id: Date.now() + 1, text: 'follow-up' });
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      stateNow.rooms[code].cursor = 0;
      stateNow.blockStreak = 1; // simulate one prior block in this cycle
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      const r = await runHook({ hook_event_name: 'Stop', stop_hook_active: true });
      let parsed: any = null;
      try { parsed = JSON.parse(r.stdout); } catch {/* */}
      check('stop_hook_active=true + msgs + low streak → still block', parsed?.decision === 'block');
    }

    // 3b. stop_hook_active=true + new messages + streak AT cap → no output (cap exit)
    {
      await appendMessage(client, code, { ...otherMsg, id: Date.now() + 99, text: 'over-cap' });
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      stateNow.rooms[code].cursor = 0;
      stateNow.blockStreak = 8; // at the cap
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      const r = await runHook({ hook_event_name: 'Stop', stop_hook_active: true });
      check('stop_hook_active=true + streak at cap → no output', r.stdout.trim() === '');
      const after = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      check('cap-exit resets blockStreak to 0', (after.blockStreak ?? 0) === 0, `blockStreak=${after.blockStreak}`);
    }

    // 3c. UserPromptSubmit resets blockStreak
    {
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      stateNow.blockStreak = 5;
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      await runHook({ hook_event_name: 'UserPromptSubmit' });
      const after = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      check('UserPromptSubmit resets blockStreak', (after.blockStreak ?? 0) === 0);
    }

    // 4. UserPromptSubmit event with messages → additionalContext
    {
      // Reset cursor again
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      stateNow.rooms[code].cursor = 0;
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      const r = await runHook({ hook_event_name: 'UserPromptSubmit' });
      let parsed: any = null;
      try { parsed = JSON.parse(r.stdout); } catch {/* */}
      check('UserPromptSubmit emits JSON', parsed !== null);
      check('UserPromptSubmit hookSpecificOutput shape',
        parsed?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' &&
        typeof parsed?.hookSpecificOutput?.additionalContext === 'string');
    }

    // 5. SessionStart event
    {
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      stateNow.rooms[code].cursor = 0;
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      const r = await runHook({ hook_event_name: 'SessionStart' });
      let parsed: any = null;
      try { parsed = JSON.parse(r.stdout); } catch {/* */}
      check('SessionStart emits JSON', parsed !== null);
      check('SessionStart hookSpecificOutput shape',
        parsed?.hookSpecificOutput?.hookEventName === 'SessionStart' &&
        typeof parsed?.hookSpecificOutput?.additionalContext === 'string');
    }

    // 5b. Long-poll: lastSentAt recent + no new messages → hook waits, then catches a delayed reply
    {
      // Reset state: cursor at end, lastSentAt = now
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      // Move cursor past everything currently in the room
      // (We need to know the current length — fetch it.)
      const len = (await import('../packages/upstash-client/src/index.ts')).listMessages;
      const all = await len(client, code, 0);
      stateNow.rooms[code].cursor = all.length;
      stateNow.rooms[code].lastSentAt = Date.now();
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));

      // Kick off the hook in the background, then send a message 2s later
      const startedAt = Date.now();
      const hookPromise = runHook({ hook_event_name: 'Stop', stop_hook_active: false });
      setTimeout(() => {
        appendMessage(client, code, { ...otherMsg, id: Date.now() + 100, text: 'delayed reply' })
          .catch(() => {/* */});
      }, 2000);

      const r = await hookPromise;
      const elapsed = Date.now() - startedAt;
      let parsed: any = null;
      try { parsed = JSON.parse(r.stdout); } catch {/* */}
      check('long-poll waited at least ~2s', elapsed >= 1800, `elapsed=${elapsed}ms`);
      check('long-poll caught delayed reply (decision=block)', parsed?.decision === 'block', `stdout=${r.stdout.slice(0, 80)}`);
      check('long-poll bailed before 8s ceiling', elapsed < 7500, `elapsed=${elapsed}ms`);
    }

    // 5c. Long-poll: no recent send → exits fast even with no messages
    {
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      const allMsgs = (await import('../packages/upstash-client/src/index.ts')).listMessages;
      const all = await allMsgs(client, code, 0);
      stateNow.rooms[code].cursor = all.length;
      delete stateNow.rooms[code].lastSentAt;
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));

      const startedAt = Date.now();
      const r = await runHook({ hook_event_name: 'Stop', stop_hook_active: false });
      const elapsed = Date.now() - startedAt;
      check('no-recent-send Stop exits fast', elapsed < 1500, `elapsed=${elapsed}ms`);
      check('no-recent-send Stop emits nothing', r.stdout.trim() === '');
    }

    // 6. Own messages should be filtered (without advancing the cursor)
    {
      const stateNow = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
      stateNow.rooms[code].cursor = 999; // past everything
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      const ownMsg: Message = { ...otherMsg, id: Date.now() + 2, name: selfName, client: 'cc', text: 'I sent this' };
      await appendMessage(client, code, ownMsg);
      // Set cursor to right before our own message (we don't actually know the index — just set to 0 again)
      stateNow.rooms[code].cursor = 0;
      await fs.writeFile(STATE_FILE, JSON.stringify(stateNow));
      const r = await runHook({ hook_event_name: 'Stop', stop_hook_active: false });
      let parsed: any = null;
      try { parsed = JSON.parse(r.stdout); } catch {/* */}
      // Either there are still other-agent messages we missed (likely yes since we just reset to 0)
      // and self message is filtered, OR no output at all.
      const okShape = r.stdout.trim() === '' || (parsed?.decision === 'block' && !parsed.reason.includes('I sent this'));
      check('Own messages filtered out of reason', okShape, `stdout=${r.stdout.slice(0,100)}`);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    await cleanupState();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
