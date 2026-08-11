import { getCollection } from "./mappers.js";
import type { ToolExecutionContext } from "../tools/common.js";

export interface ScanViewOptions {
  entity: "contacts" | "deals";
  viewId: string;
  perPage: number;
  maxPages: number;
  include?: string;
  matches: (record: Record<string, unknown>) => boolean;
}

export interface ScanViewResult<T> {
  records: T[];
  scannedRecords: number;
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
    records.push(...pageRecords.filter(options.matches) as T[]);

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
