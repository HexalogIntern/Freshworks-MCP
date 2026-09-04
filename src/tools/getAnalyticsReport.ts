import { parse } from "csv-parse/sync";
import { z } from "zod";

import { isAnalyticsReportCacheMiss, resolveAnalyticsReport } from "../freshsales/analyticsReports.js";
import { AppError } from "../utils/errors.js";
import { approvalFields, defineTool, type ToolExecutionContext } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    report_name: z.string().trim().min(1).max(200).optional(),
    report_id: z.string().trim().min(1).max(120).optional(),
    export_id: z.string().trim().min(1).max(200).optional(),
    refresh_reports: z.boolean().default(false),
    timeout_ms: z.number().int().min(0).max(20000).default(12000),
    poll_interval_ms: z.number().int().min(250).max(5000).default(1500),
    max_rows: z.number().int().min(1).max(10000).default(1000)
  })
  .strict();

interface AnalyticsReportParams {
  reportName?: string;
  reportId?: string;
  exportId?: string;
  refreshReports: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  maxRows: number;
}

interface ExportState {
  id: string | null;
  status: string | null;
  csvUrl: string | null;
  raw: Record<string, unknown>;
}

export const getAnalyticsReportTool = defineTool({
  name: "get_analytics_report",
  title: "Get Analytics Report",
  description:
    "Fetches a saved Freshsales Analytics report by report_id or fuzzy report_name. Report names are cached. Analytics retrieval is export-based: this triggers or resumes an export, polls briefly, downloads the CSV when ready, and returns parsed JSON rows. Pending exports return status=pending with export_id.",
  inputSchema: schema,
  resolve(input): AnalyticsReportParams {
    if (!input.report_name && !input.report_id && !input.export_id) {
      throw new AppError("MISSING_REPORT", "report_name, report_id, or export_id is required.");
    }

    return {
      reportName: input.report_name,
      reportId: input.report_id,
      exportId: input.export_id,
      refreshReports: input.refresh_reports,
      timeoutMs: input.timeout_ms,
      pollIntervalMs: input.poll_interval_ms,
      maxRows: input.max_rows
    };
  },
  estimateCallCount(params, ctx) {
    const reportLookupCalls = params.reportName && !params.reportId && isAnalyticsReportCacheMiss(ctx) ? 1 : 0;
    return reportLookupCalls + (params.exportId ? 1 : 2);
  },
  estimateCallCountDetails(params, ctx, estimatedCallCount) {
    return {
      estimated_call_count_typical: estimatedCallCount,
      estimate_note: "Analytics reports use one report-list lookup on cache miss, one export trigger unless export_id is supplied, then short status polling. Actual calls are reported in _meta after execution.",
      report_name_cache_hit: !(params.reportName && !params.reportId && isAnalyticsReportCacheMiss(ctx))
    };
  },
  async execute(params, ctx) {
    const report = params.exportId
      ? { id: params.reportId ?? null, name: params.reportName ?? null }
      : await resolveAnalyticsReport(ctx, {
        reportId: params.reportId,
        reportName: params.reportName,
        forceRefresh: params.refreshReports
      });
    const initial = params.exportId
      ? await fetchExportStatus(ctx, params.exportId)
      : await triggerExport(ctx, String(report.id));
    const finalState = await pollUntilReady(ctx, initial, params.timeoutMs, params.pollIntervalMs);

    if (!finalState.csvUrl || !isCompleted(finalState.status)) {
      const failed = isTerminalFailure(finalState.status);
      return {
        status: failed ? "failed" : "pending",
        partial: true,
        report,
        export_id: finalState.id,
        export_status: finalState.status,
        retry_after_ms: failed ? null : params.pollIntervalMs,
        raw_export_status: finalState.raw,
        note: failed
          ? "Freshsales Analytics export did not complete successfully."
          : "Freshsales Analytics export is still being prepared. Call get_analytics_report again with export_id to resume polling without triggering a new export."
      };
    }

    const csv = await fetchCsv(ctx, finalState.csvUrl);
    const rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      trim: true
    }) as Array<Record<string, unknown>>;
    const data = rows.slice(0, params.maxRows);

    return {
      status: "completed",
      partial: rows.length > data.length,
      report,
      export_id: finalState.id,
      export_status: finalState.status,
      total_rows: rows.length,
      returned_rows: data.length,
      data,
      csv_url: finalState.csvUrl
    };
  },
  willCallFreshsales: true
});

