import { z } from "zod";

import { amountFromDeal, getCollection, normalizedDealLifecycle, ownerNameFromRecord, stageNameFromDeal } from "../freshsales/mappers.js";
import { normalizeMonth } from "../utils/time.js";
import { approvalFields, defineTool } from "./common.js";

const groupBySchema = z.enum(["stage", "owner", "month"]);

const schema = z
  .object({
    ...approvalFields,
    group_by: groupBySchema.optional()
  })
  .strict();

interface PipelineSummaryParams {
  groupBy: "stage" | "owner" | "month";
}

export const pipelineSummaryTool = defineTool({
  name: "pipeline_summary",
  title: "Pipeline Summary",
  description:
    "Preview or aggregate live Freshsales deal data by stage, owner, or month. Execution scans the configured deals view page by page after approval.",
  inputSchema: schema,
  resolve(input): PipelineSummaryParams {
    if (!input.group_by) {
      throw new Error("group_by is required before approval.");
    }

    return {
      groupBy: input.group_by
    };
  },
  estimateCallCount(_params, ctx) {
    return ctx.config.pipelineSummaryMaxPages;
  },
  async execute(params, ctx) {
    const perPage = 50;
    const groups = new Map<string, { count: number; total_amount: number; lifecycle_breakdown: Record<string, number> }>();
    let scannedRecords = 0;
    let truncated = false;

    for (let page = 1; page <= ctx.config.pipelineSummaryMaxPages; page += 1) {
      const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/deals/view/${ctx.config.defaultDealsViewId}`, {
        query: {
          page,
          per_page: perPage,
          include: "owner,deal_stage"
        }
      });

      const deals = getCollection(payload, "deals");
      if (deals.length === 0) {
        break;
      }

      for (const deal of deals) {
        scannedRecords += 1;
        const key = groupKey(params.groupBy, deal);
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

      if (deals.length < perPage) {
        break;
      }

      if (page === ctx.config.pipelineSummaryMaxPages) {
        truncated = true;
      }
    }

    return {
      group_by: params.groupBy,
      scanned_records: scannedRecords,
      truncated,
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

function groupKey(groupBy: PipelineSummaryParams["groupBy"], deal: Record<string, unknown>): string {
  if (groupBy === "owner") {
    return ownerNameFromRecord(deal) ?? "Unassigned";
  }

  if (groupBy === "month") {
    return normalizeMonth(String(deal.expected_close ?? deal.close_date ?? deal.created_at ?? ""));
  }

  return stageNameFromDeal(deal) ?? normalizedDealLifecycle(deal);
}
