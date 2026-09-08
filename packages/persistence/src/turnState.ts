import type { TurnState } from '@agent-room/shared';

/**
 * Backend-neutral persistence operations for turn state.
 *
 * Turn-state business rules stay outside this interface.
 * Implementations provide durable get/set/clear plus transactional mutation.
 */
export interface TurnStateStore {
  getTurnState(code: string): Promise<TurnState | null>;

  setTurnState(code: string, state: TurnState): Promise<void>;

  clearTurnState(code: string): Promise<void>;

  mutateTurnState(
    code: string,
    mutator: (current: TurnState | null) => TurnState | null
  ): Promise<TurnState | null>;
}
