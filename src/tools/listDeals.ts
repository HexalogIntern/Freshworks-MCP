import { z } from "zod";

import { amountFromDeal, getCollection, linkedAccountFromDeal, linkedContactFromDeal, normalizedDealLifecycle, ownerNameFromRecord, stageNameFromDeal } from "../freshsales/mappers.js";
import { AppError } from "../utils/errors.js";
import { isIsoDate } from "../utils/time.js";
import type { ToolExecutionContext } from "./common.js";
import { approvalFields, defineTool } from "./common.js";

const stageSchema = z.enum(["open", "won", "lost"]);

const schema = z
  .object({
    ...approvalFields,
    stage: stageSchema.optional(),
    view: z.string().trim().min(1).max(100).optional(),
    owner: z.string().trim().min(1).max(100).optional(),
    date_from: z.string().trim().optional(),
    date_to: z.string().trim().optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface ListDealsParams {
  stage?: "open" | "won" | "lost";
  view?: string;
  owner?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  perPage: number;
}

interface FilterPayload {
  filters?: Array<{ id?: string | number; name?: string }>;
}

export const listDealsTool = defineTool({
  name: "list_deals",
  title: "List Deals",
  description:
    "Preview or list live Freshsales deals from the configured default deals view, or pass view to target any saved Freshsales view by name or id. Stage is normalized to open, won, or lost before approval.",
  inputSchema: schema,
  resolve(input): ListDealsParams {
    if (input.date_from && !isIsoDate(input.date_from)) {
      throw new AppError("INVALID_DATE", "date_from must be a valid ISO date or datetime.");
    }

    if (input.date_to && !isIsoDate(input.date_to)) {
      throw new AppError("INVALID_DATE", "date_to must be a valid ISO date or datetime.");
    }

    return {
      stage: input.stage,
      view: input.view,
      owner: input.owner,
      dateFrom: input.date_from,
      dateTo: input.date_to,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params) {
    return params.view ? 2 : 1;
  },
  async execute(params, ctx) {
    const viewId = params.view
      ? await resolveDealViewId(ctx, params.view)
      : ctx.config.defaultDealsViewId;

    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/deals/view/${viewId}`, {
      query: {
        page: params.page,
        per_page: params.perPage,
        include: "owner,sales_account,contacts,deal_stage"
      }
    });

    const deals = getCollection(payload, "deals")
      .filter(deal => matchesStage(deal, params.stage))
      .filter(deal => matchesOwner(deal, params.owner))
      .filter(deal => matchesDateRange(deal, params.dateFrom, params.dateTo))
      .map(deal => ({
        id: deal.id ?? null,
        name: deal.name ?? null,
        amount: amountFromDeal(deal),
        stage: stageNameFromDeal(deal) ?? normalizedDealLifecycle(deal),
        owner: ownerNameFromRecord(deal),
        expected_close: deal.expected_close ?? deal.close_date ?? null,
        linked_contact: linkedContactFromDeal(deal),
        linked_account: linkedAccountFromDeal(deal)
      }));

    return {
      data: deals,
      page: params.page,
      per_page: params.perPage,
      filters_applied: {
        stage: params.stage ?? null,
        view: params.view ?? null,
        owner: params.owner ?? null,
        date_from: params.dateFrom ?? null,
        date_to: params.dateTo ?? null
      }
    };
  },
  willCallFreshsales: true
});

async function resolveDealViewId(ctx: ToolExecutionContext, view: string): Promise<string> {
  const payload = await ctx.freshsales.get<FilterPayload>("api/deals/filters");
  const matched = payload.filters?.find(candidate => {
    const id = candidate.id !== undefined ? String(candidate.id) : "";
    const name = candidate.name?.toLowerCase() ?? "";
    return id === view || name === view.toLowerCase();
  });

  if (!matched?.id) {
    throw new AppError("INVALID_FILTER", `Unknown Freshsales deal filter: ${view}.`);
  }

  return String(matched.id);
}

function matchesStage(record: Record<string, unknown>, stage?: "open" | "won" | "lost"): boolean {
  if (!stage) {
    return true;
  }

  return normalizedDealLifecycle(record) === stage;
}

function matchesOwner(record: Record<string, unknown>, owner?: string): boolean {
  if (!owner) {
    return true;
  }

  const haystacks = [ownerNameFromRecord(record), String(record.owner_id ?? "")].map(value => value?.toLowerCase() ?? "");
  return haystacks.some(candidate => candidate === owner.toLowerCase());
}

function matchesDateRange(record: Record<string, unknown>, dateFrom?: string, dateTo?: string): boolean {
  const raw = String(record.expected_close ?? record.close_date ?? "");
  if (!raw) {
    return !dateFrom && !dateTo;
  }

  const timestamp = new Date(raw).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }

  if (dateFrom && timestamp < new Date(dateFrom).getTime()) {
    return false;
  }

  if (dateTo && timestamp > new Date(dateTo).getTime()) {
    return false;
  }

  return true;
}
