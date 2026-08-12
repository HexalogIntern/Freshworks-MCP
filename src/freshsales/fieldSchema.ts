import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  choiceLabelById?: Record<string, string>;
  choiceIdByLabel?: Record<string, string>;
}

export interface FieldAliasResolution {
  requested: string;
  apiField: FreshsalesFieldDefinition;
  resolvedInput: string;
  matchedBy: "api_field" | "ui_label";
}

interface FieldSchemaPayload {
  fields?: unknown[];
}

interface FieldSchemaCacheEntry {
  expiresAt: number;
  fields: FreshsalesFieldDefinition[];
}

interface PersistedFieldSchemaCache {
  entries?: Record<string, FieldSchemaCacheEntry>;
}

const cache = new Map<FieldSchemaEntity, FieldSchemaCacheEntry>();

export function isFieldSchemaCacheMiss(ctx: ToolExecutionContext, entity: FieldSchemaEntity): boolean {
  const cached = cache.get(entity);
  return !cached || Date.now() >= cached.expiresAt || ctx.config.fieldSchemaCacheTtlMs === 0;
}

export function clearFieldSchemaCache(): void {
  cache.clear();
  rmSync(fieldSchemaCachePath(), { force: true });
}

export function clearFieldSchemaMemoryCache(): void {
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

  const persisted = options.forceRefresh ? null : await readPersistedFieldSchema(ctx, entity);
  if (persisted && Date.now() < persisted.expiresAt && ctx.config.fieldSchemaCacheTtlMs !== 0) {
    cache.set(entity, persisted);
    return persisted.fields;
  }

  const payload = await ctx.freshsales.get<FieldSchemaPayload>(`api/settings/${entity}/fields`);
  const fields = Array.isArray(payload.fields)
    ? payload.fields.map(normalizeFieldDefinition).filter((field): field is FreshsalesFieldDefinition => field !== null)
    : [];

  const entry = {
    fields,
    expiresAt: Date.now() + ctx.config.fieldSchemaCacheTtlMs
  };
  cache.set(entity, entry);
  await writePersistedFieldSchema(ctx, entity, entry);

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
  return resolveFieldAlias(fields, requested).apiField;
}

export function resolveFieldAlias(fields: FreshsalesFieldDefinition[], requested: string): FieldAliasResolution {
  const trimmed = requested.trim();
  const aliasMap = buildFieldAliasMap(fields);
  const resolvedInput = aliasMap.get(normalizeAliasKey(trimmed)) ?? trimmed;
  const normalized = normalizeName(resolvedInput);
  const matched = fields.find(field => normalizeName(field.name) === normalized);

  if (matched) {
    return {
      requested,
      apiField: matched,
      resolvedInput: matched.name,
      matchedBy: normalizeName(trimmed) === normalizeName(matched.name) ? "api_field" : "ui_label"
    };
  }

  const matches = closestFieldMatches(fields, requested);
  const suffix = matches.length > 0 ? ` Did you mean: ${matches.join(", ")}?` : "";
  throw new AppError("UNKNOWN_FIELD", `Unknown Freshsales field: ${requested}.${suffix}`);
}

export function fieldMetadata(fields: FreshsalesFieldDefinition[]): Array<{
  api_field: string;
  ui_label: string | null;
  type: string | null;
  relation_include: string | null;
}> {
  return fields.map(field => ({
    api_field: field.name,
    ui_label: field.label ?? null,
    type: field.type ?? null,
    relation_include: relationIncludeForField(field.name)
  }));
}

export function relationIncludeForField(fieldName: string): string | null {
  return relationFieldIncludes.get(fieldName) ?? null;
}

export function mergeIncludes(...includeGroups: Array<string | null | undefined>): string {
  const includes = new Set<string>();
  for (const group of includeGroups) {
    for (const include of String(group ?? "").split(",")) {
      const trimmed = include.trim();
      if (trimmed) {
        includes.add(trimmed);
      }
    }
  }

  return Array.from(includes).join(",");
}

export function fieldValueFor(record: Record<string, unknown>, field: FreshsalesFieldDefinition): unknown {
  return resolveFieldValue(record, asRecord(record.custom_field), field.name);
}

export function relationDisplayValue(record: Record<string, unknown>, field: FreshsalesFieldDefinition): unknown {
  const includeKey = relationIncludeForField(field.name);
  if (!includeKey) {
    return fieldValueFor(record, field);
  }

  const nested = record[includeKey];
  if (Array.isArray(nested)) {
    const names = nested
      .map(item => stringValue(asRecord(item).name))
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) {
      return names.join(", ");
    }
  }

  const nestedName = stringValue(asRecord(nested).name);
  return nestedName ?? fieldValueFor(record, field);
}

