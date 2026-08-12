import { z } from "zod";

import { amountFromDeal, normalizedDealLifecycle, ownerNameFromRecord, stageNameFromDeal } from "../freshsales/mappers.js";
import { fetchFieldSchema, isFieldSchemaCacheMiss, resolveFieldAlias, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { scanView } from "../freshsales/paginatedScan.js";
import { AppError } from "../utils/errors.js";
import { normalizeMonth } from "../utils/time.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    group_by: z.string().trim().min(1).max(100).optional()
  })
  .strict();

interface PipelineSummaryParams {
  groupBy: string;
}

export const pipelineSummaryTool = defineTool({
  name: "pipeline_summary",
  title: "Pipeline Summary",
  description:
    "Preview or aggregate live Freshsales deal data by stage, owner, or month. group_by accepts supported raw API field names or UI display labels, case-insensitively. Execution scans the configured deals view page by page after approval.",
  inputSchema: schema,
  resolve(input): PipelineSummaryParams {
    if (!input.group_by) {
      throw new Error("group_by is required before approval.");
    }

    return {
      groupBy: input.group_by
    };
  },
  estimateCallCount(params, ctx) {
    const groupBy = normalizeGroupInput(params.groupBy);
    return ctx.config.pipelineSummaryMaxPages + (groupBy !== "month" && isFieldSchemaCacheMiss(ctx, "deals") ? 1 : 0);
  },
  async execute(params, ctx) {
    const perPage = 50;
    const groups = new Map<string, { count: number; total_amount: number; lifecycle_breakdown: Record<string, number> }>();
    const fieldSchema = normalizeGroupInput(params.groupBy) === "month" ? [] : await fetchFieldSchema(ctx, "deals");
    const groupResolution = resolveDealGroup(params.groupBy, fieldSchema);

    const scan = await scanView(ctx, {
      entity: "deals",
      viewId: ctx.config.defaultDealsViewId,
      perPage,
      maxPages: ctx.config.pipelineSummaryMaxPages,
      include: "owner,deal_stage",
      matches: () => true
    });

    for (const deal of scan.records) {
      const key = groupKey(groupResolution.groupBy, deal);
      const current = groups.get(key) ?? {
        count: 0,
        total_amount: 0,
        lifecycle_breakdown: {
          open: 0,
          won: 0,
          lost: 0
        }
      };

      const lifecycle = normalizedDealLifecycle(deal);
      current.count += 1;
      current.total_amount += amountFromDeal(deal);
      current.lifecycle_breakdown[lifecycle] = (current.lifecycle_breakdown[lifecycle] ?? 0) + 1;
      groups.set(key, current);
    }

    return {
      group_by: params.groupBy,
      group_api_field: groupResolution.apiField?.name ?? null,
      group_ui_label: groupResolution.apiField?.label ?? null,
      scanned_records: scan.scannedRecords,
      truncated: scan.truncated,
      groups: Array.from(groups.entries()).map(([key, value]) => ({
        key,
        count: value.count,
        total_amount: Number(value.total_amount.toFixed(2)),
        lifecycle_breakdown: value.lifecycle_breakdown
      }))
    };
  },
  willCallFreshsales: true
});

function groupKey(groupBy: "stage" | "owner" | "month", deal: Record<string, unknown>): string {
  if (groupBy === "owner") {
    return ownerNameFromRecord(deal) ?? "Unassigned";
  }

  if (groupBy === "month") {
    return normalizeMonth(String(deal.expected_close ?? deal.close_date ?? deal.created_at ?? ""));
  }

  return stageNameFromDeal(deal) ?? normalizedDealLifecycle(deal);
}

function resolveDealGroup(groupBy: string, fields: FreshsalesFieldDefinition[]): {
  groupBy: "stage" | "owner" | "month";
  apiField?: FreshsalesFieldDefinition;
} {
  const normalized = normalizeGroupInput(groupBy);
  const builtin = dealGroupAliases.get(normalized);
  if (builtin) {
    const apiField = builtin === "stage"
      ? fields.find(field => field.name === "deal_stage_id" || field.label?.trim().toLowerCase() === "stage")
      : fields.find(field => field.name === "owner_id" || field.name === "owner" || field.label?.trim().toLowerCase() === "owner");
    return { groupBy: builtin, apiField };
  }

  const resolved = resolveFieldAlias(fields, groupBy).apiField;
  if (resolved.name === "deal_stage_id" || resolved.name === "deal_stage") {
    return { groupBy: "stage", apiField: resolved };
  }

  if (resolved.name === "owner_id" || resolved.name === "owner") {
    return { groupBy: "owner", apiField: resolved };
  }

  throw new AppError("UNSUPPORTED_GROUP_BY", `Unsupported pipeline_summary group_by field: ${groupBy}. Supported groups are stage, owner, and month.`);
}

function normalizeGroupInput(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const dealGroupAliases = new Map<string, "stage" | "owner" | "month">([
  ["stage", "stage"],
  ["dealstage", "stage"],
  ["dealstageid", "stage"],
  ["owner", "owner"],
  ["ownerid", "owner"],
  ["month", "month"]
]);
