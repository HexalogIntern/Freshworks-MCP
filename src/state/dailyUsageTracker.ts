import { AsyncLocalStorage } from "node:async_hooks";

import type { AppConfig } from "../config.js";
import { AppError } from "../utils/errors.js";
import { computeNextReset } from "../utils/time.js";

export interface FreshsalesCallDetails {
  method?: string;
  path?: string;
}

export interface InvocationUsageSnapshot extends Record<string, unknown> {
  tool: string;
  freshsales_call_count: number;
  freshsales_calls: Array<{
    at: string;
    method: string | null;
    path: string | null;
  }>;
}

interface UsageSnapshot extends Record<string, unknown> {
  calls_used_today: number;
  daily_call_limit: number;
  calls_remaining: number;
  resets_at: string;
  calls_used_last_minute: number;
  local_rate_limit_per_minute: number;
  seconds_until_next_minute_slot: number | null;
  calls_by_tool_today: Array<{
    tool: string;
    calls: number;
  }>;
  recent_freshsales_calls: Array<{
    at: string;
    tool: string;
    method: string | null;
    path: string | null;
  }>;
  recent_tool_invocations: Array<{
    tool: string;
    status: "success" | "error";
    started_at: string;
    finished_at: string;
    freshsales_call_count: number;
    freshsales_calls: Array<{
      method: string | null;
      path: string | null;
      calls: number;
    }>;
  }>;
}

export class DailyUsageTracker {
  private callsUsedToday = 0;
  private resetAt: Date;
  private readonly callTimestamps: number[] = [];
  private readonly asyncLocalStorage = new AsyncLocalStorage<ActiveInvocation>();
  private readonly callsByToolToday = new Map<string, number>();
  private readonly recentFreshsalesCalls: FreshsalesCallEvent[] = [];
  private readonly recentToolInvocations: ToolInvocationEvent[] = [];

  public constructor(private readonly config: AppConfig, now: Date = new Date()) {
    this.resetAt = computeNextReset(now, config.resetTimeZone);
  }

  public getSnapshot(now: Date): UsageSnapshot {
    this.maybeReset(now);
    return {
      calls_used_today: this.callsUsedToday,
      daily_call_limit: this.config.dailyCallLimit,
      calls_remaining: Math.max(0, this.config.dailyCallLimit - this.callsUsedToday),
      resets_at: this.resetAt.toISOString(),
      calls_used_last_minute: this.callTimestamps.length,
      local_rate_limit_per_minute: this.config.localRateLimitPerMinute,
      seconds_until_next_minute_slot: this.secondsUntilNextMinuteSlot(now),
      calls_by_tool_today: Array.from(this.callsByToolToday.entries())
        .map(([tool, calls]) => ({ tool, calls }))
        .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
      recent_freshsales_calls: this.recentFreshsalesCalls.slice(-50),
      recent_tool_invocations: this.recentToolInvocations.slice(-25)
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

  public recordCall(now: Date, details: FreshsalesCallDetails = {}): void {
    this.maybeReset(now);
    this.pruneMinuteWindow(now);

    if (this.callTimestamps.length >= this.config.localRateLimitPerMinute) {
      const waitSeconds = this.secondsUntilNextMinuteSlot(now);
      throw new AppError(
        "LOCAL_RATE_LIMIT_REACHED",
        `Local safety cap reached: ${this.config.localRateLimitPerMinute} Freshsales calls per rolling minute.${waitSeconds ? ` Try again in about ${waitSeconds}s.` : ""}`,
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
    this.recordBreakdown(now, details);
  }

  public async trackInvocation<T>(
    tool: string,
    startedAt: Date,
    now: () => Date,
    callback: () => Promise<T>
  ): Promise<{ result: T; usage: InvocationUsageSnapshot }> {
    const invocation: ActiveInvocation = {
      tool,
      startedAt,
      calls: []
    };

    return this.asyncLocalStorage.run(invocation, async () => {
      try {
        const result = await callback();
        return { result, usage: this.finishInvocation(invocation, "success", now()) };
      } catch (error) {
        this.finishInvocation(invocation, "error", now());
        throw error;
      }
    });
  }

  private maybeReset(now: Date): void {
    if (now.getTime() >= this.resetAt.getTime()) {
      this.callsUsedToday = 0;
      this.callTimestamps.length = 0;
      this.callsByToolToday.clear();
      this.recentFreshsalesCalls.length = 0;
      this.recentToolInvocations.length = 0;
      this.resetAt = computeNextReset(now, this.config.resetTimeZone);
    }
  }

  private pruneMinuteWindow(now: Date): void {
    const cutoff = now.getTime() - 60_000;
    while (this.callTimestamps[0] !== undefined && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
  }

  private secondsUntilNextMinuteSlot(now: Date): number | null {
    this.pruneMinuteWindow(now);
    if (this.callTimestamps.length < this.config.localRateLimitPerMinute) {
      return null;
    }

    const first = this.callTimestamps[0];
    return first === undefined ? null : Math.max(1, Math.ceil((first + 60_000 - now.getTime()) / 1000));
  }

  private recordBreakdown(now: Date, details: FreshsalesCallDetails): void {
    const invocation = this.asyncLocalStorage.getStore();
    const tool = invocation?.tool ?? "unscoped";
    const event = {
      at: now.toISOString(),
      tool,
      method: details.method?.toUpperCase() ?? null,
      path: details.path ?? null
    };

    invocation?.calls.push(event);
    this.callsByToolToday.set(tool, (this.callsByToolToday.get(tool) ?? 0) + 1);
    this.recentFreshsalesCalls.push(event);
    if (this.recentFreshsalesCalls.length > 200) {
      this.recentFreshsalesCalls.splice(0, this.recentFreshsalesCalls.length - 200);
    }
  }

  private finishInvocation(
    invocation: ActiveInvocation,
    status: "success" | "error",
    finishedAt: Date
  ): InvocationUsageSnapshot {
    const usage = {
      tool: invocation.tool,
      freshsales_call_count: invocation.calls.length,
      freshsales_calls: invocation.calls.map(call => ({
        at: call.at,
        method: call.method,
        path: call.path
      }))
    };

    this.recentToolInvocations.push({
      tool: invocation.tool,
      status,
      started_at: invocation.startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      freshsales_call_count: invocation.calls.length,
      freshsales_calls: summarizeCalls(invocation.calls)
    });
    if (this.recentToolInvocations.length > 100) {
      this.recentToolInvocations.splice(0, this.recentToolInvocations.length - 100);
    }

    return usage;
  }
}

interface FreshsalesCallEvent {
  at: string;
  tool: string;
  method: string | null;
  path: string | null;
}

interface ActiveInvocation {
  tool: string;
  startedAt: Date;
  calls: FreshsalesCallEvent[];
}

interface ToolInvocationEvent {
  tool: string;
  status: "success" | "error";
  started_at: string;
  finished_at: string;
  freshsales_call_count: number;
  freshsales_calls: Array<{
    method: string | null;
    path: string | null;
    calls: number;
  }>;
}

function summarizeCalls(calls: FreshsalesCallEvent[]): ToolInvocationEvent["freshsales_calls"] {
  const counts = new Map<string, {
    method: string | null;
    path: string | null;
    calls: number;
  }>();

  for (const call of calls) {
    const key = `${call.method ?? ""} ${call.path ?? ""}`;
    const current = counts.get(key) ?? { method: call.method, path: call.path, calls: 0 };
    current.calls += 1;
    counts.set(key, current);
  }

  return Array.from(counts.values());
}
