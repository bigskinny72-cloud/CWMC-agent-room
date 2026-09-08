import type { RoomReport } from '@agent-room/shared';
import type { ReportStore } from '@agent-room/persistence';

import type { UpstashClient } from './client.js';

const REPORT_TTL_SECONDS = 24 * 60 * 60;

function reportKey(code: string): string {
  return `room-report:${code}`;
}

export function createUpstashReportStore(
  client: UpstashClient,
): ReportStore {
  return {
    async saveReport(
      code: string,
      report: RoomReport,
    ): Promise<void> {
      await client.command([
        'SET',
        reportKey(code),
        JSON.stringify(report),
        'EX',
        REPORT_TTL_SECONDS,
      ]);
    },

    async getReport(
      code: string,
    ): Promise<RoomReport | null> {
      const raw = await client.command<string | null>([
        'GET',
        reportKey(code),
      ]);

      return raw
        ? JSON.parse(raw) as RoomReport
        : null;
    },

    async clearReport(
      code: string,
    ): Promise<void> {
      await client.command([
        'DEL',
        reportKey(code),
      ]);
    },
  };
}
