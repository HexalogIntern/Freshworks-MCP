import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolExecutionContext } from "../tools/common.js";
import { AppError } from "../utils/errors.js";

export interface ContactStatusLookup {
  idToName: Map<string, string>;
  sourcePath: string;
  rawResponse: unknown;
}

interface ContactStatusCacheEntry {
  expiresAt: number;
  sourcePath: string;
  statuses: Array<{ id: string; name: string }>;
  rawResponse: unknown;
}

interface PersistedContactStatusCache {
  entries?: Record<string, ContactStatusCacheEntry>;
}

const cache = new Map<string, ContactStatusCacheEntry>();

const statusEndpointCandidates = [
  "api/selector/contact_statuses",
  "api/settings/contact_statuses",
  "api/settings/lifecycle_stages"
];

export function isContactStatusCacheMiss(ctx: ToolExecutionContext): boolean {
  const key = persistedCacheKey(ctx);
  const cached = cache.get(key);
  return !cached || Date.now() >= cached.expiresAt || ctx.config.fieldSchemaCacheTtlMs === 0;
}

export function clearContactStatusCache(): void {
  cache.clear();
  rmSync(contactStatusCachePath(), { force: true });
}

export async function fetchContactStatusLookup(
  ctx: ToolExecutionContext,
  options: { forceRefresh?: boolean } = {}
): Promise<ContactStatusLookup> {
  const key = persistedCacheKey(ctx);
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && Date.now() < cached.expiresAt && ctx.config.fieldSchemaCacheTtlMs !== 0) {
    return lookupFromEntry(cached);
  }

  const persisted = options.forceRefresh ? null : await readPersistedContactStatuses(ctx);
  if (persisted && Date.now() < persisted.expiresAt && ctx.config.fieldSchemaCacheTtlMs !== 0) {
    cache.set(key, persisted);
    return lookupFromEntry(persisted);
  }

  const failures: string[] = [];
  for (const path of statusEndpointCandidates) {
    try {
      const rawResponse = await ctx.freshsales.get<unknown>(path);
      const statuses = extractStatuses(rawResponse);
      if (statuses.length === 0) {
        failures.push(`${path}: no statuses found`);
        continue;
      }

      const entry: ContactStatusCacheEntry = {
        expiresAt: Date.now() + ctx.config.fieldSchemaCacheTtlMs,
        sourcePath: path,
        statuses,
        rawResponse
      };
      cache.set(key, entry);
      await writePersistedContactStatuses(ctx, entry);
      return lookupFromEntry(entry);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }

  throw new AppError(
    "CONTACT_STATUS_LOOKUP_UNAVAILABLE",
    `Status labels are not exposed via the Freshsales API for this account; only the raw ID is available. Filter using status IDs, or resolve labels manually in the Freshsales UI. Tried: ${failures.join("; ")}`
  );
}

export function contactStatusNameForId(lookup: ContactStatusLookup | undefined, id: unknown): string | null {
  if (id === undefined || id === null || String(id).trim() === "") {
    return null;
  }

  return lookup?.idToName.get(String(id)) ?? null;
}

function lookupFromEntry(entry: ContactStatusCacheEntry): ContactStatusLookup {
  return {
    idToName: new Map(entry.statuses.map(status => [status.id, status.name])),
    sourcePath: entry.sourcePath,
    rawResponse: entry.rawResponse
  };
}

function extractStatuses(payload: unknown): Array<{ id: string; name: string }> {
  const payloadRecord = asRecord(payload);
  const directSources = [
    asArray(payload),
    asArray(payloadRecord.contact_statuses),
    asArray(payloadRecord.statuses),
    asArray(payloadRecord.data)
  ];
  const statuses = directSources.flatMap(source => source.map(normalizeStatus).filter((item): item is { id: string; name: string } => item !== null));

  const lifecycleStages = [
    ...asArray(payloadRecord.lifecycle_stages),
    ...asArray(payloadRecord.stages)
  ];
  for (const stageValue of lifecycleStages) {
    const stage = asRecord(stageValue);
    statuses.push(
      ...[
        ...asArray(stage.contact_statuses),
        ...asArray(stage.statuses),
        ...asArray(stage.children)
      ].map(normalizeStatus).filter((item): item is { id: string; name: string } => item !== null)
    );
  }

  return dedupeStatuses(statuses);
}

function normalizeStatus(value: unknown): { id: string; name: string } | null {
  const record = asRecord(value);
  const id = scalarString(record.id);
  const name = scalarString(record.name) ?? scalarString(record.label) ?? scalarString(record.display_name);
  if (!id || !name) {
    return null;
  }

  return { id, name };
}

function dedupeStatuses(statuses: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> {
  const byId = new Map<string, { id: string; name: string }>();
  for (const status of statuses) {
    byId.set(status.id, status);
  }

  return Array.from(byId.values());
}

async function readPersistedContactStatuses(ctx: ToolExecutionContext): Promise<ContactStatusCacheEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(contactStatusCachePath(), "utf8")) as PersistedContactStatusCache;
    const entry = parsed.entries?.[persistedCacheKey(ctx)];
    return entry && Array.isArray(entry.statuses) ? entry : null;
  } catch {
    return null;
  }
}

async function writePersistedContactStatuses(ctx: ToolExecutionContext, entry: ContactStatusCacheEntry): Promise<void> {
  try {
    await mkdir(join(tmpdir(), "freshsales-mcp"), { recursive: true });
    const current = await readPersistedContactStatusFile();
    current.entries = current.entries ?? {};
    current.entries[persistedCacheKey(ctx)] = entry;
    await writeFile(contactStatusCachePath(), JSON.stringify(current), "utf8");
  } catch {
    ctx.logger.warn("contact_status_cache_persist_failed", {});
  }
}

async function readPersistedContactStatusFile(): Promise<PersistedContactStatusCache> {
  try {
    return JSON.parse(await readFile(contactStatusCachePath(), "utf8")) as PersistedContactStatusCache;
  } catch {
    return {};
  }
}

function contactStatusCachePath(): string {
  return join(tmpdir(), "freshsales-mcp", "contact-status-cache.json");
}

function persistedCacheKey(ctx: ToolExecutionContext): string {
  return ctx.config.freshsalesDomain;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
