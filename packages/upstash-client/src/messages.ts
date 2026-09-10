import type { Message, MessageMetadata, RoleInTurn, InvocationType } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import type { PersistenceStores } from '@agent-room/persistence';
import { createUpstashPersistenceStores } from './persistenceStores.js';
import { findSpeaker, MutedError, NotYourTurnError, getRoomWithStores } from './rooms.js';
import type { TurnSpokenEntry } from './turnState.js';
import {
  advanceOnTimeout,
  advanceTurn,
  applyGraceSupplementReply,
  canAgentSpeakNow,
  casTurnStateWithStores,
  consumeHostDirectedDetailed,
  isGraceSupplementSpeaker,
  isHumanSender,
  moderatorReply,
  newModeratorTurn,
  newSequentialTurn,
  renewTurnDeadline,
  shouldStartNewTurn,
  skipQueueHead,
} from './turnState.js';

// Tracks the absolute count of messages ever appended to this room. Used by
// listMessages to translate an agent's logical cursor (= "I've consumed N
// messages so far") into the right LRANGE start position even after LTRIM has
// dropped the oldest entries. Without this, once the list crosses
// MAX_MESSAGES_PER_ROOM the index stored in the cursor stops mapping to the
// list slot the agent thinks it does, and agents silently MISS messages
// (witnessed: 499 in list, +2 RPUSH, LTRIM keeps last 500 → first new
// message is now at index 498, but cursor=499 LRANGEs from 499 and only
// returns the second new message). The counter key is INCRed in the same
// pipeline as RPUSH/LTRIM so it can never drift relative to the list.

/** Next poll cursor after a full `listMessages(..., 0)` when the room has a counter key; `null` = legacy room. */
export async function getMessageTotalCountWithStores(
  stores: PersistenceStores,
  code: string,
): Promise<number | null> {
  return stores.messages.getMessageTotalCount(code);
}

export async function getMessageTotalCount(
  client: UpstashClient,
  code: string,
): Promise<number | null> {
  return getMessageTotalCountWithStores(
    createUpstashPersistenceStores(client),
    code,
  );
}

// Supplement-skip token. A supplement agent that has nothing to add MUST
// emit this exact string (after trim) — appendMessage detects it, advances
// the turn with status='no_addition', and does NOT append a message to the
// chat. Slice B does exact-match only; fuzzy matching ("无补充", "Nothing
// to add", etc.) is deferred to a later iteration once we have real prompt
// outputs to calibrate against.
export const NO_ADDITION_TOKEN = '__no_addition__';

// Result of a successful appendMessage call. `appended` is true for normal
// chat messages (the message ended up in the list); false for messages
// that were absorbed by the turn machinery (the supplement-skip token, or
// any future "swallowed" case). Callers like the MCP room_send handler use
// this to decide what hint to send back to the agent.
export interface AppendResult {
  appended: boolean;
  reason?: 'no_addition';
  // The metadata that ended up on the message (or, in the no_addition
  // case, the metadata that WOULD have been attached). Useful for
  // surfacing roleAtSend/turnId in the tool response.
  metadata: MessageMetadata;
  // Sequential lead-grace path: when a queue-head supplement preempts the
  // Lead, the Lead is logged as skipped_by_grace inside the CAS mutator.
  // We surface that entry here so the MCP layer can post a sys message
  // explaining the skip (mirrors how advanceOnTimeout's skipped[] flows
  // to emitTimeoutSysMessage).
  leadSkipped?: TurnSpokenEntry;
}

