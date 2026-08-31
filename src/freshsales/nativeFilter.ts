import { getCollection } from "./mappers.js";
import { resolveFilterValueForField, type FieldSchemaEntity, type FreshsalesFieldDefinition } from "./fieldSchema.js";
import type { ToolExecutionContext } from "../tools/common.js";
import { AppError } from "../utils/errors.js";

export interface NativeFilterCondition {
  field: FreshsalesFieldDefinition;
  value: string;
  matchMode: "exact" | "contains";
}

export interface NativeFilterResult {
  records: Array<Record<string, unknown>>;
  total: number | null;
  nativeFiltered: true;
  filterRule: Array<Record<string, unknown>>;
}

interface NativeFilterPayload {
  contacts?: unknown[];
  deals?: unknown[];
  meta?: {
    total?: unknown;
  };
}

export async function nativeFilteredSearch(
  ctx: ToolExecutionContext,
  entity: FieldSchemaEntity,
  conditions: NativeFilterCondition[],
  options: {
    page: number;
    perPage: number;
    sortField?: string;
    sortOrder?: "asc" | "desc";
  }
): Promise<NativeFilterResult> {
  if (conditions.length === 0) {
    throw new AppError("INVALID_NATIVE_FILTER", "At least one native filter condition is required.");
  }

  const filterRule = conditions.map(condition => ({
    attribute: condition.field.name,
    operator: operatorForMatchMode(condition.field, condition.matchMode),
    value: resolveFilterValueForField(condition.field, condition.value)
  }));
  const payload = await ctx.freshsales.post<NativeFilterPayload>(`api/filtered_search/${nativeEntityName(entity)}`, {
    body: {
      filter_rule: filterRule,
      page: options.page,
      per_page: options.perPage,
      sort: options.sortField,
      sort_type: options.sortField ? options.sortOrder : undefined
    }
  });

  return {
    records: getCollection(payload as Record<string, unknown>, collectionKey(entity)),
    total: numericTotal(payload.meta?.total),
    nativeFiltered: true,
    filterRule
  };
}

function nativeEntityName(entity: FieldSchemaEntity): "contact" | "deal" {
  return entity === "contacts" ? "contact" : "deal";
}

function collectionKey(entity: FieldSchemaEntity): "contacts" | "deals" {
  return entity === "contacts" ? "contacts" : "deals";
}

function operatorForMatchMode(field: FreshsalesFieldDefinition, matchMode: "exact" | "contains"): string {
  if (field.type?.toLowerCase() === "date" && matchMode === "exact") {
    return "is_in";
  }

  return matchMode === "contains" ? "contains" : "is_in";
}

function numericTotal(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
