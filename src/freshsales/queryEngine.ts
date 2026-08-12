import { getCollection, getPrimaryRecord, noteSummary } from "./mappers.js";
import {
  choiceDisplayValue,
  dynamicRecordFromSchema,
  fetchFieldSchema,
  fieldValueFor,
  isChoiceBackedField,
  mergeIncludes,
  relationIncludeForField,
  resolveChoiceValueForField,
  resolveFieldAlias,
  type FieldSchemaEntity,
  type FreshsalesFieldDefinition
} from "./fieldSchema.js";
import type { ToolExecutionContext } from "../tools/common.js";
import { AppError } from "../utils/errors.js";

export type QueryOperator =
  | "is"
  | "equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "is_in"
  | "not_in"
  | "contains_any"
  | "contains_all"
  | "is_null"
  | "is_not_null"
  | "between"
  | "before"
  | "after"
  | "in_the_last_N_days"
  | "in_the_next_N_days"
  | "greater_than"
  | "less_than"
  | "is_true"
  | "is_false";

export interface QueryConditionInput {
  field: string;
  operator: QueryOperator;
  value?: string | number | boolean | Array<string | number | boolean> | null;
}

export interface QueryGroupInput {
  logic: "and" | "or";
  conditions: QueryConditionInput[];
}

export interface ResolvedCondition {
  requested_field: string;
  api_field: string;
  ui_label: string | null;
  type: string | null;
  operator: QueryOperator;
  value: unknown;
  resolved_value: unknown;
  native_rule: Record<string, unknown> | null;
}

export interface QueryRecordsOptions {
  entity: FieldSchemaEntity;
  groups: QueryGroupInput[];
  query?: string;
  page: number;
  perPage: number;
  includeNotes?: boolean;
  includeLinked?: boolean;
  fields?: string[];
}

export interface QueryRecordsResult {
  records: Array<Record<string, unknown>>;
  total: number | null;
  total_kind: "native" | "merged" | "paginated_estimate";
  filters_applied: ResolvedCondition[];
  native_filter_rules: Array<Array<Record<string, unknown>>>;
  page: number;
  per_page: number;
  truncated: boolean;
}

interface NativeFilterPayload {
  contacts?: unknown[];
  deals?: unknown[];
  meta?: {
    total?: unknown;
  };
}

export async function queryRecords(
  ctx: ToolExecutionContext,
  options: QueryRecordsOptions
): Promise<QueryRecordsResult> {
  const schema = await fetchFieldSchema(ctx, options.entity);
  const groups = normalizeGroups(options.groups);
  const resolvedGroups = groups.map(group => ({
    logic: group.logic,
    conditions: group.conditions.map(condition => resolveCondition(schema, condition))
  }));

  const include = mergeIncludes(
    options.entity === "contacts" ? "owner,sales_account,sales_accounts" : "owner,sales_account,contacts,deal_stage",
    ...resolvedGroups.flatMap(group => group.conditions.map(condition => relationIncludeForField(condition.field.name))),
    options.includeNotes ? "notes" : null
  );

  const canUseOneNativeQuery = resolvedGroups.length === 0
    || (resolvedGroups.length === 1 && resolvedGroups[0]?.logic === "and" && resolvedGroups[0].conditions.every(canRunNatively));
  if (canUseOneNativeQuery) {
    const native = resolvedGroups[0]?.conditions ?? [];
    const payload = native.length > 0
      ? await postFilteredSearch(ctx, options.entity, native.map(condition => condition.nativeRule), options.page, options.perPage)
      : null;
    const unfiltered = native.length === 0
      ? await getEntityPage(ctx, options.entity, options.page, options.perPage, include)
      : null;
    const raw = payload ? getCollection(payload as Record<string, unknown>, collectionKey(options.entity)) : unfiltered?.records ?? [];
    const total = payload ? numericTotal(payload.meta?.total) : null;
    const filtered = applyClientSideSearch(raw, schema, options.query);
    const enriched = await enrichRecords(ctx, options, schema, filtered);

    return {
      records: selectFields(enriched, schema, options.fields),
      total: options.query ? filtered.length : total,
      total_kind: options.query ? "paginated_estimate" : (native.length > 0 ? "native" : "paginated_estimate"),
      filters_applied: resolvedGroups.flatMap(group => group.conditions.map(toResolvedCondition)),
      native_filter_rules: native.length > 0 ? [native.map(condition => condition.nativeRule)] : [],
      page: options.page,
      per_page: options.perPage,
      truncated: false
    };
  }

  const nativeGroups = resolvedGroups.flatMap(group => group.logic === "or"
    ? group.conditions.map(condition => [condition])
    : [group.conditions]);
  if (nativeGroups.some(group => group.some(condition => !canRunNatively(condition)))) {
    throw new AppError("UNSUPPORTED_FILTER_OPERATOR", "This filter combination contains an operator Freshsales cannot execute natively and would require an unbounded scan.");
  }

  const pages = await Promise.all(nativeGroups.map(group => postFilteredSearch(ctx, options.entity, group.map(condition => condition.nativeRule), 1, options.perPage)));
  const byId = new Map<string, Record<string, unknown>>();
  let truncated = false;
  for (const payload of pages) {
    const records = getCollection(payload as Record<string, unknown>, collectionKey(options.entity));
    for (const record of records) {
      const id = String(record.id ?? "");
      if (id) {
        byId.set(id, record);
      }
    }
    truncated ||= records.length >= options.perPage;
  }

  const raw = Array.from(byId.values()).slice((options.page - 1) * options.perPage, options.page * options.perPage);
  const filtered = applyClientSideSearch(raw, schema, options.query);
  const enriched = await enrichRecords(ctx, options, schema, filtered);

  return {
    records: selectFields(enriched, schema, options.fields),
    total: byId.size,
    total_kind: "merged",
    filters_applied: resolvedGroups.flatMap(group => group.conditions.map(toResolvedCondition)),
    native_filter_rules: nativeGroups.map(group => group.map(condition => condition.nativeRule)),
    page: options.page,
    per_page: options.perPage,
    truncated
  };
}

