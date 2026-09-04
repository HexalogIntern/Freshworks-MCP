import { DateTime } from "luxon";
import { z } from "zod";

import { isContactStatusCacheMiss } from "../freshsales/contactStatusCache.js";
import { isFieldSchemaCacheMiss } from "../freshsales/fieldSchema.js";
import type { QueryConditionInput, QueryGroupInput } from "../freshsales/queryEngine.js";
import type { JsonRecord } from "../types.js";
import { AppError } from "../utils/errors.js";
import { isIsoDate } from "../utils/time.js";
import { approvalFields, defineTool, type ToolExecutionContext } from "./common.js";
import { runReportTool, type RunReportParams } from "./runReport.js";

const conditionSchema = z.object({
  field: z.string().trim().min(1).max(120),
  operator: z.string().trim().min(1).max(40),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])), z.null()]).optional()
}).strict();
const metricObjectSchema = z.object({
  op: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
  field: z.string().trim().min(1).max(120).optional()
}).strict();
const metricSchema = z.union([z.string().trim().min(1).max(160), metricObjectSchema]);

const schema = z.object({
  ...approvalFields,
  entity: z.enum(["contacts", "deals"]).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  metrics: z.array(metricSchema).max(8).default([]),
  group_by: z.array(z.string().trim().min(1).max(120)).max(2).default([]),
  filters: z.array(conditionSchema).max(20).default([]),
  date_from: z.string().trim().optional(),
  date_to: z.string().trim().optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
  max_group_values: z.number().int().min(1).max(500).default(100)
}).strict();

interface Params {
  description: string | null;
  report: RunReportParams;
  interpreted: JsonRecord;
}

export const generateCustomReportTool = defineTool({
  name: "generate_custom_report",
  title: "Generate Custom Report",
  description:
    "Generates custom Freshsales report data from a natural-language description plus optional structured metrics, filters, date range, and group_by fields. Use this for requests such as: 'Since 1st July 12 am, how many contacts have been created grouped by Source and status'. It returns the interpreted run_report request and the generated report data; it does not create a saved native Freshsales UI report.",
  inputSchema: schema,
  resolve(input, ctx): Params {
    if (!input.description && input.metrics.length === 0 && input.group_by.length === 0 && input.filters.length === 0 && !input.date_from && !input.date_to) {
      throw new AppError("MISSING_REPORT_DESCRIPTION", "Provide description, metrics, group_by, filters, or a date range.");
    }

    const description = input.description ?? "";
    const entity = input.entity ?? inferEntity(description, input.metrics);
    const filters = [
      ...(input.filters as QueryConditionInput[]),
      ...dateFilters(description, input.date_from, input.date_to, ctx)
    ];
    const groupBy = (input.group_by.length > 0 ? input.group_by : inferGroupBy(description))
      .map(field => ({ field }));
    const metrics = normalizeMetrics(input.metrics, description, entity);
    const report: RunReportParams = {
      entity,
      groups: [{ logic: "and", conditions: filters }],
      groupBy,
      metrics,
      limit: input.limit,
      maxGroupValues: input.max_group_values
    };

    return {
      description: input.description ?? null,
      report,
      interpreted: {
        entity,
        filters,
        group_by: groupBy,
        metrics,
        limit: input.limit,
        max_group_values: input.max_group_values
      }
    };
  },
  estimateCallCount(params, ctx) {
    const statusLookupCalls = params.report.entity === "contacts"
      && reportMentionsStatus(params)
      && isContactStatusCacheMiss(ctx)
      ? 1
      : 0;
    const schemaLookupCalls = isFieldSchemaCacheMiss(ctx, params.report.entity) ? 1 : 0;
    return Math.max(
      statusLookupCalls + schemaLookupCalls + 1,
      runReportTool.estimateCallCount(params.report, ctx)
    );
  },
  estimateCallCountDetails(params, ctx, estimatedCallCount) {
    return {
      estimated_call_count_typical: estimatedCallCount,
      estimate_note: "Custom report descriptions are translated into a run_report request; exact count grouped dropdown reports use Freshsales filtered_search totals when possible.",
      interpreted_request: params.interpreted,
      field_schema_cache_hit: !isFieldSchemaCacheMiss(ctx, params.report.entity)
    };
  },
  async execute(params, ctx) {
    const report = await runReportTool.execute(params.report, ctx);
    return {
      custom_report: true,
      description: params.description,
      interpreted_request: params.interpreted,
      ...report
    };
  },
  willCallFreshsales: true
});

function inferEntity(description: string, metrics: Array<string | { field?: string }>): "contacts" | "deals" {
  const text = `${description} ${metrics.map(metric => typeof metric === "string" ? metric : metric.field ?? "").join(" ")}`.toLowerCase();
  if (/\bdeal|pipeline|deal value|amount|revenue|stage\b/.test(text)) {
    return "deals";
  }

  return "contacts";
}

