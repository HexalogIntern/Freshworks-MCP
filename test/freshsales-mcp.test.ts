import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { clearFieldSchemaCache } from "../src/freshsales/fieldSchema.js";
import { FreshsalesClient } from "../src/freshsales/client.js";
import { ApprovalStore } from "../src/state/approvalStore.js";
import { DailyUsageTracker } from "../src/state/dailyUsageTracker.js";
import type { FreshsalesClientLike } from "../src/freshsales/types.js";
import { getContactTool } from "../src/tools/getContact.js";
import { listContactsTool } from "../src/tools/listContacts.js";
import { listDealsTool } from "../src/tools/listDeals.js";
import { searchContactsTool } from "../src/tools/searchContacts.js";
import { runTool, type ToolExecutionContext } from "../src/tools/common.js";
import type { Logger } from "../src/types.js";
import { AppError, redactKnownSecrets } from "../src/utils/errors.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

beforeEach(() => {
  vi.clearAllMocks();
  clearFieldSchemaCache();
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    freshsalesApiKey: "freshsales-secret",
    freshsalesDomain: "https://example.myfreshworks.com",
    defaultContactsViewId: "contact-view",
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
    fieldSchemaCacheTtlMs: 3600000,
    freshsalesRequestTimeoutMs: 10000,
    mcpRequestTimeoutMs: 25000,
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
  const get = vi.fn(async <T>(path: string) => {
    if (path === "api/settings/contacts/fields") {
      return { fields: [{ name: "id", label: "ID" }, { name: "display_name", label: "Name" }] } as T;
    }

    if (path === "api/settings/deals/fields") {
      return { fields: [{ name: "id", label: "ID" }, { name: "name", label: "Name" }] } as T;
    }

    return { contacts: [] } as T;
  });
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

    const result = await runTool(listContactsTool, { page: 1, per_page: 25 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      status: "pending_approval",
      tool: "list_contacts",
      will_call_freshsales: true,
      estimated_call_count: 2
    });
    expect(get).not.toHaveBeenCalled();
    expect(ctx.usageTracker.getSnapshot(ctx.now()).calls_used_today).toBe(0);
  });

  it("executes and increments usage only on approval", async () => {
    const appConfig = config();
    const now = new Date("2026-08-07T10:00:00.000Z");
    const usageTracker = new DailyUsageTracker(appConfig, now);
    const fetchImpl = vi.fn(async (url: URL) => {
      return url.toString().includes("api/settings/contacts/fields")
        ? Response.json({ fields: [{ name: "id", label: "ID" }, { name: "display_name", label: "Name" }] })
        : Response.json({ contacts: [{ id: 1, first_name: "Ada", last_name: "Lovelace" }] });
    });
    const freshsales = new FreshsalesClient({ config: appConfig, usageTracker, logger, fetchImpl, now: () => now });
    const ctx: ToolExecutionContext = {
      config: appConfig,
      freshsales,
      approvalStore: new ApprovalStore(),
      usageTracker,
      logger,
      now: () => now
    };

    const propose = await runTool(listContactsTool, { page: 1, per_page: 25 }, ctx);
    expect(ctx.usageTracker.getSnapshot(now).calls_used_today).toBe(0);

    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ctx.usageTracker.getSnapshot(now).calls_used_today).toBe(2);
  });

  it("rejects invalid parameters before any network call", async () => {
    const { freshsales, get } = mockFreshsales();
    const ctx = makeContext({ freshsales });

    const result = await runTool(listContactsTool, { page: 1, per_page: 51 }, ctx);

    expect(result.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects expired request ids before any network call", async () => {
    let now = new Date("2026-08-07T10:00:00.000Z");
    const { freshsales, get } = mockFreshsales();
    const appConfig = config({ approvalTtlSeconds: 60 });
    const ctx = makeContext({ appConfig, freshsales, now });
    ctx.now = () => now;

    const propose = await runTool(listContactsTool, { page: 1, per_page: 25 }, ctx);
    now = new Date("2026-08-07T10:01:01.000Z");
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

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
    const appConfig = config({ dailyCallLimit: 2 });
    const now = new Date("2026-08-07T10:00:00.000Z");
    const usageTracker = new DailyUsageTracker(appConfig, now);
    const fetchImpl = vi.fn(async (url: URL) => {
      return url.toString().includes("api/settings/contacts/fields")
        ? Response.json({ fields: [{ name: "id", label: "ID" }, { name: "display_name", label: "Name" }] })
        : Response.json({ contacts: [] });
    });
    const freshsales = new FreshsalesClient({ config: appConfig, usageTracker, logger, fetchImpl, now: () => now });
    const ctx: ToolExecutionContext = {
      config: appConfig,
      freshsales,
      approvalStore: new ApprovalStore(),
      usageTracker,
      logger,
      now: () => now
    };

    const firstPropose = await runTool(listContactsTool, { page: 1, per_page: 25 }, ctx);
    await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(firstPropose) }, ctx);
    const secondPropose = await runTool(listContactsTool, { page: 1, per_page: 25 }, ctx);
    const secondApprove = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(secondPropose) }, ctx);

    expect(secondApprove.isError).toBe(true);
    expect(secondApprove.payload).toMatchObject({ error: { code: "DAILY_LIMIT_REACHED" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  it("appends API paths to Freshsales domains that include /crm/sales", async () => {
    const appConfig = config({ freshsalesDomain: "https://x.myfreshworks.com/crm/sales" });
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: URL) => {
      capturedUrl = url.toString();
      return Response.json({ deal: { id: 1 } });
    });
    const client = new FreshsalesClient({
      config: appConfig,
      usageTracker: tracker,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-08-07T10:00:00.000Z")
    });

    await client.get("api/deals/1");

    expect(capturedUrl).toBe("https://x.myfreshworks.com/crm/sales/api/deals/1");
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

  it("handles Freshsales error messages returned as arrays", async () => {
    const appConfig = config();
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ errors: { code: 403, message: ["You are not authorized to perform this operation."] } }),
      { status: 403, headers: { "content-type": "application/json" } }
    ));
    const client = new FreshsalesClient({
      config: appConfig,
      usageTracker: tracker,
      logger,
      fetchImpl,
      now: () => new Date("2026-08-07T10:00:00.000Z")
    });

    await expect(client.get("/api/leads/view/lead-view")).rejects.toMatchObject({
      code: "AUTH_FAILED",
      status: 403,
      message: "Freshsales authentication failed. Check the server-side credentials."
    });
  });

  it("rejects 2xx non-JSON upstream responses with a clear AppError", async () => {
    const appConfig = config();
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));
    const fetchImpl = vi.fn(async () => new Response(
      "<!doctype html><title>Login</title><p>freshsales-secret</p>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
    ));
    const client = new FreshsalesClient({
      config: appConfig,
      usageTracker: tracker,
      logger,
      fetchImpl,
      now: () => new Date("2026-08-07T10:00:00.000Z")
    });

    await expect(client.get("/api/leads/view/lead-view")).rejects.toMatchObject({
      code: "UPSTREAM_NON_JSON",
      status: 200,
      message: "Freshsales returned a non-JSON response (likely an auth redirect or wrong FRESHSALES_DOMAIN) instead of API data."
    });
    expect(logger.warn).toHaveBeenCalledWith("freshsales_non_json_response", {
      upstream_status: 200,
      upstream_content_type: "text/html; charset=utf-8",
      upstream_body_snippet: "<!doctype html><title>Login</title><p>[REDACTED]</p>"
    });
  });

  it("times out instead of hanging forever when the upstream connection stalls", async () => {
    const appConfig = config({ freshsalesRequestTimeoutMs: 50 });
    const tracker = new DailyUsageTracker(appConfig, new Date("2026-08-07T10:00:00.000Z"));
    // Mirrors real fetch/undici behavior: the network call never resolves
    // on its own (simulating a stuck upstream), but it does honor AbortSignal.
    const fetchImpl = vi.fn(
      (_url: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    const client = new FreshsalesClient({
      config: appConfig,
      usageTracker: tracker,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-08-07T10:00:00.000Z")
    });

    await expect(client.get("/api/leads/1")).rejects.toMatchObject({
      code: "FRESHSALES_TIMEOUT",
      status: 504
    });
  });
});

