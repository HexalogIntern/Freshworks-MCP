import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { clearFieldSchemaCache, clearFieldSchemaMemoryCache } from "../src/freshsales/fieldSchema.js";
import { scanView, scanViews } from "../src/freshsales/paginatedScan.js";
import { FreshsalesClient } from "../src/freshsales/client.js";
import { clearViewCaches, getCachedFieldCoverage, getCachedViews } from "../src/freshsales/viewCache.js";
import { ApprovalStore } from "../src/state/approvalStore.js";
import { DailyUsageTracker } from "../src/state/dailyUsageTracker.js";
import type { FreshsalesClientLike } from "../src/freshsales/types.js";
import { getContactTool } from "../src/tools/getContact.js";
import { contactsSummaryTool } from "../src/tools/contactsSummary.js";
import { discoverFieldsTool } from "../src/tools/discoverFields.js";
import { discoverViewsTool } from "../src/tools/discoverViews.js";
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
  clearViewCaches();
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
    contactsScanMaxPages: 10,
    contactsScanMaxViews: 15,
    dealsScanMaxPages: 10,
    dealsScanMaxViews: 15,
    fieldSchemaCacheTtlMs: 3600000,
    viewListCacheTtlMs: 3600000,
    viewFieldCoverageCacheTtlMs: 3600000,
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