function inferGroupBy(description: string): string[] {
  const match = description.match(/\bgroup(?:ed)?\s+by\s+(.+?)(?=$|[.?;]|\s+(?:since|from|where|with|for)\b)/i);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map(field => field.replace(/\b(contact|contacts|deal|deals)\b/gi, "").trim())
    .filter(Boolean)
    .slice(0, 2);
}

function normalizeMetrics(
  metrics: Array<string | { op: "count" | "sum" | "avg" | "min" | "max"; field?: string }>,
  description: string,
  entity: "contacts" | "deals"
): RunReportParams["metrics"] {
  if (metrics.length > 0) {
    return metrics.map(metric => typeof metric === "string" ? parseMetric(metric, entity) : metric);
  }

  return [parseMetric(description, entity)];
}

function parseMetric(text: string, entity: "contacts" | "deals"): RunReportParams["metrics"][number] {
  const normalized = text.toLowerCase();
  if (/\b(avg|average|mean)\b/.test(normalized)) {
    return { op: "avg", field: metricField(normalized, entity) };
  }
  if (/\b(min|minimum|lowest)\b/.test(normalized)) {
    return { op: "min", field: metricField(normalized, entity) };
  }
  if (/\b(max|maximum|highest)\b/.test(normalized)) {
    return { op: "max", field: metricField(normalized, entity) };
  }
  if (/\b(sum|total)\b/.test(normalized) && /\b(value|amount|revenue|deal value)\b/.test(normalized)) {
    return { op: "sum", field: metricField(normalized, entity) };
  }

  return { op: "count" };
}

function metricField(text: string, entity: "contacts" | "deals"): string {
  if (entity === "deals" && /\b(value|amount|revenue|deal value)\b/.test(text)) {
    return "deal value";
  }

  const fieldMatch = text.match(/\b(?:of|for)\s+([a-z][a-z0-9 _-]{1,80})$/i);
  return fieldMatch?.[1]?.trim() || "value";
}

function dateFilters(
  description: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  ctx: ToolExecutionContext
): QueryConditionInput[] {
  const filters: QueryConditionInput[] = [];
  const resolvedFrom = dateFrom ?? inferSinceDate(description, ctx);
  if (resolvedFrom) {
    if (!isIsoDate(resolvedFrom)) {
      throw new AppError("INVALID_DATE", "date_from must be a valid ISO date or datetime.");
    }
    filters.push({ field: "created_at", operator: "after", value: resolvedFrom });
  }

  if (dateTo) {
    if (!isIsoDate(dateTo)) {
      throw new AppError("INVALID_DATE", "date_to must be a valid ISO date or datetime.");
    }
    filters.push({ field: "created_at", operator: "before", value: dateTo });
  }

  return filters;
}

function inferSinceDate(description: string, ctx: ToolExecutionContext): string | null {
  const match = description.match(/\b(?:since|from)\s+(.+?)(?=$|[,.;?]|\s+group(?:ed)?\s+by\b)/i);
  if (!match?.[1]) {
    return null;
  }

  return parseLooseDate(match[1], ctx);
}

function parseLooseDate(value: string, ctx: ToolExecutionContext): string | null {
  const zone = ctx.config.resetTimeZone || "UTC";
  const now = DateTime.fromJSDate(ctx.now(), { zone });
  const normalized = value
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\bat\b/gi, " ")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(am|pm)\b/gi, token => token.toUpperCase());
  const hasYear = /\b\d{4}\b/.test(normalized);
  const candidates = hasYear ? [normalized] : [`${normalized} ${now.year}`];
  const formats = [
    "d LLLL h a yyyy",
    "d LLL h a yyyy",
    "LLLL d h a yyyy",
    "LLL d h a yyyy",
    "d LLLL yyyy",
    "d LLL yyyy",
    "LLLL d yyyy",
    "LLL d yyyy",
    "yyyy-LL-dd HH:mm",
    "yyyy-LL-dd"
  ];

  for (const candidate of candidates) {
    for (const format of formats) {
      const parsed = DateTime.fromFormat(candidate, format, { zone });
      if (!parsed.isValid) {
        continue;
      }
      const adjusted = parsed > now.plus({ days: 1 }) && !hasYear ? parsed.minus({ years: 1 }) : parsed;
      return adjusted.toISO();
    }
  }

  const iso = DateTime.fromISO(normalized, { zone });
  return iso.isValid ? iso.toISO() : null;
}

function reportMentionsStatus(params: Params): boolean {
  return [
    ...params.report.groupBy.map(group => group.field),
    ...params.report.groups.flatMap(group => group.conditions.map(condition => condition.field)),
    ...params.report.metrics.map(metric => metric.field).filter((field): field is string => Boolean(field))
  ].some(field => field.trim().toLowerCase().replace(/[\s_-]+/g, "") === "status");
}
