import { z } from "zod";

import { amountFromDeal, getCollection, linkedAccountFromDeal, linkedContactFromDeal, normalizedDealLifecycle, ownerNameFromRecord, stageNameFromDeal, weightedValueFromDeal } from "../freshsales/mappers.js";
import { scanView, scanViews } from "../freshsales/paginatedScan.js";
import { dynamicRecordFromSchema, fetchFieldSchema, fieldValueFor, isFieldSchemaCacheMiss, validateFieldName, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { listDealViews, resolveDealViewId } from "../freshsales/views.js";
import { AppError } from "../utils/errors.js";
import { isIsoDate } from "../utils/time.js";
import type { ToolExecutionContext } from "./common.js";
import { approvalFields, defineTool } from "./common.js";

const stageSchema = z.enum(["open", "won", "lost"]);
const sortOrderSchema = z.enum(["asc", "desc"]);
const matchModeSchema = z.enum(["exact", "contains"]);

const schema = z
  .object({
    ...approvalFields,
    stage: stageSchema.optional(),
    view: z.string().trim().min(1).max(100).optional(),
    filter_by: z.string().trim().min(1).max(100).optional(),
    filter_value: z.string().trim().min(1).max(200).optional(),
    match_mode: matchModeSchema.default("exact"),
    sort_by: z.string().trim().min(1).max(100).optional(),
    sort_order: sortOrderSchema.default("asc"),
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
  filterBy?: string;
  filterValue?: string;
  matchMode: "exact" | "contains";
  sortBy?: string;
  sortOrder: "asc" | "desc";
  owner?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  perPage: number;
}

export const listDealsTool = defineTool({
  name: "list_deals",
  title: "List Deals",
  description:
    "Preview or list live Freshsales deals from the configured default deals view, or pass view to target any saved Freshsales view by name or id. Field output, filter_by, and sort_by are validated against Freshsales deal field metadata. Filtered queries scan up to DEALS_SCAN_MAX_PAGES pages and return scanned_records plus truncated when the scan cap is reached. match_mode defaults to exact; contains performs a case-insensitive substring match for filter_value.",
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
      filterBy: input.filter_by,
      filterValue: input.filter_value,
      matchMode: input.match_mode,
      sortBy: input.sort_by,
      sortOrder: input.sort_order,
      owner: input.owner,
      dateFrom: input.date_from,
      dateTo: input.date_to,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params, ctx) {
    const multiView = shouldScanAllViews(params);
    const scanPages = shouldScan(params) ? ctx.config.dealsScanMaxPages : 1;
    return (params.view || multiView ? 1 : 0)
      + (multiView ? scanPages * ctx.config.dealsScanMaxViews : scanPages)
      + (isFieldSchemaCacheMiss(ctx, "deals") ? 1 : 0);
  },
  async execute(params, ctx) {
    const fieldSchema = await fetchFieldSchema(ctx, "deals");
    const filterField = params.filterBy ? validateFieldName(fieldSchema, params.filterBy) : undefined;
    const sortField = params.sortBy ? validateFieldName(fieldSchema, params.sortBy) : undefined;
    const viewId = params.view
      ? await resolveDealViewId(ctx, params.view)
      : ctx.config.defaultDealsViewId;
    const nativeSort = sortField && nativeDealSortFields.has(sortField.name);

    const include = "owner,sales_account,contacts,deal_stage";
    const rawDeals = shouldScanAllViews(params)
      ? await scanViews(ctx, {
        entity: "deals",
        views: await dealViewsForScan(ctx),
        maxViews: ctx.config.dealsScanMaxViews,
        perPage: params.perPage,
        maxPages: ctx.config.dealsScanMaxPages,
        include,
        annotateMatchedView: true,
        matches: deal => matchesDeal(deal, params, filterField)
      })
      : shouldScan(params)
      ? (await scanView(ctx, {
        entity: "deals",
        viewId,
        perPage: params.perPage,
        maxPages: ctx.config.dealsScanMaxPages,
        include,
        matches: deal => matchesDeal(deal, params, filterField)
      }))
      : await fetchDealsPage(ctx, viewId, params, include, nativeSort ? sortField?.name : undefined);
    const dealsForOutput = "records" in rawDeals ? rawDeals.records : rawDeals;

    const deals = dealsForOutput
      .sort((left, right) => sortField && !nativeSort ? compareFieldValues(left, right, sortField, params.sortOrder) : 0)
      .map(deal => ({
        ...dynamicRecordFromSchema(deal, fieldSchema),
        id: deal.id ?? null,
        name: deal.name ?? null,
        amount: amountFromDeal(deal),
        weighted_value: weightedValueFromDeal(deal),
        stage: stageNameFromDeal(deal) ?? normalizedDealLifecycle(deal),
        owner: ownerNameFromRecord(deal),
        expected_close: deal.expected_close ?? deal.close_date ?? null,
        close_date: deal.close_date ?? deal.expected_close ?? null,
        linked_contact: linkedContactFromDeal(deal),
        linked_account: linkedAccountFromDeal(deal)
      }));

    return {
      data: deals,
      page: params.page,
      per_page: params.perPage,
      scanned_records: "scannedRecords" in rawDeals ? rawDeals.scannedRecords : dealsForOutput.length,
      views_scanned: "viewsScanned" in rawDeals ? rawDeals.viewsScanned : [],
      views_skipped_due_to_cap: "viewsSkippedDueToCap" in rawDeals ? rawDeals.viewsSkippedDueToCap : [],
      truncated: "truncated" in rawDeals ? rawDeals.truncated : false,
      filters_applied: {
        stage: params.stage ?? null,
        view: params.view ?? null,
        filter_by: params.filterBy ?? null,
        filter_value: params.filterValue ?? null,
        sort_by: params.sortBy ?? null,
        sort_order: params.sortBy ? params.sortOrder : null,
        sort_scope: params.sortBy ? (nativeSort ? "freshsales" : "page") : null,
        owner: params.owner ?? null,
        date_from: params.dateFrom ?? null,
        date_to: params.dateTo ?? null,
        match_mode: params.matchMode
      }
    };
  },
  willCallFreshsales: true
});

const nativeDealSortFields = new Set(["amount", "expected_close", "created_at", "updated_at", "last_contacted"]);

function shouldScan(params: ListDealsParams): boolean {
  return Boolean(params.stage || params.filterBy || params.owner || params.dateFrom || params.dateTo);
}

function shouldScanAllViews(params: ListDealsParams): boolean {
  return shouldScan(params) && !params.view;
}

async function dealViewsForScan(ctx: ToolExecutionContext) {
  const views = await listDealViews(ctx);
  return views.length > 0 ? views : [{ id: ctx.config.defaultDealsViewId, name: "Default deals view" }];
}

async function fetchDealsPage(
  ctx: ToolExecutionContext,
  viewId: string,
  params: ListDealsParams,
  include: string,
  sortField?: string
): Promise<Array<Record<string, unknown>>> {
  const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/deals/view/${viewId}`, {
    query: {
      page: params.page,
      per_page: params.perPage,
      include,
      sort: sortField,
      sort_type: sortField ? params.sortOrder : undefined
    }
  });

  return getCollection(payload, "deals");
}

function matchesStage(record: Record<string, unknown>, stage?: "open" | "won" | "lost"): boolean {
  if (!stage) {
    return true;
  }

  return normalizedDealLifecycle(record) === stage;
}

function matchesDeal(record: Record<string, unknown>, params: ListDealsParams, filterField?: FreshsalesFieldDefinition): boolean {
  return matchesStage(record, params.stage)
    && matchesDynamicFilter(record, filterField, params.filterValue, params.matchMode)
    && matchesOwner(record, params.owner)
    && matchesDateRange(record, params.dateFrom, params.dateTo);
}

function matchesDynamicFilter(
  record: Record<string, unknown>,
  field: FreshsalesFieldDefinition | undefined,
  filterValue: string | undefined,
  matchMode: "exact" | "contains"
): boolean {
  if (!field) {
    return true;
  }

  if (!filterValue) {
    throw new AppError("MISSING_FILTER_VALUE", "filter_value is required when filter_by is provided.");
  }

  const candidate = String(fieldValueFor(record, field) ?? "").toLowerCase();
  const expected = filterValue.toLowerCase();
  return matchMode === "contains" ? candidate.includes(expected) : candidate === expected;
}

function compareFieldValues(left: Record<string, unknown>, right: Record<string, unknown>, field: FreshsalesFieldDefinition, order: "asc" | "desc"): number {
  const direction = order === "asc" ? 1 : -1;
  return compareValues(fieldValueFor(left, field), fieldValueFor(right, field)) * direction;
}

function compareValues(left: unknown, right: unknown): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  const leftDate = Date.parse(String(left ?? ""));
  const rightDate = Date.parse(String(right ?? ""));
  if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) {
    return leftDate - rightDate;
  }

  return String(left ?? "").localeCompare(String(right ?? ""));
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