export function fieldComparableValues(record: Record<string, unknown>, field: FreshsalesFieldDefinition): unknown[] {
  const rawValue = fieldValueFor(record, field);
  const values = [choiceDisplayValue(field, rawValue), relationDisplayValue(record, field), rawValue];
  return values.filter((value, index) => {
    if (value === undefined || value === null || String(value).trim() === "") {
      return false;
    }

    return values.findIndex(candidate => String(candidate) === String(value)) === index;
  });
}

export function resolveFilterValueForField(field: FreshsalesFieldDefinition, requested: string): string | number {
  const trimmed = requested.trim();
  const choiceId = field.choiceIdByLabel?.[normalizeAliasKey(trimmed)];
  return choiceId ?? trimmed;
}

export function choiceDisplayValue(field: FreshsalesFieldDefinition, rawValue: unknown): unknown {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return rawValue;
  }

  const raw = String(rawValue);
  return field.choiceLabelById?.[raw] ?? (field.choiceLabelById ? `Unresolved (id: ${raw})` : rawValue);
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

  const choices = Array.isArray(record.choices) ? record.choices : undefined;
  const choiceMaps = buildChoiceMaps(choices);

  return {
    id: record.id as string | number | undefined,
    label: stringValue(record.label) ?? undefined,
    name,
    type: stringValue(record.type) ?? undefined,
    default: typeof record.default === "boolean" ? record.default : undefined,
    choices,
    choiceLabelById: choiceMaps.labelById,
    choiceIdByLabel: choiceMaps.idByLabel
  };
}

function buildChoiceMaps(choices: unknown[] | undefined): {
  labelById?: Record<string, string>;
  idByLabel?: Record<string, string>;
} {
  if (!choices) {
    return {};
  }

  const labelById: Record<string, string> = {};
  const idByLabel: Record<string, string> = {};
  for (const choice of choices) {
    const record = asRecord(choice);
    const id = scalarString(record.id);
    const label = stringValue(record.value) ?? stringValue(record.label) ?? stringValue(record.name);
    if (id && label) {
      labelById[id] = label;
      idByLabel[normalizeAliasKey(label)] = id;
    }
  }

  return { labelById, idByLabel };
}

function closestFieldMatches(fields: FreshsalesFieldDefinition[], requested: string): string[] {
  const normalized = normalizeName(requested);
  return fields
    .map(field => field.label ? `${field.name} (${field.label})` : field.name)
    .filter(candidate => normalizeName(candidate).includes(normalized) || normalized.includes(normalizeName(candidate)))
    .slice(0, 5);
}

function buildFieldAliasMap(fields: FreshsalesFieldDefinition[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const field of fields) {
    aliases.set(normalizeAliasKey(field.name), field.name);
    if (field.label) {
      aliases.set(normalizeAliasKey(field.label), field.name);
    }
  }

  return aliases;
}

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
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

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

async function readPersistedFieldSchema(
  ctx: ToolExecutionContext,
  entity: FieldSchemaEntity
): Promise<FieldSchemaCacheEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(fieldSchemaCachePath(), "utf8")) as PersistedFieldSchemaCache;
    const entry = parsed.entries?.[persistedCacheKey(ctx, entity)];
    return entry && Array.isArray(entry.fields) ? entry : null;
  } catch {
    return null;
  }
}

async function writePersistedFieldSchema(
  ctx: ToolExecutionContext,
  entity: FieldSchemaEntity,
  entry: FieldSchemaCacheEntry
): Promise<void> {
  try {
    await mkdir(join(tmpdir(), "freshsales-mcp"), { recursive: true });
    const current = await readPersistedFieldSchemaFile();
    current.entries = current.entries ?? {};
    current.entries[persistedCacheKey(ctx, entity)] = entry;
    await writeFile(fieldSchemaCachePath(), JSON.stringify(current), "utf8");
  } catch {
    ctx.logger.warn("field_schema_cache_persist_failed", { entity });
  }
}

async function readPersistedFieldSchemaFile(): Promise<PersistedFieldSchemaCache> {
  try {
    return JSON.parse(await readFile(fieldSchemaCachePath(), "utf8")) as PersistedFieldSchemaCache;
  } catch {
    return {};
  }
}

function fieldSchemaCachePath(): string {
  return join(tmpdir(), "freshsales-mcp", "field-schema-cache.json");
}

function persistedCacheKey(ctx: ToolExecutionContext, entity: FieldSchemaEntity): string {
  return `${ctx.config.freshsalesDomain}|${entity}`;
}

const relationFieldIncludes = new Map<string, string>([
  ["lifecycle_stage_id", "lifecycle_stage"],
  ["sales_accounts", "sales_accounts"],
  ["sales_account_id", "sales_account"],
  ["sales_account", "sales_account"],
  ["owner_id", "owner"],
  ["owner", "owner"],
  ["deal_stage_id", "deal_stage"],
  ["deal_stage", "deal_stage"],
  ["contacts", "contacts"]
]);