// Append a message. Server-side gates, in order:
//   1. Mute gate: (name, client) must be a non-muted participant. Throws
//      MutedError otherwise.
//   2. Turn gate (sequential/moderator modes only): the sender must be the
//      current turn-holder, OR a human (web client / host), OR present in
//      the host-directed one-shot allowlist. Throws NotYourTurnError
//      otherwise.
//
// Side effects on success:
//   - Sequential mode: a human message kicks off a new turn if none is
//     active; an agent message advances the turn cursor. Lazy timeout
//     check runs first, silently skipping past expired speakers (callers
//     that want sys messages for those skips watch via the listen poll).
//   - Message metadata is enriched with modeAtSend / roleAtSend / turnId
//     / invocationType. Callers that pre-set message.metadata fields keep
//     them — server-side fields are merged in, server wins on conflict.
//   - Supplement-skip token (`__no_addition__`) advances the turn WITHOUT
//     appending a chat message; returns { appended: false, reason: 'no_addition' }.
//   - `kind: 'status'` (from room_status) posts a status-tagged message that
//     never advances the turn. In sequential mode, when the sender is the
//     current speaker, it also renews their turn deadline (heartbeat) — a
//     long-running agent can signal "still working" without losing the floor.
export async function appendMessageWithStores(
  stores: PersistenceStores,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<AppendResult> {
  const room = await getRoomWithStores(stores, code);
  if (!findSpeaker(room, message.name, message.client)) {
    throw new MutedError(message.name, room.createdBy);
  }
  const mode = room.replyMode ?? 'open';

  // Fast path: open mode — and the orchestrated modes (consensus / debate),
  // which are driven entirely server-side by a multi-round runner rather than
  // by the turn machinery. They post via appendDemoAgentMessage with no floor
  // to wait for, exactly like open mode, so they take the same gating-free path.
  if (mode === 'open' || mode === 'consensus' || mode === 'debate') {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: 'open',
      invocationType: message.metadata?.invocationType ?? 'normal_turn',
    };
    const enriched: Message = { ...message, metadata };
    await rpushMessageWithStores(stores, code, enriched, room.createdAt);
    return { appended: true, metadata };
  }

  // SQLite can provide a cross-store transaction boundary. Re-enter once
  // without that capability so the existing turn/message logic runs unchanged
  // inside one transaction; Redis/Upstash keeps the existing path.
  if (stores.runInTransaction) {
    const { runInTransaction, ...transactionStores } = stores;
    return runInTransaction(() =>
      appendMessageWithStores(transactionStores, code, message, kind),
    );
  }

  // Non-open mode: validate and advance turn state atomically.
  // `casTurnState`'s mutator is synchronous and may throw NotYourTurnError
  // to reject — casTurnState re-throws non-Concurrency errors, which we
  // propagate up to the caller (MCP room_send turns this into
  // sent=false/not_your_turn).
  const text = message.text ?? '';
  const isSupplementSkipToken = text.trim() === NO_ADDITION_TOKEN;
  const decision: {
    roleAtSend: RoleInTurn;
    invocationType: InvocationType;
    turnId?: number;
    skipMessage: boolean;
    leadSkipped?: TurnSpokenEntry;
    extendsTurn?: boolean;
  } = {
    roleAtSend: 'open',
    invocationType: 'normal_turn',
    skipMessage: false,
  };

  await casTurnStateWithStores(stores, code, (prev) => {
    // Reset per-attempt decision state so a CAS retry doesn't carry over
    // leadSkipped / extendsTurn from a stale earlier attempt.
    decision.leadSkipped = undefined;
    decision.extendsTurn = false;
    // Lazy cleanup: skip any expired speakers before evaluating this
    // sender. Skipped sys messages are emitted by the listen poll, not
    // here — appendMessage is on the hot path and must not RPUSH a sys
    // event from inside a CAS mutator. We *do* update state.spoken so
    // the listen poll sees the skips and can emit the appropriate
    // events.
    const after = advanceOnTimeout(prev, room);
    let cur = after.state;
    const now = Date.now();

    if (isHumanSender(room, message.name, message.client)) {
      // Humans (web client or the host) are never turn-gated. If a new
      // turn should start, kick one off — sequential and moderator
      // modes each have their own initial-state shape.
      if (shouldStartNewTurn(cur, room)) {
        if (mode === 'sequential') {
          cur = newSequentialTurn(room, message.id);
        } else if (mode === 'moderator') {
          cur = newModeratorTurn(room, message.id);
          // Moderator mode requires a configured Moderator who is
          // currently present in the room. If we couldn't pick one,
          // newModeratorTurn returns null — the human message stands
          // alone and no agent is expected to reply. (The room remains
          // in moderator mode; sweepTimeouts will eventually auto-
          // fallback to open if this stays broken.)
        }
      }
      decision.roleAtSend = 'human';
      decision.invocationType = 'normal_turn';
      decision.turnId = cur?.turnId;
      return cur;
    }

    // cc agent (not the host) — must be the current speaker, or the
    // grace-eligible queue-head supplement, or in the host-directed
    // allowlist.
    if (cur && canAgentSpeakNow(cur, message.name, message.client, now)) {
      const isGrace = isGraceSupplementSpeaker(cur, message.name, message.client, now);
      const role: RoleInTurn = isGrace ? 'supplement' : cur.currentRole!;
      const turnId = cur.turnId;
      // room_status heartbeat: a status ping is posted as a status-tagged
      // message and never advances the turn. When the sender is the actual
      // current speaker in sequential mode, it also renews their deadline
      // (extendsTurn) — that is the "still working" heartbeat. A grace-
      // eligible queue-head supplement, or a moderator, just posts a side
      // note with no turn-state change.
      if (kind === 'status') {
        decision.roleAtSend = 'status';
        decision.invocationType = 'status_update';
        decision.turnId = turnId;
        if (!isGrace && cur.mode === 'sequential') {
          decision.extendsTurn = true;
          return renewTurnDeadline(cur, now);
        }
        return cur;
      }
      decision.roleAtSend = role;
      decision.invocationType = 'normal_turn';
      decision.turnId = turnId;
      // Supplement-skip token: advance with status='no_addition', do NOT
      // append a chat message. During lead grace we treat this as the
      // supplement bowing out (drop from queue, lead keeps the floor),
      // NOT as a preemption — opting out is a soft signal, not a claim
      // on the mic.
      if (isSupplementSkipToken) {
        decision.skipMessage = true;
        if (isGrace) {
          return skipQueueHead(cur, 'no_addition', now);
        }
        return advanceTurn(cur, 'no_addition', room, now);
      }
      // Moderator mode: Moderator-as-current keeps current after reply
      // (no queue pop). They route via room_direct_invoke; their
      // deadline resets each time they actually post a message.
      if (cur.mode === 'moderator' && role === 'moderator') {
        return moderatorReply(cur, room, now);
      }
      // Grace path: queue-head supplement preempts Lead. Log the Lead
      // as skipped_by_grace and surface that entry so the caller can
      // post a sys message.
      if (isGrace) {
        const result = applyGraceSupplementReply(
          cur, message.name, message.client, room, now,
        );
        decision.leadSkipped = result.leadSkipped;
        return result.state;
      }
      return advanceTurn(cur, 'replied', room, now);
    }
    if (cur) {
      const directed = consumeHostDirectedDetailed(cur, message.name, message.client);
      if (directed.consumed) {
        // Moderator dispatch ('assignee') vs host override
        // ('host_directed') are tracked separately for reporting.
        decision.roleAtSend = directed.source === 'moderator' ? 'assignee' : 'host_directed';
        decision.invocationType = directed.source === 'moderator' ? 'moderator_assigned' : 'host_directed';
        decision.turnId = cur.turnId;
        // Directed messages don't consume the main turn queue slot —
        // the named current speaker stays current. The mutated
        // hostDirected list (one entry popped) is what gets persisted.
        return cur;
      }
    }
    // Moderator mode: a non-moderator cc agent that is neither the current
    // speaker nor a directly-invoked assignee may still post a *status
    // update* — a short "received / on it / done" signal back to the
    // Moderator. It is always allowed, never consumes the Moderator's
    // floor, and does NOT mutate turn state (queue / current / deadline
    // are untouched). Substantive analysis or challenge still requires a
    // Moderator @-invoke — that flows through the consumeHostDirected path
    // above. The message is appended normally, tagged roleAtSend='status'
    // / invocationType='status_update' so the UI and reports can render it
    // as a status ping rather than a turn reply.
    if (mode === 'moderator') {
      decision.roleAtSend = 'status';
      decision.invocationType = 'status_update';
      decision.turnId = cur?.turnId;
      // Return turn state unchanged — a status update is a side channel.
      return cur;
    }
    throw new NotYourTurnError(message.name, mode);
  });

  if (decision.skipMessage) {
    const metadata: MessageMetadata = {
      ...(message.metadata ?? {}),
      modeAtSend: mode,
      roleAtSend: decision.roleAtSend,
      invocationType: decision.invocationType,
      ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    };
    return {
      appended: false,
      reason: 'no_addition',
      metadata,
      ...(decision.leadSkipped ? { leadSkipped: decision.leadSkipped } : {}),
    };
  }

  const metadata: MessageMetadata = {
    ...(message.metadata ?? {}),
    modeAtSend: mode,
    roleAtSend: decision.roleAtSend,
    invocationType: decision.invocationType,
    ...(decision.turnId !== undefined ? { turnId: decision.turnId } : {}),
    ...(decision.extendsTurn ? { extendsTurn: true } : {}),
  };
  const enriched: Message = { ...message, metadata };
  await rpushMessageWithStores(stores, code, enriched, room.createdAt);
  return {
    appended: true,
    metadata,
    ...(decision.leadSkipped ? { leadSkipped: decision.leadSkipped } : {}),
  };
}

