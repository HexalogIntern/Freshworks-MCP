import { z } from "zod";

import { contactStatusNameForId, fetchContactStatusLookup, isContactStatusCacheMiss, type ContactStatusLookup } from "../freshsales/contactStatusCache.js";
import { fetchFieldSchema, isFieldSchemaCacheMiss, resolveFieldAlias, validateFieldName, type FieldAliasResolution, type FieldSchemaEntity, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { nativeFilteredSearch, type NativeFilterCondition } from "../freshsales/nativeFilter.js";
import { AppError } from "../utils/errors.js";
import { approvalFields, defineTool, type ToolExecutionContext } from "./common.js";

const matchModeSchema = z.enum(["exact", "contains"]);

const countSchema = z
  .object({
    ...approvalFields,
    source: z.string().trim().min(1).max(100).optional(),
    filter_by: z.string().trim().min(1).max(100).optional(),
    filter_value: z.string().trim().min(1).max(200).optional(),
    match_mode: matchModeSchema.default("exact")
  })
  .strict();

interface CountParams {
  source?: string;
  filterBy?: string;
  filterValue?: string;
  matchMode: "exact" | "contains";
}

export const countContactsTool = defineTool({
  name: "count_contacts",
  title: "Count Contacts",
  description:
    "Count Freshsales contacts with native server-side filtered_search. source and filter_by accept API field names or UI labels from live field metadata. Returns Freshsales meta.total and never performs capped view scanning.",
  inputSchema: countSchema,
  resolve(input): CountParams {
    if (!input.source && !input.filter_by) {
      throw new AppError("MISSING_FILTER", "source or filter_by is required for count_contacts.");
    }

    return {
      source: input.source,
      filterBy: input.filter_by,
      filterValue: input.filter_value,
      matchMode: input.match_mode
    };
  },
  estimateCallCount(params, ctx) {
    return 1
      + (isFieldSchemaCacheMiss(ctx, "contacts") ? 1 : 0)
      + (params.filterBy && looksLikeStatusField(params.filterBy) && isContactStatusCacheMiss(ctx) ? 1 : 0);
  },
  estimateCallCountDetails(_params, _ctx, estimatedCallCount) {
    return {
      estimated_call_count_typical: estimatedCallCount,
      estimated_call_count_worst_case: estimatedCallCount,
      estimate_note: "Counts use Freshsales filtered_search with per_page=1 and read meta.total."
    };
  },
  async execute(params, ctx) {
    return countEntity(ctx, "contacts", params);
  },
  willCallFreshsales: true
});

export const countDealsTool = defineTool({
  name: "count_deals",
  title: "Count Deals",
  description:
    "Count Freshsales deals with native server-side filtered_search. filter_by accepts API field names or UI labels from live field metadata. Returns Freshsales meta.total and never performs capped view scanning.",
  inputSchema: countSchema.omit({ source: true }),
  resolve(input): CountParams {
    if (!input.filter_by) {
      throw new AppError("MISSING_FILTER", "filter_by is required for count_deals.");
    }

    return {
      filterBy: input.filter_by,
      filterValue: input.filter_value,
      matchMode: input.match_mode
    };
  },
  estimateCallCount(_params, ctx) {
    return 1 + (isFieldSchemaCacheMiss(ctx, "deals") ? 1 : 0);
  },
  estimateCallCountDetails(_params, _ctx, estimatedCallCount) {
    return {
      estimated_call_count_typical: estimatedCallCount,
      estimated_call_count_worst_case: estimatedCallCount,
      estimate_note: "Counts use Freshsales filtered_search with per_page=1 and read meta.total."
    };
  },
  async execute(params, ctx) {
    return countEntity(ctx, "deals", params);
  },
  willCallFreshsales: true
});

async function countEntity(ctx: ToolExecutionContext, entity: FieldSchemaEntity, params: CountParams) {
  const fields = await fetchFieldSchema(ctx, entity);
  const sourceField = entity === "contacts" && params.source ? validateFieldName(fields, "source") : undefined;
  const filterResolution = params.filterBy ? resolveFieldAlias(fields, params.filterBy) : undefined;
  const contactStatusLookup = entity === "contacts" && filterResolution?.apiField.name === "contact_status_id"
    ? await fetchContactStatusLookup(ctx)
    : undefined;
  const conditions = countConditions({
    sourceField,
    source: params.source,
    filterResolution,
    filterValue: params.filterValue,
    matchMode: params.matchMode,
    contactStatusLookup
  });
  const result = await nativeFilteredSearch(ctx, entity, conditions, {
    page: 1,
    perPage: 1
  });

  return {
    total: result.total ?? result.records.length,
    native_filtered: true,
    partial: result.total === null,
    filter_by: params.filterBy ?? null,
    filter_api_field: filterResolution?.apiField.name ?? null,
    filter_ui_label: filterResolution?.apiField.label ?? null,
    filter_value: params.filterValue ?? null,
    source: params.source ?? null,
    match_mode: params.matchMode,
    native_filter_rule: result.filterRule
  };
}

function countConditions(filters: {
  sourceField?: FreshsalesFieldDefinition;
  source?: string;
  filterResolution?: FieldAliasResolution;
  filterValue?: string;
  matchMode: "exact" | "contains";
  contactStatusLookup?: ContactStatusLookup;
}): NativeFilterCondition[] {
  const conditions: NativeFilterCondition[] = [];
  if (filters.sourceField && filters.source) {
    conditions.push({ field: filters.sourceField, value: filters.source, matchMode: filters.matchMode });
  }

  if (filters.filterResolution) {
    if (!filters.filterValue) {
      throw new AppError("MISSING_FILTER_VALUE", "filter_value is required when filter_by is provided.");
    }

    const field = filters.filterResolution.apiField;
    const value = field.name === "contact_status_id"
      ? contactStatusIdForName(filters.contactStatusLookup, filters.filterValue) ?? filters.filterValue
      : filters.filterValue;
    conditions.push({ field, value, matchMode: filters.matchMode });
  }

  return conditions;
}

function contactStatusIdForName(lookup: ContactStatusLookup | undefined, name: string): string | null {
  if (!lookup) {
    return null;
  }

  const normalized = name.trim().toLowerCase();
  for (const [id, statusName] of lookup.idToName.entries()) {
    if (statusName.trim().toLowerCase() === normalized) {
      return id;
    }
  }

  return null;
}

function looksLikeStatusField(field: string): boolean {
  const normalized = field.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "status" || normalized === "contactstatus" || normalized === "contactstatusid";
}