describe("error utilities", () => {
  it("does not throw when redacting a non-string value", () => {
    expect(redactKnownSecrets(["freshsales-secret", "visible"], config())).toBe("[REDACTED],visible");
  });
});

describe("contact tools", () => {
  it("fetches one contact with owner and custom fields after approval", async () => {
    const get = vi.fn(async <T>() => ({
      contact: {
        id: 10,
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        owner: { first_name: "Grace", last_name: "Hopper" },
        status_name: "Qualified",
        tags: [{ name: "Decision maker" }],
        job_title: "Founder",
        sales_account: { id: 99, name: "Analytical Engines" },
        mobile_number: "+15550101",
        work_number: "+15550102",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
        custom_field: { source: "Paid_meta" }
      }
    }) as T);
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(getContactTool, { id: "10" }, ctx);
    const approve = await runTool(getContactTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(get).toHaveBeenCalledWith("api/contacts/10", { query: { include: "owner,sales_account" } });
    expect(approve.payload).toMatchObject({
      data: {
        id: 10,
        name: "Ada Lovelace",
        email: "ada@example.com",
        status: "Qualified",
        tags: ["Decision maker"],
        owner: "Grace Hopper",
        job_title: "Founder",
        account: "Analytical Engines",
        company: "Analytical Engines",
        mobile_number: "+15550101",
        work_number: "+15550102",
        custom_field: { source: "Paid_meta" }
      }
    });
  });

  it("lists contacts and filters source across defensive field variants", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/settings/contacts/fields") {
        return {
          fields: [
            { name: "id", label: "ID" },
            { name: "display_name", label: "Name" },
            { name: "email", label: "Email" },
            { name: "cf_paid_meta", label: "Paid meta" }
          ]
        } as T;
      }

      return {
        contacts: [
          {
            id: 1,
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@example.com",
            owner: { first_name: "Grace", last_name: "Hopper" },
            status: "Won",
            tags: [{ name: "Decision maker" }, { name: "Champion" }],
            sales_account: { id: 99, name: "Analytical Engines" },
            custom_field: { source: "Paid_meta", cf_paid_meta: "yes" }
          },
          {
            id: 2,
            first_name: "Katherine",
            last_name: "Johnson",
            email: "katherine@example.com",
            owner_id: "42",
            lifecycle_stage: { name: "Qualified" },
            tags: ["Influencer"],
            sales_account_name: "NASA",
            lead_source: "paid_META"
          },
          {
            id: 3,
            first_name: "Mary",
            last_name: "Jackson",
            email: "mary@example.com",
            custom_field: { cf_source: "Organic" }
          }
        ]
      } as T;
    });
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listContactsTool, { source: "Paid_meta", page: 2, per_page: 10 }, ctx);
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(get).toHaveBeenCalledWith("api/contacts/view/contact-view", {
      query: { page: 2, per_page: 10, include: "owner,sales_account", sort: undefined, sort_type: undefined }
    });
    expect(approve.payload).toMatchObject({
      data: [
        {
          id: 1,
          cf_paid_meta: "yes",
          name: "Ada Lovelace",
          email: "ada@example.com",
          status: "Won",
          tags: ["Decision maker", "Champion"],
          owner: "Grace Hopper",
          account: "Analytical Engines"
        },
        {
          id: 2,
          name: "Katherine Johnson",
          email: "katherine@example.com",
          status: "Qualified",
          tags: ["Influencer"],
          owner: "42",
          account: "NASA"
        }
      ],
      page: 2,
      per_page: 10,
      filters_applied: {
        source: "Paid_meta",
        owner: null
      }
    });
  });

  it("resolves a contact view by name before listing contacts", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ fields: [{ name: "id", label: "ID" }, { name: "display_name", label: "Name" }] })
      .mockResolvedValueOnce({ filters: [{ id: "paid-meta-view", name: "Paid_meta" }] })
      .mockResolvedValueOnce({ contacts: [{ id: 1, first_name: "Ada", last_name: "Lovelace" }] });
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listContactsTool, { view: "Paid_meta", page: 1, per_page: 25 }, ctx);
    expect(propose.payload).toMatchObject({ estimated_call_count: 3 });

    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(get).toHaveBeenNthCalledWith(1, "api/settings/contacts/fields");
    expect(get).toHaveBeenNthCalledWith(2, "api/contacts/filters");
    expect(get).toHaveBeenNthCalledWith(3, "api/contacts/view/paid-meta-view", {
      query: { page: 1, per_page: 25, include: "owner,sales_account", sort: undefined, sort_type: undefined }
    });
    expect(approve.payload).toMatchObject({
      filters_applied: {
        view: "Paid_meta"
      }
    });
  });

  it("returns INVALID_FILTER when a contact view name cannot be resolved", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ fields: [{ name: "id", label: "ID" }] })
      .mockResolvedValueOnce({ filters: [{ id: "all", name: "All Contacts" }] });
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listContactsTool, { view: "Paid_meta" }, ctx);
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(true);
    expect(approve.payload).toMatchObject({
      error: {
        code: "INVALID_FILTER",
        message: "Unknown Freshsales contact filter: Paid_meta."
      }
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "api/settings/contacts/fields");
    expect(get).toHaveBeenNthCalledWith(2, "api/contacts/filters");
  });
});

