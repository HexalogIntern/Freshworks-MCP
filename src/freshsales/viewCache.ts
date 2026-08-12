import type { AppConfig } from "../config.js";
import type { FreshsalesView } from "./views.js";

export type ViewEntity = "contacts" | "deals";

export interface FieldCoverage {
  field: string;
  values: string[];
}

export interface ViewFieldCoverage {
  entity: ViewEntity;
  view: FreshsalesView;
  populatedFields: FieldCoverage[];
  strongFilterCandidates: string[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const viewListCache = new Map<ViewEntity, CacheEntry<FreshsalesView[]>>();
const fieldCoverageCache = new Map<ViewEntity, CacheEntry<Map<string, ViewFieldCoverage>>>();

export function clearViewCaches(): void {
  viewListCache.clear();
  fieldCoverageCache.clear();
}

export function getCachedViews(entity: ViewEntity, config: AppConfig): FreshsalesView[] | undefined {
  const cached = viewListCache.get(entity);
  if (!cached || config.viewListCacheTtlMs === 0 || Date.now() >= cached.expiresAt) {
    return undefined;
  }

  return cached.value;
}

export function setCachedViews(entity: ViewEntity, views: FreshsalesView[], config: AppConfig): void {
  viewListCache.set(entity, {
    value: views,
    expiresAt: Date.now() + config.viewListCacheTtlMs
  });
}

export function getCachedFieldCoverage(entity: ViewEntity, config: AppConfig): ViewFieldCoverage[] {
  const cached = fieldCoverageCache.get(entity);
  if (!cached || config.viewFieldCoverageCacheTtlMs === 0 || Date.now() >= cached.expiresAt) {
    return [];
  }

  return Array.from(cached.value.values());
}

export function upsertViewFieldCoverage(
  entity: ViewEntity,
  coverage: ViewFieldCoverage[],
  config: AppConfig
): void {
  const current = new Map<string, ViewFieldCoverage>();
  for (const entry of getCachedFieldCoverage(entity, config)) {
    current.set(entry.view.id, entry);
  }

  for (const entry of coverage) {
    current.set(entry.view.id, entry);
  }

  fieldCoverageCache.set(entity, {
    value: current,
    expiresAt: Date.now() + config.viewFieldCoverageCacheTtlMs
  });
}

export function cachedViewsForFilter(
  entity: ViewEntity,
  config: AppConfig,
  filter: { field?: string; value?: string }
): FreshsalesView[] {
  if (!filter.value) {
    return [];
  }

  const expected = normalizeToken(filter.value);
  return getCachedFieldCoverage(entity, config)
    .filter(entry => {
      if (entry.strongFilterCandidates.some(candidate => normalizeToken(candidate).includes(expected))) {
        return true;
      }

      return entry.populatedFields.some(field => {
        const fieldMatches = !filter.field || normalizeToken(field.field).includes(normalizeToken(filter.field));
        return fieldMatches && field.values.some(value => normalizeToken(value).includes(expected));
      });
    })
    .map(entry => entry.view);
}

export function inspectFieldCoverage(
  entity: ViewEntity,
  view: FreshsalesView,
  records: Array<Record<string, unknown>>,
  maxValuesPerField = 5
): ViewFieldCoverage {
  const valuesByField = new Map<string, Set<string>>();

  for (const record of records) {
    collectPopulatedFields(record, "", valuesByField, maxValuesPerField);
  }

  const populatedFields = Array.from(valuesByField.entries()).map(([field, values]) => ({
    field,
    values: Array.from(values)
  }));

  return {
    entity,
    view,
    populatedFields,
    strongFilterCandidates: inferStrongFilterCandidates(view.name, populatedFields)
  };
}

function collectPopulatedFields(
  value: unknown,
  prefix: string,
  valuesByField: Map<string, Set<string>>,
  maxValuesPerField: number
): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectPopulatedFields(nested, prefix ? `${prefix}.${key}` : key, valuesByField, maxValuesPerField);
    }
    return;
  }

  const normalized = String(value).trim();
  if (!normalized || !prefix) {
    return;
  }

  const values = valuesByField.get(prefix) ?? new Set<string>();
  if (values.size < maxValuesPerField) {
    values.add(normalized);
  }
  valuesByField.set(prefix, values);
}

function inferStrongFilterCandidates(viewName: string, fields: FieldCoverage[]): string[] {
  const candidates = new Set<string>();
  const normalizedViewName = normalizeToken(viewName);

  if (normalizedViewName.includes("paidmedia") || normalizedViewName.includes("paidmeta")) {
    candidates.add("source:paid_meta");
  }

  for (const field of fields) {
    const normalizedField = normalizeToken(field.field);
    if (!normalizedField.includes("source")) {
      continue;
    }

    for (const value of field.values) {
      candidates.add(`source:${value}`);
    }
  }

  return Array.from(candidates);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