describe("paginated scan", () => {
  it("finds matches scattered beyond page one and reports truncation accurately", async () => {
    const get = vi.fn(async <T>(_path: string, options?: { query?: { page?: number; per_page?: number } }) => {
      const page = Number(options?.query?.page ?? 1);
      const perPage = Number(options?.query?.per_page ?? 5);
      const contacts = Array.from({ length: perPage }, (_, index) => {
        const id = (page - 1) * perPage + index + 1;
        return { id, source: page >= 3 && page <= 6 && index === 0 ? "Paid_meta" : "Organic" };
      });

      return { contacts } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const scan = await scanView(ctx, {
      entity: "contacts",
      viewId: "contact-view",
      perPage: 5,
      maxPages: 10,
      matches: record => record.source === "Paid_meta"
    });

    expect(scan.records.map(record => record.id)).toEqual([11, 16, 21, 26]);
    expect(scan.scannedRecords).toBe(50);
    expect(scan.truncated).toBe(true);
  });

  it("sets truncated false when the dataset fits within the scan cap", async () => {
    const get = vi.fn(async <T>(_path: string, options?: { query?: { page?: number; per_page?: number } }) => {
      const page = Number(options?.query?.page ?? 1);
      return { contacts: page < 3 ? [{ id: page }] : [] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const scan = await scanView(ctx, {
      entity: "contacts",
      viewId: "contact-view",
      perPage: 1,
      maxPages: 10,
      matches: () => true
    });

    expect(scan.scannedRecords).toBe(2);
    expect(scan.truncated).toBe(false);
  });

  it("deduplicates multi-view matches and records every matched view", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path.includes("paid")) {
        return { contacts: [{ id: 1, display_name: "Ada" }] } as T;
      }

      return { contacts: [{ id: 1, display_name: "Ada" }, { id: 2, display_name: "Grace" }] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const scan = await scanViews(ctx, {
      entity: "contacts",
      views: [{ id: "paid", name: "Paid Media" }, { id: "all", name: "All Contacts" }],
      maxViews: 2,
      perPage: 50,
      maxPages: 1,
      annotateMatchedView: true,
      matches: () => true
    });

    expect(scan.records).toMatchObject([
      { id: 1, matched_views: ["Paid Media", "All Contacts"] },
      { id: 2, matched_views: ["All Contacts"] }
    ]);
  });

  it("reports skipped views and truncation when the multi-view cap is hit", async () => {
    const get = vi.fn(async <T>() => ({ contacts: [] }) as T);
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const scan = await scanViews(ctx, {
      entity: "contacts",
      views: [{ id: "1", name: "One" }, { id: "2", name: "Two" }, { id: "3", name: "Three" }],
      maxViews: 2,
      perPage: 50,
      maxPages: 1,
      matches: () => true
    });

    expect(scan.viewsScanned).toEqual(["One", "Two"]);
    expect(scan.viewsSkippedDueToCap).toEqual(["Three"]);
    expect(scan.truncated).toBe(true);
  });
});

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
  it("discovers contact views, populates field coverage, and lets a later contact filter use the cache-hit path", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/contacts/filters") {
        return {
          filters: [
            { id: "paid-view", name: "Paid Media Contacts" },
            { id: "organic-view", name: "Organic Contacts" }
          ]
        } as T;
      }

      if (path === "api/contacts/view/paid-view") {
        return {
          contacts: [
            { id: 1, display_name: "Ada Lovelace", custom_field: { cf_source: "paid_meta" } }
          ]
        } as T;
      }

      if (path === "api/contacts/view/organic-view") {
        return {
          contacts: [
            { id: 2, display_name: "Grace Hopper", custom_field: { cf_source: "organic" } }
          ]
        } as T;
      }

      if (path === "api/settings/contacts/fields") {
        return {
          fields: [
            { name: "id", label: "ID" },
            { name: "display_name", label: "Name" },
            { name: "cf_source", label: "Source" }
          ]
        } as T;
      }

      return { contacts: [] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const proposeDiscovery = await runTool(discoverViewsTool, { entity: "contacts", sample_pages_per_view: 1 }, ctx);
    expect(proposeDiscovery.payload).toMatchObject({ estimated_call_count: 3 });

    const approveDiscovery = await runTool(discoverViewsTool, { approved: true, request_id: requestIdFrom(proposeDiscovery) }, ctx);

    expect(approveDiscovery.isError).toBe(false);
    expect(getCachedViews("contacts", ctx.config)?.map(view => view.name)).toEqual(["Paid Media Contacts", "Organic Contacts"]);
    expect(getCachedFieldCoverage("contacts", ctx.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        view: expect.objectContaining({ id: "paid-view" }),
        populatedFields: expect.arrayContaining([
          expect.objectContaining({ field: "custom_field.cf_source", values: ["paid_meta"] })
        ]),
        strongFilterCandidates: expect.arrayContaining(["source:paid_meta"])
      })
    ]));

    get.mockClear();
    const proposeList = await runTool(listContactsTool, { source: "paid_meta", per_page: 50 }, ctx);
    expect(proposeList.payload).toMatchObject({ estimated_call_count: 10 });

    const approveList = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(proposeList) }, ctx);

    expect(approveList.isError).toBe(false);
    expect(approveList.payload).toMatchObject({
      data: [{ id: 1, cf_source: "paid_meta" }],
      views_scanned: ["Paid Media Contacts"]
    });
    expect(get).toHaveBeenCalledWith("api/contacts/view/paid-view", {
      query: { page: 1, per_page: 50, include: "owner,sales_account" }
    });
    expect(get).not.toHaveBeenCalledWith("api/contacts/filters");
    expect(get).not.toHaveBeenCalledWith("api/contacts/view/organic-view", expect.anything());
  });

  it("keeps discover_views approval estimate equal to real sample calls for a mocked 15-view account", async () => {
    const views = Array.from({ length: 15 }, (_, index) => ({
      id: `view-${index + 1}`,
      name: `View ${index + 1}`
    }));
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/contacts/filters") {
        return { filters: views } as T;
      }

      return { contacts: [{ id: path, custom_field: { cf_source: "paid_meta" } }] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const propose = await runTool(discoverViewsTool, { entity: "contacts", sample_pages_per_view: 1 }, ctx);
    expect(propose.payload).toMatchObject({ estimated_call_count: 16 });

    const approve = await runTool(discoverViewsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(approve.payload).toMatchObject({
      views_scanned: 15,
      total_sample_calls: 15
    });
    expect(get).toHaveBeenCalledTimes(17);
    expect(get.mock.calls.filter(([path]) => String(path).startsWith("api/contacts/view/"))).toHaveLength(15);
  });

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

  it("lists contacts and resolves source through Freshsales field metadata", async () => {
    const get = vi.fn(async <T>(path: string, options?: { query?: { page?: number } }) => {
      if (path === "api/settings/contacts/fields") {
        return {
          fields: [
            { name: "id", label: "ID" },
            { name: "display_name", label: "Name" },
            { name: "email", label: "Email" },
            { name: "cf_source", label: "Source" }
          ]
        } as T;
      }

      const page = Number(options?.query?.page ?? 1);
      return page === 1 ? {
        contacts: Array.from({ length: 10 }, (_, index) => ({ id: 90 + index, first_name: "Page", last_name: "One", custom_field: { cf_source: "Organic" } }))
      } as T : {
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
            custom_field: { cf_source: "Paid_meta" }
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
            custom_field: { cf_source: "paid_META" }
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
    expect(propose.payload).toMatchObject({ estimated_call_count: 152 });
    expect(approve.payload).toMatchObject({
      data: [
        {
          id: 1,
          cf_source: "Paid_meta",
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
      scanned_records: 13,
      truncated: false,
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

  it("returns UNKNOWN_FIELD when source is not resolvable in contact metadata", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/settings/contacts/fields") {
        return { fields: [{ name: "cf_channel", label: "Source Channel" }] } as T;
      }

      return { contacts: [] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const propose = await runTool(listContactsTool, { source: "Paid_meta" }, ctx);
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(true);
    expect(approve.payload).toMatchObject({
      error: {
        code: "UNKNOWN_FIELD",
        message: "Unknown Freshsales field: source. Did you mean: cf_channel (Source Channel)?"
      }
    });
  });

  it("supports contains match mode for contact source and keeps unfiltered calls to one list request", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/settings/contacts/fields") {
        return { fields: [{ name: "id", label: "ID" }, { name: "cf_source", label: "Source" }, { name: "display_name", label: "Name" }] } as T;
      }

      return {
        contacts: [
          { id: 1, display_name: "Ada", custom_field: { cf_source: "Paid Meta - Summer" } },
          { id: 2, display_name: "Grace", custom_field: { cf_source: "Organic" } }
        ]
      } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const exactPropose = await runTool(listContactsTool, { source: "paid", per_page: 10 }, ctx);
    const exactApprove = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(exactPropose) }, ctx);
    expect(exactApprove.payload).toMatchObject({ data: [] });

    clearFieldSchemaCache();
    const containsPropose = await runTool(listContactsTool, { source: "paid", match_mode: "contains", per_page: 10 }, ctx);
    const containsApprove = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(containsPropose) }, ctx);
    expect(containsApprove.payload).toMatchObject({ data: [{ id: 1, cf_source: "Paid Meta - Summer" }] });

    get.mockClear();
    const plainPropose = await runTool(listContactsTool, { per_page: 10 }, ctx);
    const plainApprove = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(plainPropose) }, ctx);
    expect(plainApprove.isError).toBe(false);
    expect(get).toHaveBeenCalledWith("api/contacts/view/contact-view", {
      query: { page: 1, per_page: 10, include: "owner,sales_account", sort: undefined, sort_type: undefined }
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("treats contact UI labels and API field names as identical filter inputs", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/settings/contacts/fields") {
        return {
          fields: [
            { name: "id", label: "ID" },
            { name: "cf_pain_statement", label: "Remarks" }
          ]
        } as T;
      }

      return {
        contacts: [
          { id: 1, custom_field: { cf_pain_statement: "Needs onboarding" } },
          { id: 2, custom_field: { cf_pain_statement: "No current pain" } }
        ]
      } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const byLabel = await runTool(listContactsTool, { filter_by: "remarks", filter_value: "Needs onboarding", per_page: 10 }, ctx);
    const byLabelApproved = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(byLabel) }, ctx);
    const byApi = await runTool(listContactsTool, { filter_by: "cf_pain_statement", filter_value: "Needs onboarding", per_page: 10 }, ctx);
    const byApiApproved = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(byApi) }, ctx);

    expect(byLabelApproved.isError).toBe(false);
    expect(byLabelApproved.payload).toMatchObject({
      data: [{ id: 1, cf_pain_statement: "Needs onboarding" }],
      filters_applied: {
        filter_by: "remarks",
        filter_api_field: "cf_pain_statement",
        filter_ui_label: "Remarks"
      }
    });
    expect(byApiApproved.payload).toMatchObject({
      data: [{ id: 1, cf_pain_statement: "Needs onboarding" }],
      filters_applied: {
        filter_api_field: "cf_pain_statement",
        filter_ui_label: "Remarks"
      }
    });
  });

  it("auto-adds targeted contact relation includes when filtering by a UI label like status", async () => {
    const get = vi.fn(async <T>(path: string, options?: { query?: { include?: string } }) => {
      if (path === "api/settings/contacts/fields") {
        return {
          fields: [
            { name: "id", label: "ID" },
            { name: "contact_status_id", label: "Status" }
          ]
        } as T;
      }

      if (path === "api/contacts/filters") {
        return { filters: [] } as T;
      }

      expect(options?.query?.include).toContain("contact_status");
      return {
        contacts: [
          { id: 1, contact_status_id: 10 },
          { id: 2, contact_status_id: 20 }
        ]
      } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const propose = await runTool(listContactsTool, { filter_by: "status", filter_value: "10", per_page: 10 }, ctx);
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(approve.payload).toMatchObject({
      data: [{ id: 1, contact_status_id: 10 }],
      filters_applied: {
        filter_by: "status",
        filter_api_field: "contact_status_id",
        filter_ui_label: "Status"
      }
    });
  });

  it("discovers field labels and reuses the warmed alias cache after a cold memory start", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/settings/contacts/fields") {
        return { fields: [{ name: "cf_pain_statement", label: "Remarks", type: "custom_text" }] } as T;
      }

      return { fields: [] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const firstPropose = await runTool(discoverFieldsTool, { entity: "contacts" }, ctx);
    expect(firstPropose.payload).toMatchObject({ estimated_call_count: 1 });
    const firstApprove = await runTool(discoverFieldsTool, { approved: true, request_id: requestIdFrom(firstPropose) }, ctx);
    clearFieldSchemaMemoryCache();
    const secondPropose = await runTool(discoverFieldsTool, { entity: "contacts" }, ctx);
    expect(secondPropose.payload).toMatchObject({ estimated_call_count: 1 });
    const secondApprove = await runTool(discoverFieldsTool, { approved: true, request_id: requestIdFrom(secondPropose) }, ctx);

    expect(firstApprove.payload).toMatchObject({
      contacts: {
        fields: [{ api_field: "cf_pain_statement", ui_label: "Remarks", type: "custom_text" }]
      }
    });
    expect(secondApprove.payload).toMatchObject(firstApprove.payload);
    expect(get).toHaveBeenCalledTimes(1);
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

  it("hydrates contact relations with opt-in per-contact detail calls", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        fields: [
          { name: "id", label: "ID" },
          { name: "display_name", label: "Name" },
          { name: "lifecycle_stage_id", label: "Lifecycle stage" },
          { name: "contact_status_id", label: "Status" }
        ]
      })
      .mockResolvedValueOnce({
        contacts: [{
          id: 10,
          display_name: "Ada Lovelace",
          lifecycle_stage_id: null,
          contact_status_id: null,
          sales_accounts: null
        }]
      })
      .mockResolvedValueOnce({
        contact: {
          id: 10,
          display_name: "Ada Lovelace",
          lifecycle_stage: { name: "Qualified" },
          lifecycle_stage_id: 2001,
          contact_status_id: 3001,
          sales_accounts: [{ id: 99, name: "Analytical Engines", is_primary: true }]
        }
      });
    const ctx = makeContext({
      freshsales: {
        get: get as unknown as FreshsalesClientLike["get"]
      }
    });

    const propose = await runTool(listContactsTool, { hydrate_relations: true, page: 1, per_page: 1 }, ctx);
    expect(propose.payload).toMatchObject({ estimated_call_count: 3 });

    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(get).toHaveBeenNthCalledWith(3, "api/contacts/10", {
      query: { include: "owner,sales_accounts,sales_account" }
    });
    expect(approve.payload).toMatchObject({
      data: [{
        id: 10,
        status: "Qualified",
        lifecycle_stage_id: 2001,
        contact_status_id: 3001,
        account: "Analytical Engines",
        sales_accounts: [{ id: "99", name: "Analytical Engines", is_primary: true }]
      }],
      filters_applied: {
        hydrate_relations: true
      }
    });
  });

  it("rejects relation hydration above the per-page cap", async () => {
    const ctx = makeContext();

    const propose = await runTool(listContactsTool, { hydrate_relations: true, page: 1, per_page: 11 }, ctx);
    const approve = await runTool(listContactsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(true);
    expect(approve.payload).toMatchObject({
      error: {
        code: "HYDRATION_LIMIT_EXCEEDED"
      }
    });
  });
});