describe("deal tools", () => {
  it("resolves a deal view by name before listing deals", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ fields: [{ name: "id", label: "ID" }, { name: "name", label: "Name" }, { name: "amount", label: "Amount" }, { name: "close_date", label: "Close Date" }] })
      .mockResolvedValueOnce({ filters: [{ id: "paid-meta-deals", name: "Paid_meta" }] })
      .mockResolvedValueOnce({
        deals: [{
          id: 5,
          name: "Expansion",
          amount: "1200",
          weighted_value: "900",
          deal_stage: { name: "Won" },
          close_date: "2026-09-01"
        }]
      });
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listDealsTool, { view: "Paid_meta", page: 1, per_page: 25 }, ctx);
    expect(propose.payload).toMatchObject({ estimated_call_count: 3 });

    const approve = await runTool(listDealsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(get).toHaveBeenNthCalledWith(1, "api/settings/deals/fields");
    expect(get).toHaveBeenNthCalledWith(2, "api/deals/filters");
    expect(get).toHaveBeenNthCalledWith(3, "api/deals/view/paid-meta-deals", {
      query: { page: 1, per_page: 25, include: "owner,sales_account,contacts,deal_stage", sort: undefined, sort_type: undefined }
    });
    expect(approve.payload).toMatchObject({
      data: [{ id: 5, name: "Expansion", amount: 1200, weighted_value: 900, stage: "Won", close_date: "2026-09-01" }],
      filters_applied: {
        view: "Paid_meta"
      }
    });
  });

  it("returns INVALID_FILTER when a deal view name cannot be resolved", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ fields: [{ name: "id", label: "ID" }] })
      .mockResolvedValueOnce({ filters: [{ id: "all", name: "All Deals" }] });
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listDealsTool, { view: "Paid_meta" }, ctx);
    const approve = await runTool(listDealsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(true);
    expect(approve.payload).toMatchObject({
      error: {
        code: "INVALID_FILTER",
        message: "Unknown Freshsales deal filter: Paid_meta."
      }
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "api/settings/deals/fields");
    expect(get).toHaveBeenNthCalledWith(2, "api/deals/filters");
  });
});

