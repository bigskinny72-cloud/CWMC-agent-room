import type { TurnState } from '@agent-room/shared';
import type { TurnStateStore } from '@agent-room/persistence';
import type { UpstashClient } from './client.js';
import {
  getTurnState,
  setTurnState,
  clearTurnState,
  casTurnState,
} from './turnState.js';

export function createUpstashTurnStateStore(
  client: UpstashClient
): TurnStateStore {
  return {
    getTurnState(code: string): Promise<TurnState | null> {
      return getTurnState(client, code);
    },

    setTurnState(code: string, state: TurnState): Promise<void> {
      return setTurnState(client, code, state);
    },

    clearTurnState(code: string): Promise<void> {
      return clearTurnState(client, code);
    },

    mutateTurnState(
      code: string,
      mutator: (current: TurnState | null) => TurnState | null
    ): Promise<TurnState | null> {
      return casTurnState(client, code, mutator);
    },
  };
}
