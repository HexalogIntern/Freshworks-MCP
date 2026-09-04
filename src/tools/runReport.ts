import { z } from "zod";

import { isContactStatusCacheMiss } from "../freshsales/contactStatusCache.js";
import { cachedFieldSchema, fetchFieldSchema, hydrateEntityChoiceLookups, resolveChoiceValueForField, resolveFieldAlias, type FieldSchemaEntity, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { countRecordsNatively, displayValueForReport, queryRecords, type QueryConditionInput, type QueryGroupInput } from "../freshsales/queryEngine.js";
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
  max_group_values: z.number().int().min(1).max(500).default(100),
  sort_by: z.string().trim().min(1).max(120).optional()
}).strict();

export interface RunReportParams {
  entity: FieldSchemaEntity;
  groups: QueryGroupInput[];
  groupBy: Array<{ field: string; bucket?: "day" | "week" | "month" | "quarter" }>;
  metrics: Array<{ op: "count" | "sum" | "avg" | "min" | "max"; field?: string }>;
  limit: number;
  maxGroupValues: number;
  sortBy?: string;
}

export const runReportTool = defineTool({
  name: "run_report",
  title: "Run Report",
  description:
    "Reusable Freshsales reporting tool for contacts and deals. Filters are field-agnostic; group_by accepts any discovered dropdown, multi-select, or date field with optional date bucketing. Supports two-dimensional cross-tabs and count/sum/avg/min/max numeric metrics. Results are flagged when based on a paginated fallback.",
  inputSchema: schema,
  resolve(input): RunReportParams {
    return {
      entity: input.entity,
      groups: [{ logic: "and", conditions: input.filters as QueryConditionInput[] }],
      groupBy: input.group_by,
      metrics: input.metrics,
      limit: input.limit,
      maxGroupValues: input.max_group_values,
      sortBy: input.sort_by
    };
  },
  estimateCallCount(params, ctx) {
    const cached = cachedFieldSchema(ctx, params.entity);
    const choiceLookupCalls = needsContactStatusLookup(params) && isContactStatusCacheMiss(ctx) ? 1 : 0;
    if (canUseNativeAggregationShape(params) && cached) {
      try {
        const groupFields = params.groupBy.map(group => resolveFieldAlias(cached, group.field).apiField);
        return choiceLookupCalls + Math.max(1, groupValueCombinations(groupFields, params.maxGroupValues, params.groups).values.length);
      } catch {
        return choiceLookupCalls + 1 + Math.min(params.maxGroupValues, params.limit);
      }
    }

    if (canUseNativeAggregationShape(params)) {
      return choiceLookupCalls + 1 + Math.min(params.maxGroupValues, params.limit);
    }

    return choiceLookupCalls + Math.ceil(params.limit / 100) + (ctx.config.fieldSchemaCacheTtlMs === 0 ? 1 : 0);
  },
  estimateCallCountDetails(params, ctx, estimatedCallCount) {
    return {
      estimated_call_count_typical: estimatedCallCount,
      estimate_note: canUseNativeAggregationShape(params)
        ? "Count-only grouped reports use one Freshsales filtered_search count per group value when group_by fields have finite dropdown choices. Actual calls are reported in _meta after execution."
        : "Non-count metrics or unsupported grouping fall back to paginated records. Actual calls are reported in _meta after execution.",
      field_schema_cache_hit: cachedFieldSchema(ctx, params.entity) !== null
    };
  },
  async execute(params, ctx) {
    const schema = await fetchFieldSchema(ctx, params.entity);
    await hydrateEntityChoiceLookups(ctx, params.entity, schema, [
      ...params.groupBy.map(group => group.field),
      ...params.groups.flatMap(group => group.conditions.map(condition => condition.field)),
      ...params.metrics.map(metric => metric.field).filter((field): field is string => Boolean(field))
    ]);
    const groupFields = params.groupBy.map(group => ({ ...group, field: resolveFieldAlias(schema, group.field).apiField }));
    const metricFields = params.metrics.map(metric => ({
      ...metric,
      fieldDef: metric.field ? resolveFieldAlias(schema, metric.field).apiField : undefined
    }));

    if (canUseNativeAggregation(groupFields, metricFields)) {
      try {
        const rows = await nativeCountRows(ctx, params, groupFields);
        return {
          entity: params.entity,
          total_rows_sampled: 0,
          total_kind: "native_aggregation",
          partial: rows.partial,
          aggregation_strategy: "filtered_search_count_per_group_value",
          group_by: groupFields.map(group => ({ api_field: group.field.name, ui_label: group.field.label ?? null, bucket: group.bucket ?? null })),
          data: params.sortBy ? rows.data.sort((a, b) => String(a.group[params.sortBy!] ?? "").localeCompare(String(b.group[params.sortBy!] ?? ""))) : rows.data,
          note: rows.partial
            ? `Native aggregation was capped at max_group_values=${params.maxGroupValues}; increase max_group_values for more dropdown combinations.`
            : "Freshsales native filtered_search totals were used; no raw record pagination was performed."
        };
      } catch (error) {
        ctx.logger.warn("run_report_native_aggregation_fallback", {
          code: error instanceof Error && "code" in error ? (error as { code?: unknown }).code : "UNKNOWN"
        });
      }
    }

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
      aggregation_strategy: "paginated_client_aggregation",
      note: "This report shape is not supported by the native count path; rows are computed from paginated query results and partial=true means the configured limit was reached."
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

function canUseNativeAggregationShape(params: RunReportParams): boolean {
  return params.groupBy.length > 0 && params.groupBy.length <= 2 && params.metrics.every(metric => metric.op === "count");
}

function needsContactStatusLookup(params: RunReportParams): boolean {
  if (params.entity !== "contacts") {
    return false;
  }

  const requestedFields = [
    ...params.groupBy.map(group => group.field),
    ...params.groups.flatMap(group => group.conditions.map(condition => condition.field)),
    ...params.metrics.map(metric => metric.field).filter((field): field is string => Boolean(field))
  ];
  return requestedFields.some(field => field.trim().toLowerCase().replace(/[\s_-]+/g, "") === "status");
}

function canUseNativeAggregation(
  groupFields: Array<{ field: FreshsalesFieldDefinition; bucket?: "day" | "week" | "month" | "quarter" }>,
  metricFields: Array<{ op: "count" | "sum" | "avg" | "min" | "max"; fieldDef?: FreshsalesFieldDefinition }>
): boolean {
  return groupFields.length > 0
    && groupFields.length <= 2
    && metricFields.every(metric => metric.op === "count")
    && groupFields.every(group => !group.bucket && Object.keys(group.field.choiceLabelById ?? {}).length > 0);
}

async function nativeCountRows(
  ctx: Parameters<typeof countRecordsNatively>[0],
  params: RunReportParams,
  groupFields: Array<{ field: FreshsalesFieldDefinition }>
): Promise<{
  partial: boolean;
  data: Array<{
    group: Record<string, unknown>;
    metrics: Record<string, number | null>;
    native_filter_rule: Array<Record<string, unknown>>;
  }>;
}> {
  const combinations = groupValueCombinations(groupFields.map(group => group.field), params.maxGroupValues, params.groups);
  const capped = combinations.values.slice(0, params.limit);
  const data = await Promise.all(capped.map(async combination => {
    const extraRules = combination.map(({ field, choiceId }) => ({
      attribute: field.name,
      operator: "is_in",
      value: choiceId
    }));
    const result = await countRecordsNatively(ctx, {
      entity: params.entity,
      groups: params.groups,
      extraRules
    });

    return {
      group: Object.fromEntries(combination.map(({ field, label }) => [field.name, label])),
      metrics: { count: result.total },
      native_filter_rule: result.native_filter_rules[0] ?? extraRules
    };
  }));

  return {
    partial: combinations.partial || combinations.values.length > capped.length,
    data
  };
}

function groupValueCombinations(
  groupFields: FreshsalesFieldDefinition[],
  maxGroupValues: number,
  groups: QueryGroupInput[] = []
): {
  partial: boolean;
  values: Array<Array<{ field: FreshsalesFieldDefinition; choiceId: string; label: string }>>;
} {
  let partial = false;
  const values = groupFields.reduce<Array<Array<{ field: FreshsalesFieldDefinition; choiceId: string; label: string }>>>((combinations, field) => {
    const allChoices = filteredGroupChoices(field, groups) ?? Object.entries(field.choiceLabelById ?? {});
    const choices = allChoices.slice(0, maxGroupValues);
    partial ||= allChoices.length > choices.length;
    if (choices.length === 0) {
      return [];
    }

    return combinations.flatMap(combination => choices.map(([choiceId, label]) => [...combination, { field, choiceId, label }]));
  }, [[]]);
  partial ||= values.length > maxGroupValues;

  return {
    partial,
    values: values.slice(0, maxGroupValues)
  };
}

function filteredGroupChoices(field: FreshsalesFieldDefinition, groups: QueryGroupInput[]): Array<[string, string]> | null {
  if (groups.length !== 1 || groups[0]?.logic !== "and") {
    return null;
  }

  const condition = groups[0].conditions.find(item => {
    try {
      return resolveFieldAlias([field], item.field).apiField.name === field.name;
    } catch {
      return false;
    }
  });
  if (!condition || !["is", "equals", "is_in"].includes(condition.operator)) {
    return null;
  }

  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  const choices = values
    .filter((value): value is string | number | boolean => value !== undefined && value !== null)
    .map(value => {
      const choiceId = String(resolveChoiceValueForField(field, String(value)));
      const label = field.choiceLabelById?.[choiceId] ?? String(value);
      return [choiceId, label] as [string, string];
    });

  return choices.length > 0 ? choices : null;
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
