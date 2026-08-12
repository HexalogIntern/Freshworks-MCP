import { z } from "zod";

import { contactStatusFromRecord } from "../freshsales/mappers.js";
import { scanView, scanViews } from "../freshsales/paginatedScan.js";
import { fetchFieldSchema, fieldValueFor, isFieldSchemaCacheMiss, validateFieldName } from "../freshsales/fieldSchema.js";
import { listContactViews } from "../freshsales/views.js";
import { normalizeMonth } from "../utils/time.js";
import { approvalFields, defineTool } from "./common.js";

const groupBySchema = z.enum(["status", "month", "source"]);

const schema = z
  .object({
    ...approvalFields,
    group_by: groupBySchema.optional()
  })
  .strict();

interface ContactsSummaryParams {
  groupBy: "status" | "month" | "source";
}

export const contactsSummaryTool = defineTool({
  name: "contacts_summary",
  title: "Contacts Summary",
  description:
    "Preview or aggregate live Freshsales contact data by status, month, or source. Execution scans the configured contacts view page by page up to CONTACTS_SCAN_MAX_PAGES and returns scanned_records plus truncated when the scan cap is reached.",
  inputSchema: schema,
  resolve(input): ContactsSummaryParams {
    if (!input.group_by) {
      throw new Error("group_by is required before approval.");
    }

    return {
      groupBy: input.group_by
    };
  },
  estimateCallCount(params, ctx) {
    const scanCalls = params.groupBy === "source"
      ? ctx.config.contactsScanMaxPages * ctx.config.contactsScanMaxViews + 1
      : ctx.config.contactsScanMaxPages;
    return scanCalls + (params.groupBy === "source" && isFieldSchemaCacheMiss(ctx, "contacts") ? 1 : 0);
  },
  async execute(params, ctx) {
    const perPage = 50;
    const fieldSchema = params.groupBy === "source" ? await fetchFieldSchema(ctx, "contacts") : [];
    const sourceField = params.groupBy === "source" ? validateFieldName(fieldSchema, "source") : undefined;
    const scan = params.groupBy === "source"
      ? await scanViews(ctx, {
        entity: "contacts",
        views: await contactViewsForScan(ctx),
        maxViews: ctx.config.contactsScanMaxViews,
        perPage,
        maxPages: ctx.config.contactsScanMaxPages,
        include: "owner,sales_account",
        annotateMatchedView: true,
        matches: () => true
      })
      : await scanView(ctx, {
        entity: "contacts",
        viewId: ctx.config.defaultContactsViewId,
        perPage,
        maxPages: ctx.config.contactsScanMaxPages,
        include: "owner,sales_account",
        matches: () => true
      });
    const groups = new Map<string, number>();

    for (const contact of scan.records) {
      const key = groupKey(params.groupBy, contact, sourceField);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }

    return {
      group_by: params.groupBy,
      scanned_records: scan.scannedRecords,
      views_scanned: "viewsScanned" in scan ? scan.viewsScanned : [],
      views_skipped_due_to_cap: "viewsSkippedDueToCap" in scan ? scan.viewsSkippedDueToCap : [],
      truncated: scan.truncated,
      groups: Array.from(groups.entries()).map(([key, count]) => ({
        key,
        count
      }))
    };
  },
  willCallFreshsales: true
});

function groupKey(
  groupBy: ContactsSummaryParams["groupBy"],
  contact: Record<string, unknown>,
  sourceField?: ReturnType<typeof validateFieldName>
): string {
  if (groupBy === "month") {
    return normalizeMonth(String(contact.created_at ?? ""));
  }

  if (groupBy === "source" && sourceField) {
    const inlineSource = String(fieldValueFor(contact, sourceField) ?? "").trim();
    if (inlineSource) {
      return inlineSource;
    }

    const matchedViews = Array.isArray(contact.matched_views) ? contact.matched_views : [];
    const sourceView = matchedViews.map(String).find(name => normalizeSourceViewName(name));
    return sourceView ? normalizeSourceViewName(sourceView) : "Unknown";
  }

  return contactStatusFromRecord(contact) ?? "Unknown";
}

async function contactViewsForScan(ctx: Parameters<typeof listContactViews>[0]) {
  const views = await listContactViews(ctx);
  return views.length > 0 ? views : [{ id: ctx.config.defaultContactsViewId, name: "Default contacts view" }];
}

function normalizeSourceViewName(viewName: string): string {
  const lower = viewName.toLowerCase();
  const paidMediaMatch = lower.match(/paid[\s_-]*media|paid[\s_-]*meta/);
  if (paidMediaMatch) {
    return "paid_meta";
  }

  return "";
}
