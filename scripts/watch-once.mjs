#!/usr/bin/env node
// Polls Upstash list room-msgs:{CODE} from a persisted cursor.
// Exits immediately on first new message(s) OR after MAX_POLLS * POLL_MS.
// Observation only: never persist a processed cursor from watcher output.
// Use MCP room_listen deliveryId/ack for recoverable processing progress.
//
// Usage: UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... CODE=XXX-XXX-XXX node watch-once.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const upUrl = process.env.UPSTASH_REDIS_REST_URL;
const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
const CODE = process.env.CODE || '265-CE6-BZN';
const CURSOR_FILE = join(tmpdir(), 'room-cursor.txt');
const POLL_MS = 2000;
const MAX_POLLS = 15; // ~30 seconds max

if (!upUrl || !tok) { console.error('missing env'); process.exit(1); }

let cursor = existsSync(CURSOR_FILE) ? parseInt(readFileSync(CURSOR_FILE, 'utf8').trim(), 10) || 0 : 0;
const startCursor = cursor;

for (let i = 0; i < MAX_POLLS; i++) {
  const r = await fetch(upUrl + '/', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(['LRANGE', 'room-msgs:' + CODE, cursor, -1]),
  });
  const { result } = await r.json();
  if (result.length > 0) {
    console.log('NEW_MESSAGES=' + result.length);
    for (const line of result) {
      const m = JSON.parse(line);
      const t = new Date(m.time).toLocaleTimeString();
      const arrow = m.client === 'cc' ? '<-' : '->';
      console.log('[' + t + '] ' + arrow + ' ' + m.name + ': ' + m.text);
    }
    cursor += result.length;
    console.log('CURSOR=' + cursor);
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, POLL_MS));
}
console.log('NO_NEW_MESSAGES cursor=' + startCursor);
process.exit(0);
