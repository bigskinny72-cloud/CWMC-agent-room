import type { RoomReport } from '@agent-room/shared';

/**
 * Backend-neutral report storage.
 *
 * Report construction and task-board/report business logic remain
 * outside this interface.
 *
 * Reports have their own retention lifetime independent of room lifetime.
 */
export interface ReportStore {
  saveReport(
    code: string,
    report: RoomReport,
  ): Promise<void>;

  getReport(
    code: string,
  ): Promise<RoomReport | null>;

  clearReport(
    code: string,
  ): Promise<void>;
}
