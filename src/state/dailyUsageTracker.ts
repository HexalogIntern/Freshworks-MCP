import type { AppConfig } from "../config.js";
import { AppError } from "../utils/errors.js";
import { computeNextReset } from "../utils/time.js";

interface UsageSnapshot extends Record<string, unknown> {
  calls_used_today: number;
  daily_call_limit: number;
  calls_remaining: number;
  resets_at: string;
}

export class DailyUsageTracker {
  private callsUsedToday = 0;
  private resetAt: Date;
  private readonly callTimestamps: number[] = [];

  public constructor(private readonly config: AppConfig, now: Date = new Date()) {
    this.resetAt = computeNextReset(now, config.resetTimeZone);
  }

  public getSnapshot(now: Date): UsageSnapshot {
    this.maybeReset(now);
    return {
      calls_used_today: this.callsUsedToday,
      daily_call_limit: this.config.dailyCallLimit,
      calls_remaining: Math.max(0, this.config.dailyCallLimit - this.callsUsedToday),
      resets_at: this.resetAt.toISOString()
    };
  }

  public ensureCapacity(estimatedCalls: number, now: Date): void {
    this.maybeReset(now);
    if (this.callsUsedToday + estimatedCalls > this.config.dailyCallLimit) {
      throw new AppError(
        "DAILY_LIMIT_REACHED",
        `Daily Freshsales call limit reached. Limit: ${this.config.dailyCallLimit}. Reset at ${this.resetAt.toISOString()}.`,
        429
      );
    }
  }

  public recordCall(now: Date): void {
    this.maybeReset(now);
    this.pruneMinuteWindow(now);

    if (this.callTimestamps.length >= this.config.localRateLimitPerMinute) {
      throw new AppError(
        "LOCAL_RATE_LIMIT_REACHED",
        `Local safety cap reached: ${this.config.localRateLimitPerMinute} Freshsales calls per minute.`,
        429
      );
    }

    if (this.callsUsedToday >= this.config.dailyCallLimit) {
      throw new AppError(
        "DAILY_LIMIT_REACHED",
        `Daily Freshsales call limit reached. Limit: ${this.config.dailyCallLimit}. Reset at ${this.resetAt.toISOString()}.`,
        429
      );
    }

    this.callsUsedToday += 1;
    this.callTimestamps.push(now.getTime());
  }

  private maybeReset(now: Date): void {
    if (now.getTime() >= this.resetAt.getTime()) {
      this.callsUsedToday = 0;
      this.callTimestamps.length = 0;
      this.resetAt = computeNextReset(now, this.config.resetTimeZone);
    }
  }

  private pruneMinuteWindow(now: Date): void {
    const cutoff = now.getTime() - 60_000;
    while (this.callTimestamps[0] !== undefined && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
  }
}
