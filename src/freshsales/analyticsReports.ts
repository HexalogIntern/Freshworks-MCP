import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolExecutionContext } from "../tools/common.js";
import { AppError } from "../utils/errors.js";

export interface AnalyticsReportSummary {
  id: string;
  name: string;
}

interface AnalyticsReportCacheEntry {
  expiresAt: number;
  reports: AnalyticsReportSummary[];
}

interface PersistedAnalyticsReportCache {
  entries?: Record<string, AnalyticsReportCacheEntry>;
}

const cache = new Map<string, AnalyticsReportCacheEntry>();

export function clearAnalyticsReportCache(): void {
  cache.clear();
  rmSync(analyticsReportCachePath(), { force: true });
}

export function isAnalyticsReportCacheMiss(ctx: ToolExecutionContext): boolean {
  const cached = cache.get(persistedCacheKey(ctx));
  return !cached || Date.now() >= cached.expiresAt || ctx.config.analyticsReportCacheTtlMs === 0;
}

export async function resolveAnalyticsReport(
  ctx: ToolExecutionContext,
  params: {
    reportId?: string;
    reportName?: string;
    forceRefresh?: boolean;
  }
): Promise<AnalyticsReportSummary> {
  if (params.reportId) {
    const cached = await cachedReports(ctx, params.forceRefresh);
    const fromCache = cached?.find(report => report.id === params.reportId);
    return fromCache ?? { id: params.reportId, name: params.reportName ?? params.reportId };
  }

  if (!params.reportName) {
    throw new AppError("MISSING_REPORT", "report_name or report_id is required.");
  }

  const reports = await listAnalyticsReports(ctx, { forceRefresh: params.forceRefresh });
  const match = bestReportNameMatch(reports, params.reportName);
  if (!match) {
    const suggestions = reports
      .map(report => report.name)
      .filter(name => normalizedName(name).includes(normalizedName(params.reportName!)) || normalizedName(params.reportName!).includes(normalizedName(name)))
      .slice(0, 5);
    throw new AppError(
      "REPORT_NOT_FOUND",
      `Unknown Freshsales Analytics report: ${params.reportName}.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`
    );
  }

  return match;
}

export async function listAnalyticsReports(
  ctx: ToolExecutionContext,
  options: { forceRefresh?: boolean } = {}
): Promise<AnalyticsReportSummary[]> {
  const cached = await cachedReports(ctx, options.forceRefresh);
  if (cached) {
    return cached;
  }

  let payload: Record<string, unknown>;
  try {
    payload = await ctx.freshsales.get<Record<string, unknown>>(ctx.config.analyticsReportsPath);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      throw new AppError(
        "ANALYTICS_REPORTS_ENDPOINT_NOT_AVAILABLE",
        `Freshsales Analytics report listing endpoint was not found at ${ctx.config.analyticsReportsPath}. Set FRESHSALES_ANALYTICS_REPORTS_PATH to the Analytics reports endpoint exposed by this account, or use a scheduled Analytics data-export API URL/id if saved reports are not exposed.`,
        404
      );
    }

    throw error;
  }
  const reports = extractArray(payload, ["reports", "analytics_reports", "data", "items"])
    .map(normalizeReportSummary)
    .filter((report): report is AnalyticsReportSummary => report !== null);
  const entry = {
    reports,
    expiresAt: Date.now() + ctx.config.analyticsReportCacheTtlMs
  };

  cache.set(persistedCacheKey(ctx), entry);
  await writePersistedAnalyticsReports(ctx, entry);

  return reports;
}

function bestReportNameMatch(reports: AnalyticsReportSummary[], requested: string): AnalyticsReportSummary | null {
  const normalized = normalizedName(requested);
  return reports.find(report => normalizedName(report.name) === normalized)
    ?? reports.find(report => normalizedName(report.name).includes(normalized))
    ?? reports.find(report => normalized.includes(normalizedName(report.name)))
    ?? null;
}

function normalizeReportSummary(value: unknown): AnalyticsReportSummary | null {
  const record = asRecord(value);
  const id = scalarString(record.id) ?? scalarString(record.report_id);
  const name = stringValue(record.name) ?? stringValue(record.title) ?? stringValue(record.report_name);
  if (!id || !name) {
    return null;
  }

  return { id, name };
}

async function cachedReports(ctx: ToolExecutionContext, forceRefresh = false): Promise<AnalyticsReportSummary[] | null> {
  const key = persistedCacheKey(ctx);
  const memory = cache.get(key);
  if (!forceRefresh && memory && Date.now() < memory.expiresAt && ctx.config.analyticsReportCacheTtlMs !== 0) {
    return memory.reports;
  }

  const persisted = forceRefresh ? null : await readPersistedAnalyticsReports(ctx);
  if (persisted && Date.now() < persisted.expiresAt && ctx.config.analyticsReportCacheTtlMs !== 0) {
    cache.set(key, persisted);
    return persisted.reports;
  }

  return null;
}

async function readPersistedAnalyticsReports(ctx: ToolExecutionContext): Promise<AnalyticsReportCacheEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(analyticsReportCachePath(), "utf8")) as PersistedAnalyticsReportCache;
    const entry = parsed.entries?.[persistedCacheKey(ctx)];
    return entry && Array.isArray(entry.reports) ? entry : null;
  } catch {
    return null;
  }
}

async function writePersistedAnalyticsReports(ctx: ToolExecutionContext, entry: AnalyticsReportCacheEntry): Promise<void> {
  try {
    await mkdir(join(tmpdir(), "freshsales-mcp"), { recursive: true });
    const current = await readPersistedAnalyticsReportsFile();
    current.entries = current.entries ?? {};
    current.entries[persistedCacheKey(ctx)] = entry;
    await writeFile(analyticsReportCachePath(), JSON.stringify(current), "utf8");
  } catch {
    ctx.logger.warn("analytics_report_cache_persist_failed");
  }
}

async function readPersistedAnalyticsReportsFile(): Promise<PersistedAnalyticsReportCache> {
  try {
    return JSON.parse(await readFile(analyticsReportCachePath(), "utf8")) as PersistedAnalyticsReportCache;
  } catch {
    return {};
  }
}

function analyticsReportCachePath(): string {
  return join(tmpdir(), "freshsales-mcp", "analytics-report-cache.json");
}

function persistedCacheKey(ctx: ToolExecutionContext): string {
  return ctx.config.freshsalesDomain;
}

function extractArray(payload: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}
