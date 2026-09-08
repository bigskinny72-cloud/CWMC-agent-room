import type { TurnState } from '@agent-room/shared';
import type { TurnStateStore } from '@agent-room/persistence';
import {
  getStoredTurnState,
  setStoredTurnState,
  clearStoredTurnState,
  mutateStoredTurnState,
} from './turnState.js';

export function createSqliteTurnStateStore(): TurnStateStore {
  return {
    async getTurnState(code: string): Promise<TurnState | null> {
      return getStoredTurnState<TurnState>(code);
    },

    async setTurnState(code: string, state: TurnState): Promise<void> {
      setStoredTurnState(code, state);
    },

    async clearTurnState(code: string): Promise<void> {
      clearStoredTurnState(code);
    },

    async mutateTurnState(
      code: string,
      mutator: (current: TurnState | null) => TurnState | null
    ): Promise<TurnState | null> {
      return mutateStoredTurnState<TurnState>(code, mutator);
    },
  };
}