async function triggerExport(ctx: ToolExecutionContext, reportId: string): Promise<ExportState> {
  let payload: Record<string, unknown>;
  const path = templatePath(ctx.config.analyticsReportExportPathTemplate, {
    report_id: reportId
  });
  try {
    payload = await ctx.freshsales.post<Record<string, unknown>>(path, {
      body: {
        report_id: reportId,
        format: "csv"
      }
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      throw new AppError(
        "ANALYTICS_EXPORT_ENDPOINT_NOT_AVAILABLE",
        `Freshsales Analytics export trigger endpoint was not found at ${path}. Set FRESHSALES_ANALYTICS_REPORT_EXPORT_PATH_TEMPLATE to the one-time report export endpoint exposed by this account.`,
        404
      );
    }

    throw error;
  }
  return normalizeExportState(payload);
}

async function fetchExportStatus(ctx: ToolExecutionContext, exportId: string): Promise<ExportState> {
  const path = templatePath(ctx.config.analyticsExportStatusPathTemplate, {
    export_id: exportId
  });
  let payload: Record<string, unknown>;
  try {
    payload = await ctx.freshsales.get<Record<string, unknown>>(path);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      throw new AppError(
        "ANALYTICS_EXPORT_STATUS_ENDPOINT_NOT_AVAILABLE",
        `Freshsales Analytics export status endpoint was not found at ${path}. Set FRESHSALES_ANALYTICS_EXPORT_STATUS_PATH_TEMPLATE to the export status endpoint exposed by this account.`,
        404
      );
    }

    throw error;
  }
  return normalizeExportState(payload);
}

async function pollUntilReady(
  ctx: ToolExecutionContext,
  initial: ExportState,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<ExportState> {
  let state = initial;
  const deadline = Date.now() + timeoutMs;

  while (state.id && !state.csvUrl && !isTerminalFailure(state.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    state = await fetchExportStatus(ctx, state.id);
  }

  return state;
}

async function fetchCsv(ctx: ToolExecutionContext, rawUrl: string): Promise<string> {
  const url = new URL(rawUrl, `${ctx.config.freshsalesDomain}/`);
  const freshsalesOrigin = new URL(ctx.config.freshsalesDomain).origin;
  const authenticate = url.origin === freshsalesOrigin;
  if (authenticate) {
    ctx.usageTracker.recordCall(ctx.now(), {
      method: "GET",
      path: url.pathname
    });
  }

  const response = await fetch(url, {
    headers: authenticate
      ? { Authorization: `Token token=${ctx.config.freshsalesApiKey}` }
      : undefined
  });

  if (!response.ok) {
    throw new AppError("ANALYTICS_CSV_DOWNLOAD_FAILED", `Freshsales Analytics CSV download failed with status ${response.status}.`, response.status);
  }

  return response.text();
}

function normalizeExportState(payload: Record<string, unknown>): ExportState {
  const root = firstRecord(payload, ["export", "data", "job", "report_export"]) ?? payload;
  const id = scalarString(root.id) ?? scalarString(root.export_id) ?? scalarString(root.job_id);
  const status = stringValue(root.status) ?? stringValue(root.state);
  return {
    id,
    status,
    csvUrl: extractCsvUrl(root),
    raw: payload
  };
}

function extractCsvUrl(record: Record<string, unknown>): string | null {
  const direct = stringValue(record.csv_url)
    ?? stringValue(record.download_url)
    ?? stringValue(record.file_url)
    ?? stringValue(record.url)
    ?? stringValue(record.href);
  if (direct) {
    return direct;
  }

  const links = Array.isArray(record.links) ? record.links : [];
  for (const linkCandidate of links) {
    const link = firstRecord(asRecord(linkCandidate), ["link"]) ?? asRecord(linkCandidate);
    const href = stringValue(link.href) ?? stringValue(link.url);
    const rel = stringValue(link.rel)?.toLowerCase() ?? "";
    if (href && (rel.includes("csv") || rel.includes("download") || rel.includes("extract") || href.toLowerCase().includes(".csv"))) {
      return href;
    }
  }

  return null;
}

function isCompleted(status: string | null): boolean {
  return ["completed", "complete", "done", "success", "succeeded"].includes(String(status ?? "").trim().toLowerCase());
}

function isTerminalFailure(status: string | null): boolean {
  return ["failed", "failure", "error", "cancelled", "canceled"].includes(String(status ?? "").trim().toLowerCase());
}

function templatePath(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((path, [key, value]) => path.replaceAll(`{${key}}`, encodeURIComponent(value)), template);
}

function firstRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (Object.keys(value).length > 0) {
      return value;
    }
  }

  return null;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
