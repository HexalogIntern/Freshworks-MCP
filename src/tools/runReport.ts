import { z } from "zod";

import { fetchFieldSchema, resolveFieldAlias, type FieldSchemaEntity, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { displayValueForReport, queryRecords, type QueryConditionInput, type QueryGroupInput } from "../freshsales/queryEngine.js";
import { approvalFields, defineTool } from "./common.js";

const conditionSchema = z.object({
  field: z.string().trim().min(1).max(120),
  operator: z.string().trim().min(1).max(40),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])), z.null()]).optional()
}).strict();
const groupBySchema = z.object({
  field: z.string().trim().min(1).max(120),
  bucket: z.enum(["day", "week", "month", "quarter"]).optional()
}).strict();
const metricSchema = z.object({
  op: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
  field: z.string().trim().min(1).max(120).optional()
}).strict();

const schema = z.object({
  ...approvalFields,
  entity: z.enum(["contacts", "deals"]),
  filters: z.array(conditionSchema).max(20).default([]),
  group_by: z.array(groupBySchema).max(2).default([]),
  metrics: z.array(metricSchema).max(8).default([{ op: "count" }]),
  limit: z.number().int().min(1).max(5000).default(1000),
  sort_by: z.string().trim().min(1).max(120).optional()
}).strict();

interface Params {
  entity: FieldSchemaEntity;
  groups: QueryGroupInput[];
  groupBy: Array<{ field: string; bucket?: "day" | "week" | "month" | "quarter" }>;
  metrics: Array<{ op: "count" | "sum" | "avg" | "min" | "max"; field?: string }>;
  limit: number;
  sortBy?: string;
}

export const runReportTool = defineTool({
  name: "run_report",
  title: "Run Report",
  description:
    "Reusable Freshsales reporting tool for contacts and deals. Filters are field-agnostic; group_by accepts any discovered dropdown, multi-select, or date field with optional date bucketing. Supports two-dimensional cross-tabs and count/sum/avg/min/max numeric metrics. Results are flagged when based on a paginated fallback.",
  inputSchema: schema,
  resolve(input): Params {
    return {
      entity: input.entity,
      groups: [{ logic: "and", conditions: input.filters as QueryConditionInput[] }],
      groupBy: input.group_by,
      metrics: input.metrics,
      limit: input.limit,
      sortBy: input.sort_by
    };
  },
  estimateCallCount(params, ctx) {
    return Math.ceil(params.limit / 100) + (ctx.config.fieldSchemaCacheTtlMs === 0 ? 1 : 0);
  },
  async execute(params, ctx) {
    const schema = await fetchFieldSchema(ctx, params.entity);
    const groupFields = params.groupBy.map(group => ({ ...group, field: resolveFieldAlias(schema, group.field).apiField }));
    const metricFields = params.metrics.map(metric => ({
      ...metric,
      fieldDef: metric.field ? resolveFieldAlias(schema, metric.field).apiField : undefined
    }));
    const collected: Array<Record<string, unknown>> = [];
    let page = 1;
    while (collected.length < params.limit) {
      const result = await queryRecords(ctx, {
        entity: params.entity,
        groups: params.groups,
        fields: reportFields(groupFields, metricFields),
        page,
        perPage: Math.min(100, params.limit - collected.length)
      });
      collected.push(...result.records);
      if (result.records.length < Math.min(100, params.limit - collected.length + result.records.length)) {
        break;
      }
      page += 1;
    }

    const buckets = new Map<string, { keys: unknown[]; rows: Array<Record<string, unknown>> }>();
    for (const record of collected) {
      const keys = groupFields.map(group => bucketValue(record, group.field, group.bucket));
      const key = JSON.stringify(keys);
      const bucket = buckets.get(key) ?? { keys, rows: [] };
      bucket.rows.push(record);
      buckets.set(key, bucket);
    }

    const rows = Array.from(buckets.values()).map(bucket => ({
      group: Object.fromEntries(groupFields.map((group, index) => [group.field.name, bucket.keys[index] ?? null])),
      metrics: Object.fromEntries(metricFields.map(metric => [metricName(metric), computeMetric(bucket.rows, metric)]))
    }));

    return {
      entity: params.entity,
      total_rows_sampled: collected.length,
      total_kind: "paginated_estimate",
      partial: collected.length >= params.limit,
      group_by: groupFields.map(group => ({ api_field: group.field.name, ui_label: group.field.label ?? null, bucket: group.bucket ?? null })),
      data: params.sortBy ? rows.sort((a, b) => String(a.group[params.sortBy!] ?? "").localeCompare(String(b.group[params.sortBy!] ?? ""))) : rows,
      note: "Freshsales aggregation is not used by this server; report rows are computed from paginated query results and partial=true means the configured limit was reached."
    };
  },
  willCallFreshsales: true
});

function reportFields(
  groupFields: Array<{ field: FreshsalesFieldDefinition }>,
  metricFields: Array<{ fieldDef?: FreshsalesFieldDefinition }>
): string[] {
  return Array.from(new Set([
    "id",
    ...groupFields.map(group => group.field.name),
    ...metricFields.map(metric => metric.fieldDef?.name).filter((field): field is string => Boolean(field))
  ]));
}

function bucketValue(record: Record<string, unknown>, field: FreshsalesFieldDefinition, bucket?: "day" | "week" | "month" | "quarter"): unknown {
  const raw = displayValueForReport(record, field);
  if (!bucket || raw === null || raw === undefined) {
    return Array.isArray(raw) ? raw.join(", ") : raw ?? null;
  }
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  const month = date.getUTCMonth() + 1;
  if (bucket === "day") return date.toISOString().slice(0, 10);
  if (bucket === "month") return `${date.getUTCFullYear()}-${String(month).padStart(2, "0")}`;
  if (bucket === "quarter") return `${date.getUTCFullYear()}-Q${Math.floor((month - 1) / 3) + 1}`;
  const weekStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
  return weekStart.toISOString().slice(0, 10);
}

function metricName(metric: { op: string; field?: string; fieldDef?: FreshsalesFieldDefinition }): string {
  return metric.op === "count" ? "count" : `${metric.op}_${metric.fieldDef?.name ?? metric.field ?? "value"}`;
}

function computeMetric(rows: Array<Record<string, unknown>>, metric: { op: "count" | "sum" | "avg" | "min" | "max"; fieldDef?: FreshsalesFieldDefinition }): number | null {
  if (metric.op === "count") {
    return rows.length;
  }
  const values = rows.map(row => Number(metric.fieldDef ? row[metric.fieldDef.name] : undefined)).filter(Number.isFinite);
  if (values.length === 0) {
    return null;
  }
  if (metric.op === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (metric.op === "avg") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (metric.op === "min") return Math.min(...values);
  return Math.max(...values);
}