export function outputRecord(record: Record<string, unknown>, schema: FreshsalesFieldDefinition[]): Record<string, unknown> {
  return {
    ...dynamicRecordFromSchema(record, schema),
    id: record.id ?? null,
    name: record.name ?? record.display_name ?? null
  };
}

export function displayValueForReport(record: Record<string, unknown>, field: FreshsalesFieldDefinition): unknown {
  const raw = fieldValueFor(record, field);
  if (Array.isArray(raw)) {
    return raw.map(value => choiceDisplayValue(field, value));
  }
  return choiceDisplayValue(field, raw);
}

function normalizeGroups(groups: QueryGroupInput[]): QueryGroupInput[] {
  return groups.filter(group => group.conditions.length > 0);
}

function resolveCondition(schema: FreshsalesFieldDefinition[], input: QueryConditionInput) {
  const field = resolveFieldAlias(schema, input.field).apiField;
  validateOperatorForType(field, input.operator);
  const resolvedValue = resolveValue(field, input.operator, input.value);
  return {
    input,
    field,
    resolvedValue,
    nativeRule: nativeRule(field, input.operator, resolvedValue)
  };
}

function validateOperatorForType(field: FreshsalesFieldDefinition, operator: QueryOperator): void {
  const type = field.type?.toLowerCase() ?? "text";
  const textOps = new Set<QueryOperator>(["is", "equals", "contains", "not_contains", "starts_with", "is_null", "is_not_null"]);
  const choiceOps = new Set<QueryOperator>(["is", "equals", "is_in", "not_in", "is_null", "is_not_null"]);
  const multiOps = new Set<QueryOperator>(["is", "equals", "is_in", "not_in", "contains_any", "contains_all", "is_null", "is_not_null"]);
  const dateOps = new Set<QueryOperator>(["is", "equals", "between", "before", "after", "in_the_last_N_days", "in_the_next_N_days", "is_null", "is_not_null"]);
  const numberOps = new Set<QueryOperator>(["is", "equals", "greater_than", "less_than", "between", "is_null", "is_not_null"]);
  const booleanOps = new Set<QueryOperator>(["is_true", "is_false", "is_null", "is_not_null"]);

  const allowed = type === "dropdown" ? choiceOps
    : type === "multi_select_dropdown" ? multiOps
    : type === "date" ? dateOps
    : type === "number" ? numberOps
    : type === "checkbox" || type === "boolean" ? booleanOps
    : textOps;
  if (!allowed.has(operator)) {
    throw new AppError("INVALID_FILTER_OPERATOR", `${operator} is not supported for ${field.name} (${type}).`);
  }
}

function resolveValue(field: FreshsalesFieldDefinition, operator: QueryOperator, value: unknown): unknown {
  if (operator === "is_null" || operator === "is_not_null" || operator === "is_true" || operator === "is_false") {
    return null;
  }
  if (value === undefined || value === null) {
    throw new AppError("MISSING_FILTER_VALUE", `${operator} requires a value for ${field.name}.`);
  }
  const values = Array.isArray(value) ? value : [value];
  const resolved = isChoiceBackedField(field)
    ? values.map(item => resolveChoiceValueForField(field, String(item)))
    : values;
  return Array.isArray(value) || operator.endsWith("_in") || operator === "between" || operator.startsWith("contains_") ? resolved : resolved[0];
}

function nativeRule(field: FreshsalesFieldDefinition, operator: QueryOperator, value: unknown): Record<string, unknown> {
  return {
    attribute: field.name,
    operator: nativeOperator(operator),
    value
  };
}

