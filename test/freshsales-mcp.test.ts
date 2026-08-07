import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { FreshsalesClient } from "../src/freshsales/client.js";
import { ApprovalStore } from "../src/state/approvalStore.js";
import { DailyUsageTracker } from "../src/state/dailyUsageTracker.js";
import type { FreshsalesClientLike } from "../src/freshsales/types.js";
import { listLeadsTool } from "../src/tools/listLeads.js";
import { runTool, type ToolExecutionContext } from "../src/tools/common.js";
import type { Logger } from "../src/types.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    freshsalesApiKey: "freshsales-secret",
    freshsalesDomain: "https://example.myfreshworks.com",
    defaultLeadsViewId: "lead-view",
    defaultDealsViewId: "deal-view",
    mcpServerToken: "mcp-secret",
    dailyCallLimit: 200,
    approvalTtlSeconds: 300,
    resetTimeZone: "UTC",
    allowedOrigins: [],
    allowedHosts: [],
    max429Retries: 1,
    maxRetryWaitMs: 2000,
    localRateLimitPerMinute: 60,
    pipelineSummaryMaxPages: 5,
    ...overrides
  };
}

function makeContext(options: {
  appConfig?: AppConfig;
  freshsales?: FreshsalesClientLike;
  now?: Date;
} = {}): ToolExecutionContext {
  const appConfig = options.appConfig ?? config();
  const now = options.now ?? new Date("2026-08-07T10:00:00.000Z");
  const usageTracker = new DailyUsageTracker(appConfig, now);

  return {
    config: appConfig,
    freshsales: options.freshsales ?? mockFreshsales().freshsales,
    approvalStore: new ApprovalStore(),
    usageTracker,
    logger,
    now: () => now
  };
}

function mockFreshsales() {
  const get = vi.fn(async <T>() => ({ leads: [] }) as T);
  const freshsales: FreshsalesClientLike = {
    get: get as unknown as FreshsalesClientLike["get"]
  };

  return {
    freshsales,
    get
  };
}

function requestIdFrom(result: Awaited<ReturnType<typeof runTool>>): string {
  const payload = result.payload as { request_id?: string };
  if (!payload.request_id) {
    throw new Error("Expected pending approval request_id.");
  }

  return payload.request_id;
}

