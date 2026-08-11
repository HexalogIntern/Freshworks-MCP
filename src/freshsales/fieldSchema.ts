import type { ToolExecutionContext } from "../tools/common.js";
import { AppError } from "../utils/errors.js";

export type FieldSchemaEntity = "contacts" | "deals";

export interface FreshsalesFieldDefinition {
  id?: string | number;
  label?: string;
  name: string;
  type?: string;
  default?: boolean;
  choices?: unknown[];
}

interface FieldSchemaPayload {
  fields?: unknown[];
}

interface FieldSchemaCacheEntry {
  expiresAt: number;
  fields: FreshsalesFieldDefinition[];
}

const cache = new Map<FieldSchemaEntity, FieldSchemaCacheEntry>();

export function isFieldSchemaCacheMiss(ctx: ToolExecutionContext, entity: FieldSchemaEntity): boolean {
  const cached = cache.get(entity);
  return !cached || Date.now() >= cached.expiresAt || ctx.config.fieldSchemaCacheTtlMs === 0;
}

export function clearFieldSchemaCache(): void {
  cache.clear();
}

export async function fetchFieldSchema(
  ctx: ToolExecutionContext,
  entity: FieldSchemaEntity,
  options: { forceRefresh?: boolean } = {}
): Promise<FreshsalesFieldDefinition[]> {
  const cached = cache.get(entity);
  if (!options.forceRefresh && cached && Date.now() < cached.expiresAt && ctx.config.fieldSchemaCacheTtlMs !== 0) {
    return cached.fields;
  }

  const payload = await ctx.freshsales.get<FieldSchemaPayload>(`api/settings/${entity}/fields`);
  const fields = Array.isArray(payload.fields)
    ? payload.fields.map(normalizeFieldDefinition).filter((field): field is FreshsalesFieldDefinition => field !== null)
    : [];

  cache.set(entity, {
    fields,
    expiresAt: Date.now() + ctx.config.fieldSchemaCacheTtlMs
  });

  return fields;
}

export function dynamicRecordFromSchema(
  record: Record<string, unknown>,
  fields: FreshsalesFieldDefinition[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const customField = asRecord(record.custom_field);

  for (const field of fields) {
    output[field.name] = resolveFieldValue(record, customField, field.name);
  }

  return output;
}

export function validateFieldName(fields: FreshsalesFieldDefinition[], requested: string): FreshsalesFieldDefinition {
  const normalized = normalizeName(requested);
  const matched = fields.find(field => {
    return normalizeName(field.name) === normalized || normalizeName(field.label) === normalized;
  });

  if (matched) {
    return matched;
  }

  const matches = closestFieldMatches(fields, requested);
  const suffix = matches.length > 0 ? ` Did you mean: ${matches.join(", ")}?` : "";
  throw new AppError("UNKNOWN_FIELD", `Unknown Freshsales field: ${requested}.${suffix}`);
}

export function fieldValueFor(record: Record<string, unknown>, field: FreshsalesFieldDefinition): unknown {
  return resolveFieldValue(record, asRecord(record.custom_field), field.name);
}

function resolveFieldValue(
  record: Record<string, unknown>,
  customField: Record<string, unknown>,
  fieldName: string
): unknown {
  if (Object.prototype.hasOwnProperty.call(record, fieldName)) {
    return record[fieldName];
  }

  if (Object.prototype.hasOwnProperty.call(customField, fieldName)) {
    return customField[fieldName];
  }

  return null;
}

function normalizeFieldDefinition(value: unknown): FreshsalesFieldDefinition | null {
  const record = asRecord(value);
  const name = stringValue(record.name);
  if (!name) {
    return null;
  }

  return {
    id: record.id as string | number | undefined,
    label: stringValue(record.label) ?? undefined,
    name,
    type: stringValue(record.type) ?? undefined,
    default: typeof record.default === "boolean" ? record.default : undefined,
    choices: Array.isArray(record.choices) ? record.choices : undefined
  };
}

function closestFieldMatches(fields: FreshsalesFieldDefinition[], requested: string): string[] {
  const normalized = normalizeName(requested);
  return fields
    .map(field => field.label ? `${field.name} (${field.label})` : field.name)
    .filter(candidate => normalizeName(candidate).includes(normalized) || normalized.includes(normalizeName(candidate)))
    .slice(0, 5);
}

function normalizeName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
