import type { Meter } from "@osr/core";

export interface UsageRecord {
  sandboxId: string;
  tenant: string;
  provider: string;
  op: string;
  durationMs: number;
  estUsdPerHour?: number;
  ok: boolean;
  at: string;
}

/**
 * In-memory metering sink. A production gateway writes these to Postgres and reconciles
 * the normalized estimate against provider billing where their APIs allow.
 */
export class InMemoryMeter implements Meter {
  private readonly records: UsageRecord[] = [];

  record(event: Omit<UsageRecord, "at">): void {
    this.records.push({ ...event, at: new Date().toISOString() });
  }

  all(): UsageRecord[] {
    return [...this.records];
  }

  summary(): { totalOps: number; byProvider: Record<string, number> } {
    const byProvider: Record<string, number> = {};
    for (const r of this.records) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
    return { totalOps: this.records.length, byProvider };
  }
}