export async function appendMessage(
  client: UpstashClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<AppendResult> {
  return appendMessageWithStores(
    createUpstashPersistenceStores(client),
    code,
    message,
    kind,
  );
}
// Internal helper: write a message to the Redis list, pinning TTL to the
// room's hard 24h deadline and keeping the absolute-count counter in lockstep.
// INCR on the count key MUST sit in the same pipeline as RPUSH so the count
// stays in lock-step with the list — listMessages relies on the invariant
// `totalCount - listLen = number of LTRIMmed entries` to compensate cursors.
// EXPIREAT (a fixed creation+TTL deadline) rather than EXPIRE means the
// message list dies exactly when the room does, instead of sliding forward.
async function rpushMessageWithStores(
  stores: PersistenceStores,
  code: string,
  message: Message,
  roomCreatedAt: number,
): Promise<void> {
  await stores.messages.appendMessage(
    code,
    message,
    roomCreatedAt,
  );
}
// Append a server-originated system message. Bypasses the speaker/mute/turn
// gates because system messages are not sent by a participant — they are
// emitted by the server itself in response to events like mode changes,
// turn timeouts, host-driven skips, or moderator fallbacks. Callers should
// set `message.type = 'sys'` and use a synthetic sender (typically
// `name: 'system'`, `client: 'cc'`). The room must still exist; we hit
// getRoom() to refresh TTL and keep the count key aligned with the list.
export async function appendSystemMessageWithStores(
  stores: PersistenceStores,
  code: string,
  message: Message
): Promise<void> {
  const room = await getRoomWithStores(stores, code);
  await rpushMessageWithStores(stores, code, message, room.createdAt);
}

export async function appendSystemMessage(
  client: UpstashClient,
  code: string,
  message: Message
): Promise<void> {
  return appendSystemMessageWithStores(
    createUpstashPersistenceStores(client),
    code,
    message,
  );
}

// Cursor semantics: `fromIndex` is the absolute count of messages the caller
// has already consumed (0 on first call, advanced by `msgs.length` after
// each call). It is NOT a list-index — the on-disk list shifts whenever
// LTRIM trims the head, so a list-index cursor would skip messages past
// MAX_MESSAGES_PER_ROOM. The counter key + LLEN let us reconstruct where the
// caller's next unread message actually lives in the (possibly trimmed) list.
export async function readMessagesWithStores(
  stores: PersistenceStores,
  code: string,
  fromIndex: number,
): Promise<{ messages: Message[]; cursor: number }> {
  if (stores.messages.readMessages) {
    return stores.messages.readMessages(code, fromIndex);
  }
  const messages = await stores.messages.listMessages(code, fromIndex);
  return { messages, cursor: fromIndex + messages.length };
}

export async function listMessagesWithStores(
  stores: PersistenceStores,
  code: string,
  fromIndex: number,
): Promise<Message[]> {
  return (await readMessagesWithStores(stores, code, fromIndex)).messages;
}

export async function listMessages(
  client: UpstashClient,
  code: string,
  fromIndex: number,
): Promise<Message[]> {
  return listMessagesWithStores(
    createUpstashPersistenceStores(client),
    code,
    fromIndex,
  );
}


