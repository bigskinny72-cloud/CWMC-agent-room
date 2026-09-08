import type { RoomReport } from '@agent-room/shared';
import type { ReportStore } from '@agent-room/persistence';

import {
  saveStoredRoomReport,
  getStoredRoomReport,
  clearStoredRoomReport,
} from './reports.js';

export function createSqliteReportStore(): ReportStore {
  return {
    async saveReport(
      code: string,
      report: RoomReport,
    ): Promise<void> {
      saveStoredRoomReport(code, report);
    },

    async getReport(
      code: string,
    ): Promise<RoomReport | null> {
      return getStoredRoomReport(code);
    },

    async clearReport(
      code: string,
    ): Promise<void> {
      clearStoredRoomReport(code);
    },
  };
}