describe("search contacts parsing", () => {
  async function runApprovedSearch(payload: unknown) {
    const get = vi.fn(async <T>() => payload as T);
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(searchContactsTool, { query: "ada", page: 1, per_page: 25 }, ctx);
    const approve = await runTool(searchContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    return { approve, get };
  }

  it("extracts contacts from a flat search array with nested contact records", async () => {
    const { approve } = await runApprovedSearch([
      {
        id: 100,
        entity_type: "contact",
        contact: {
          id: 1,
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com"
        }
      }
    ]);

    expect(approve.isError).toBe(false);
    expect(approve.payload).toMatchObject({
      data: [{ id: 1, name: "Ada Lovelace", email: "ada@example.com" }]
    });
  });

  it("extracts contacts from a contacts key", async () => {
    const { approve } = await runApprovedSearch({
      contacts: [{ id: 2, first_name: "Grace", last_name: "Hopper", email: "grace@example.com" }]
    });

    expect(approve.payload).toMatchObject({
      data: [{ id: 2, name: "Grace Hopper", email: "grace@example.com" }]
    });
  });

  it("extracts contacts from a results key", async () => {
    const { approve } = await runApprovedSearch({
      results: [{ id: 3, first_name: "Katherine", last_name: "Johnson", email: "katherine@example.com" }]
    });

    expect(approve.payload).toMatchObject({
      data: [{ id: 3, name: "Katherine Johnson", email: "katherine@example.com" }]
    });
  });

  it("extracts contacts from a data key", async () => {
    const { approve } = await runApprovedSearch({
      data: [{ id: 4, first_name: "Mary", last_name: "Jackson", email: "mary@example.com" }]
    });

    expect(approve.payload).toMatchObject({
      data: [{ id: 4, name: "Mary Jackson", email: "mary@example.com" }]
    });
  });

  it("falls through when contacts is present but empty", async () => {
    const { approve } = await runApprovedSearch({
      contacts: [],
      results: [{ id: 5, first_name: "Dorothy", last_name: "Vaughan", email: "dorothy@example.com" }]
    });

    expect(approve.payload).toMatchObject({
      data: [{ id: 5, name: "Dorothy Vaughan", email: "dorothy@example.com" }]
    });
  });
});

describe("tool rejection logging", () => {
  it("logs AppError code and status when a tool call is rejected", async () => {
    const ctx = makeContext({
      freshsales: {
        get: vi.fn(async () => {
          const error = new AppError("UPSTREAM_NON_JSON", "Freshsales returned a non-JSON response.", 200) as AppError & {
            upstreamContentType?: string;
            upstreamBodySnippet?: string;
            upstreamStatus?: number;
          };
          error.upstreamContentType = "text/html";
          error.upstreamBodySnippet = "<!doctype html><title>Login</title>";
          error.upstreamStatus = 200;
          throw error;
        }) as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listContactsTool, { page: 1, per_page: 25 }, ctx);
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("tool_call_rejected", {
      tool: "list_contacts",
      status: "error",
      code: "UPSTREAM_NON_JSON",
      error_status: 200,
      upstream_status: 200,
      upstream_content_type: "text/html",
      upstream_body_snippet: "<!doctype html><title>Login</title>"
    });
  });
});