describe("approval flow", () => {
  it("returns a pending approval preview without calling Freshsales", async () => {
    const { freshsales, get } = mockFreshsales();
    const ctx = makeContext({ freshsales });

    const result = await runTool(listLeadsTool, { page: 1, per_page: 25 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      status: "pending_approval",
      tool: "list_leads",
      will_call_freshsales: true,
      estimated_call_count: 1
    });
    expect(get).not.toHaveBeenCalled();
    expect(ctx.usageTracker.getSnapshot(ctx.now()).calls_used_today).toBe(0);
  });

  it("executes and increments usage only on approval", async () => {
    const appConfig = config();
    const now = new Date("2026-08-07T10:00:00.000Z");
    const usageTracker = new DailyUsageTracker(appConfig, now);
    const fetchImpl = vi.fn(async () => Response.json({ leads: [{ id: 1, first_name: "Ada", last_name: "Lovelace" }] }));
    const freshsales = new FreshsalesClient({ config: appConfig, usageTracker, logger, fetchImpl, now: () => now });
    const ctx: ToolExecutionContext = {
      config: appConfig,
      freshsales,
      approvalStore: new ApprovalStore(),
      usageTracker,
      logger,
      now: () => now
    };

    const propose = await runTool(listLeadsTool, { page: 1, per_page: 25 }, ctx);
    expect(ctx.usageTracker.getSnapshot(now).calls_used_today).toBe(0);

    const approve = await runTool(listLeadsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ctx.usageTracker.getSnapshot(now).calls_used_today).toBe(1);
  });

  it("rejects invalid parameters before any network call", async () => {
    const { freshsales, get } = mockFreshsales();
    const ctx = makeContext({ freshsales });

    const result = await runTool(listLeadsTool, { page: 1, per_page: 51 }, ctx);

    expect(result.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects expired request ids before any network call", async () => {
    let now = new Date("2026-08-07T10:00:00.000Z");
    const { freshsales, get } = mockFreshsales();
    const appConfig = config({ approvalTtlSeconds: 60 });
    const ctx = makeContext({ appConfig, freshsales, now });
    ctx.now = () => now;

    const propose = await runTool(listLeadsTool, { page: 1, per_page: 25 }, ctx);
    now = new Date("2026-08-07T10:01:01.000Z");
    const approve = await runTool(listLeadsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(true);
    expect(approve.payload).toMatchObject({ error: { code: "REQUEST_ID_EXPIRED" } });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("daily usage and Freshsales client", () => {
  it("allows call 200 and rejects call 201", () => {
    const appConfig = config({ dailyCallLimit: 200, localRateLimitPerMinute: 250 });
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));

    for (let count = 0; count < 200; count += 1) {
      tracker.recordCall(new Date("2026-08-07T10:00:00.000Z"));
    }

    expect(tracker.getSnapshot(new Date("2026-08-07T10:00:00.000Z")).calls_used_today).toBe(200);
    expect(() => tracker.recordCall(new Date("2026-08-07T10:00:00.000Z"))).toThrow("Daily Freshsales call limit reached");
  });

  it("resets at midnight in the configured timezone", () => {
    const appConfig = config({ resetTimeZone: "Asia/Kolkata" });
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T18:00:00.000Z"));
    tracker.recordCall(new Date("2026-08-07T18:00:00.000Z"));

    const afterMidnight = tracker.getSnapshot(new Date("2026-08-07T18:31:00.000Z"));

    expect(afterMidnight.calls_used_today).toBe(0);
  });

  it("checks daily capacity before an approved Freshsales call", async () => {
    const appConfig = config({ dailyCallLimit: 1 });
    const now = new Date("2026-08-07T10:00:00.000Z");
    const usageTracker = new DailyUsageTracker(appConfig, now);
    const fetchImpl = vi.fn(async () => Response.json({ leads: [] }));
    const freshsales = new FreshsalesClient({ config: appConfig, usageTracker, logger, fetchImpl, now: () => now });
    const ctx: ToolExecutionContext = {
      config: appConfig,
      freshsales,
      approvalStore: new ApprovalStore(),
      usageTracker,
      logger,
      now: () => now
    };

    const firstPropose = await runTool(listLeadsTool, { page: 1, per_page: 25 }, ctx);
    await runTool(listLeadsTool, { approved: true, request_id: requestIdFrom(firstPropose) }, ctx);
    const secondPropose = await runTool(listLeadsTool, { page: 1, per_page: 25 }, ctx);
    const secondApprove = await runTool(listLeadsTool, { approved: true, request_id: requestIdFrom(secondPropose) }, ctx);

    expect(secondApprove.isError).toBe(true);
    expect(secondApprove.payload).toMatchObject({ error: { code: "DAILY_LIMIT_REACHED" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("backs off once on Freshsales 429 responses", async () => {
    const appConfig = config({ max429Retries: 1 });
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "rate limited" }), { status: 429 }))
      .mockResolvedValueOnce(Response.json({ leads: [] }));
    const sleep = vi.fn(async () => undefined);
    const client = new FreshsalesClient({
      config: appConfig,
      usageTracker: tracker,
      logger,
      fetchImpl,
      sleep,
      now: () => new Date("2026-08-07T10:00:00.000Z")
    });

    await client.get("/api/leads/view/lead-view");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("redacts configured secrets from upstream error messages", async () => {
    const appConfig = config();
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ message: "failed with freshsales-secret and mcp-secret" }),
      { status: 500, headers: { "content-type": "application/json" } }
    ));
    const client = new FreshsalesClient({
      config: appConfig,
      usageTracker: tracker,
      logger,
      fetchImpl,
      now: () => new Date("2026-08-07T10:00:00.000Z")
    });

    await expect(client.get("/api/leads/view/lead-view")).rejects.toThrow("failed with [REDACTED] and [REDACTED]");
  });
});