describe("deal tools", () => {
  it("scans multiple pages for deal filters including owner and date range", async () => {
    const get = vi.fn(async <T>(path: string, options?: { query?: { page?: number } }) => {
      if (path === "api/settings/deals/fields") {
        return { fields: [{ name: "id", label: "ID" }, { name: "name", label: "Name" }] } as T;
      }

      const page = Number(options?.query?.page ?? 1);
      return {
        deals: page === 1
          ? [
            { id: 1, name: "Wrong owner", owner: { first_name: "Ada" }, close_date: "2026-08-10", deal_stage: { name: "Open" } },
            { id: 2, name: "Wrong date", owner: { first_name: "Grace" }, close_date: "2026-07-01", deal_stage: { name: "Open" } }
          ]
          : [
            { id: 3, name: "Expansion", owner: { first_name: "Grace" }, close_date: "2026-08-15", deal_stage: { name: "Open" } }
          ]
      } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] }, appConfig: config({ dealsScanMaxPages: 5 }) });

    const propose = await runTool(listDealsTool, { owner: "Grace", date_from: "2026-08-01", date_to: "2026-08-31", per_page: 2 }, ctx);
    expect(propose.payload).toMatchObject({ estimated_call_count: 77 });
    const approve = await runTool(listDealsTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(approve.payload).toMatchObject({
      data: [{ id: 3, name: "Expansion" }],
      scanned_records: 3,
      truncated: false
    });
  });

  it("supports contains match mode for deals and keeps unfiltered calls to one list request", async () => {
    const get = vi.fn(async <T>(path: string) => {
      if (path === "api/settings/deals/fields") {
        return { fields: [{ name: "name", label: "Name" }] } as T;
      }

      return { deals: [{ id: 1, name: "Paid Meta Expansion" }, { id: 2, name: "Renewal" }] } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] } });

    const exactPropose = await runTool(listDealsTool, { filter_by: "name", filter_value: "paid", per_page: 10 }, ctx);
    const exactApprove = await runTool(listDealsTool, { approved: true, request_id: requestIdFrom(exactPropose) }, ctx);
    expect(exactApprove.payload).toMatchObject({ data: [] });

    clearFieldSchemaCache();
    const containsPropose = await runTool(listDealsTool, { filter_by: "name", filter_value: "paid", match_mode: "contains", per_page: 10 }, ctx);
    const containsApprove = await runTool(listDealsTool, { approved: true, request_id: requestIdFrom(containsPropose) }, ctx);
    expect(containsApprove.payload).toMatchObject({ data: [{ id: 1, name: "Paid Meta Expansion" }] });

    get.mockClear();
    const plainPropose = await runTool(listDealsTool, { per_page: 10 }, ctx);
    const plainApprove = await runTool(listDealsTool, { approved: true, request_id: requestIdFrom(plainPropose) }, ctx);
    expect(plainApprove.isError).toBe(false);
    expect(get).toHaveBeenCalledWith("api/deals/view/deal-view", {
      query: { page: 1, per_page: 10, include: "owner,sales_account,contacts,deal_stage", sort: undefined, sort_type: undefined }
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

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

describe("contacts summary", () => {
  it("groups contacts by month across multiple scanned pages", async () => {
    const get = vi.fn(async <T>(path: string, options?: { query?: { page?: number } }) => {
      const page = Number(options?.query?.page ?? 1);
      return {
        contacts: page === 1
          ? Array.from({ length: 50 }, (_, index) => ({ id: index + 1, created_at: "2026-08-01T00:00:00Z" }))
          : [
            { id: 51, created_at: "2026-09-01T00:00:00Z" }
          ]
      } as T;
    });
    const ctx = makeContext({ freshsales: { get: get as unknown as FreshsalesClientLike["get"] }, appConfig: config({ contactsScanMaxPages: 5 }) });

    const propose = await runTool(contactsSummaryTool, { group_by: "month" }, ctx);
    const approve = await runTool(contactsSummaryTool, { approved: true, request_id: requestIdFrom(propose) }, ctx);

    expect(approve.isError).toBe(false);
    expect(approve.payload).toMatchObject({
      group_by: "month",
      scanned_records: 51,
      truncated: false,
      groups: [
        { key: "2026-08", count: 50 },
        { key: "2026-09", count: 1 }
      ]
    });
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
