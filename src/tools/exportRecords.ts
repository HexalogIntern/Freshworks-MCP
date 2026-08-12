import { z } from "zod";

import { queryRecords, type QueryConditionInput, type QueryGroupInput } from "../freshsales/queryEngine.js";
import { approvalFields, defineTool } from "./common.js";

const conditionSchema = z.object({
  field: z.string().trim().min(1).max(120),
  operator: z.string().trim().min(1).max(40),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])), z.null()]).optional()
}).strict();

const schema = z.object({
  ...approvalFields,
  entity: z.enum(["contacts", "deals"]),
  filters: z.array(conditionSchema).max(20).default([]),
  fields: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  cursor: z.string().trim().optional(),
  per_page: z.number().int().min(1).max(100).default(100),
  detect_duplicates: z.boolean().default(false)
}).strict();

interface Params {
  entity: "contacts" | "deals";
  groups: QueryGroupInput[];
  fields: string[];
  page: number;
  perPage: number;
  detectDuplicates: boolean;
}

export const exportRecordsTool = defineTool({
  name: "export_records",
  title: "Export Records",
  description:
    "Paged export for contacts and deals. Returns requested fields with explicit nulls, resolved dropdown values where metadata is available, a continuation cursor, and optional duplicate flags for contacts by phone/email/name.",
  inputSchema: schema,
  resolve(input): Params {
    const page = input.cursor ? Number(Buffer.from(input.cursor, "base64url").toString("utf8")) : 1;
    return {
      entity: input.entity,
      groups: [{ logic: "and", conditions: input.filters as QueryConditionInput[] }],
      fields: input.fields,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      perPage: input.per_page,
      detectDuplicates: input.detect_duplicates
    };
  },
  estimateCallCount(params, ctx) {
    return 1 + (params.detectDuplicates && params.entity === "contacts" ? 1 : 0) + (ctx.config.fieldSchemaCacheTtlMs === 0 ? 1 : 0);
  },
  async execute(params, ctx) {
    const result = await queryRecords(ctx, {
      entity: params.entity,
      groups: params.groups,
      fields: params.fields,
      page: params.page,
      perPage: params.perPage
    });
    const data = params.detectDuplicates && params.entity === "contacts" ? flagDuplicates(result.records) : result.records;
    const hasNext = result.records.length === params.perPage;

    return {
      entity: params.entity,
      data,
      page: params.page,
      per_page: params.perPage,
      next_cursor: hasNext ? Buffer.from(String(params.page + 1), "utf8").toString("base64url") : null,
      total: result.total,
      total_kind: result.total_kind,
      truncated: result.truncated,
      filters_applied: result.filters_applied,
      field_guarantee: "Every requested field key is present on every row; missing upstream values are returned as null."
    };
  },
  willCallFreshsales: true
});

function flagDuplicates(records: Array<Record<string, unknown>>) {
  const phoneCounts = countBy(records, record => normalizePhone(record.mobile_number ?? record.work_number ?? record.phone));
  const nameCounts = countBy(records, record => normalizeText(record.name ?? record.display_name));
  const emailCounts = countBy(records, record => normalizeText(record.email));
  return records.map(record => ({
    ...record,
    duplicate_flags: {
      shared_phone: countFor(phoneCounts, normalizePhone(record.mobile_number ?? record.work_number ?? record.phone)) > 1,
      shared_name: countFor(nameCounts, normalizeText(record.name ?? record.display_name)) > 1,
      shared_email: countFor(emailCounts, normalizeText(record.email)) > 1
    }
  }));
}

function countBy(records: Array<Record<string, unknown>>, keyFn: (record: Record<string, unknown>) => string | null) {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = keyFn(record);
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function countFor(counts: Map<string, number>, key: string | null) {
  return key ? counts.get(key) ?? 0 : 0;
}

function normalizePhone(value: unknown): string | null {
  const phone = String(value ?? "").replace(/\D+/g, "");
  return phone.length >= 7 ? phone : null;
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  return text || null;
}
