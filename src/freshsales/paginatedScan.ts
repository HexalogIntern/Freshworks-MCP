import { getCollection } from "./mappers.js";
import type { ToolExecutionContext } from "../tools/common.js";
import type { FreshsalesView } from "./views.js";

export interface ScanViewOptions {
  entity: "contacts" | "deals";
  viewId: string;
  perPage: number;
  maxPages: number;
  include?: string;
  matches: (record: Record<string, unknown>, view?: FreshsalesView) => boolean;
}

export interface ScanViewResult<T> {
  records: T[];
  scannedRecords: number;
  truncated: boolean;
}

export interface MultiViewScanResult<T> {
  records: T[];
  scannedRecords: number;
  viewsScanned: string[];
  viewsSkippedDueToCap: string[];
  truncated: boolean;
}

export async function scanView<T extends Record<string, unknown>>(
  ctx: ToolExecutionContext,
  options: ScanViewOptions
): Promise<ScanViewResult<T>> {
  const records: T[] = [];
  let scannedRecords = 0;
  let truncated = false;

  for (let page = 1; page <= options.maxPages; page += 1) {
    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/${options.entity}/view/${options.viewId}`, {
      query: {
        page,
        per_page: options.perPage,
        include: options.include
      }
    });

    const pageRecords = getCollection(payload, options.entity);
    if (pageRecords.length === 0) {
      break;
    }

    scannedRecords += pageRecords.length;
    records.push(...pageRecords.filter(record => options.matches(record)) as T[]);

    if (pageRecords.length < options.perPage) {
      break;
    }

    if (page === options.maxPages) {
      truncated = true;
    }
  }

  return {
    records,
    scannedRecords,
    truncated
  };
}

export async function scanViews<T extends Record<string, unknown>>(
  ctx: ToolExecutionContext,
  options: Omit<ScanViewOptions, "viewId"> & {
    views: FreshsalesView[];
    maxViews: number;
    annotateMatchedView?: boolean;
  }
): Promise<MultiViewScanResult<T>> {
  const recordsById = new Map<string, T & { matched_views?: string[] }>();
  const viewsScanned: string[] = [];
  const viewsToScan = options.views.slice(0, options.maxViews);
  const viewsSkippedDueToCap = options.views.slice(options.maxViews).map(view => view.name);
  let scannedRecords = 0;
  let truncated = viewsSkippedDueToCap.length > 0;

  for (const view of viewsToScan) {
    ctx.logger.info("freshsales_view_scan_started", {
      entity: options.entity,
      view_id: view.id,
      view_name: view.name
    });

    const scan = await scanView<T>(ctx, {
      entity: options.entity,
      viewId: view.id,
      perPage: options.perPage,
      maxPages: options.maxPages,
      include: options.include,
      matches: record => options.matches(record, view)
    });

    viewsScanned.push(view.name);
    scannedRecords += scan.scannedRecords;
    truncated = truncated || scan.truncated;

    for (const record of scan.records) {
      const key = record.id === undefined || record.id === null
        ? `${view.id}:${recordsById.size}`
        : String(record.id);
      const existing = recordsById.get(key);

      if (existing) {
        existing.matched_views = Array.from(new Set([...(existing.matched_views ?? []), view.name]));
        continue;
      }

      recordsById.set(key, {
        ...record,
        ...(options.annotateMatchedView ? { matched_views: [view.name] } : {})
      });
    }
  }

  if (viewsSkippedDueToCap.length > 0) {
    ctx.logger.warn("freshsales_views_skipped_due_to_cap", {
      entity: options.entity,
      skipped_views: viewsSkippedDueToCap
    });
  }

  return {
    records: Array.from(recordsById.values()),
    scannedRecords,
    viewsScanned,
    viewsSkippedDueToCap,
    truncated
  };
}