function nativeOperator(operator: QueryOperator): string {
  const map: Partial<Record<QueryOperator, string>> = {
    is: "is_in",
    equals: "is_in",
    contains: "contains",
    is_in: "is_in",
    contains_any: "is_in",
    is_null: "is_empty",
    is_not_null: "is_not_empty",
    before: "less_than",
    after: "greater_than",
    greater_than: "greater_than",
    less_than: "less_than",
    between: "between",
    is_true: "is",
    is_false: "is"
  };
  return map[operator] ?? operator;
}

function canRunNatively(condition: ReturnType<typeof resolveCondition>): boolean {
  return !["not_contains", "starts_with", "not_in", "contains_all", "in_the_last_N_days", "in_the_next_N_days"].includes(condition.input.operator);
}

async function postFilteredSearch(
  ctx: ToolExecutionContext,
  entity: FieldSchemaEntity,
  filterRule: Array<Record<string, unknown>>,
  page: number,
  perPage: number
): Promise<NativeFilterPayload> {
  return ctx.freshsales.post<NativeFilterPayload>(`api/filtered_search/${entity === "contacts" ? "contact" : "deal"}`, {
    body: {
      filter_rule: filterRule,
      page,
      per_page: perPage
    }
  });
}

async function getEntityPage(ctx: ToolExecutionContext, entity: FieldSchemaEntity, page: number, perPage: number, include: string) {
  const viewId = entity === "contacts" ? ctx.config.defaultContactsViewId : ctx.config.defaultDealsViewId;
  const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/${entity}/view/${viewId}`, {
    query: { page, per_page: perPage, include }
  });
  return { records: getCollection(payload, collectionKey(entity)) };
}

async function enrichRecords(
  ctx: ToolExecutionContext,
  options: QueryRecordsOptions,
  schema: FreshsalesFieldDefinition[],
  records: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(records.map(async record => {
    const base = outputRecord(record, schema);
    const id = record.id;
    const notes = options.includeNotes && id !== undefined && id !== null
      ? await fetchNotes(ctx, options.entity, String(id))
      : null;
    return {
      ...base,
      ...(notes ? { note_count: notes.length, most_recent_note: notes[0] ?? null } : {}),
      ...(options.includeLinked ? await fetchLinked(ctx, options.entity, record) : {})
    };
  }));
}

async function fetchNotes(ctx: ToolExecutionContext, entity: FieldSchemaEntity, id: string) {
  const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/${entity}/${id}`, { query: { include: "notes" } });
  const record = getPrimaryRecord(payload, entity === "contacts" ? "contact" : "deal");
  return getCollection(record, "notes").map(noteSummary);
}

async function fetchLinked(ctx: ToolExecutionContext, entity: FieldSchemaEntity, record: Record<string, unknown>) {
  if (entity === "deals") {
    return { linked_contacts: record.contacts ?? null, linked_account: record.sales_account ?? null };
  }
  const id = record.id;
  if (id === undefined || id === null) {
    return { linked_deals: [] };
  }
  const payload = await ctx.freshsales.get<Record<string, unknown>>("api/deals", {
    query: { contact_id: String(id), per_page: 100 }
  });
  return { linked_deals: getCollection(payload, "deals") };
}

function applyClientSideSearch(records: Array<Record<string, unknown>>, schema: FreshsalesFieldDefinition[], query?: string) {
  if (!query) {
    return records;
  }
  const needle = query.toLowerCase();
  return records.filter(record => Object.values(outputRecord(record, schema)).some(value => String(value ?? "").toLowerCase().includes(needle)));
}

function selectFields(records: Array<Record<string, unknown>>, schema: FreshsalesFieldDefinition[], requested?: string[]) {
  if (!requested || requested.length === 0) {
    return records;
  }
  const fields = requested.map(field => resolveFieldAlias(schema, field).apiField.name);
  return records.map(record => {
    const out: Record<string, unknown> = { id: record.id ?? null };
    for (const field of fields) {
      out[field] = Object.prototype.hasOwnProperty.call(record, field) ? record[field] : null;
    }
    return out;
  });
}

function toResolvedCondition(condition: ReturnType<typeof resolveCondition>): ResolvedCondition {
  return {
    requested_field: condition.input.field,
    api_field: condition.field.name,
    ui_label: condition.field.label ?? null,
    type: condition.field.type ?? null,
    operator: condition.input.operator,
    value: condition.input.value ?? null,
    resolved_value: condition.resolvedValue,
    native_rule: canRunNatively(condition) ? condition.nativeRule : null
  };
}

function collectionKey(entity: FieldSchemaEntity): "contacts" | "deals" {
  return entity === "contacts" ? "contacts" : "deals";
}

function numericTotal(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}
