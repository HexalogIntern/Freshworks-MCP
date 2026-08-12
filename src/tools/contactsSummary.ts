import { z } from "zod";

import { contactStatusNameForId, fetchContactStatusLookup, isContactStatusCacheMiss, type ContactStatusLookup } from "../freshsales/contactStatusCache.js";
import { contactStatusFromRecord } from "../freshsales/mappers.js";
import { scanView, scanViews } from "../freshsales/paginatedScan.js";
import { fetchFieldSchema, fieldValueFor, isFieldSchemaCacheMiss, mergeIncludes, relationIncludeForField, resolveFieldAlias, validateFieldName, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { AppError } from "../utils/errors.js";
import { listContactViews } from "../freshsales/views.js";
import { normalizeMonth } from "../utils/time.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    group_by: z.string().trim().min(1).max(100).optional()
  })
  .strict();

interface ContactsSummaryParams {
  groupBy: string;
}

export const contactsSummaryTool = defineTool({
  name: "contacts_summary",
  title: "Contacts Summary",
  description:
    "Preview or aggregate live Freshsales contact data by status, month, or source. group_by accepts supported raw API field names or UI display labels, case-insensitively. Execution scans the configured contacts view page by page up to CONTACTS_SCAN_MAX_PAGES and returns scanned_records plus truncated when the scan cap is reached.",
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
    const groupBy = normalizeGroupInput(params.groupBy);
    const scanCalls = groupBy === "source"
      ? ctx.config.contactsScanMaxPages * ctx.config.contactsScanMaxViews + 1
      : ctx.config.contactsScanMaxPages;
    return scanCalls
      + (groupBy !== "month" && isFieldSchemaCacheMiss(ctx, "contacts") ? 1 : 0)
      + (groupBy === "status" && isContactStatusCacheMiss(ctx) ? 1 : 0);
  },
  async execute(params, ctx) {
    const perPage = 50;
    const fieldSchema = normalizeGroupInput(params.groupBy) === "month" ? [] : await fetchFieldSchema(ctx, "contacts");
    const groupResolution = resolveContactGroup(params.groupBy, fieldSchema);
    const sourceField = groupResolution.groupBy === "source" ? validateFieldName(fieldSchema, "source") : undefined;
    const contactStatusLookup = groupResolution.groupBy === "status" ? await fetchContactStatusLookup(ctx) : undefined;
    const include = mergeIncludes("owner,sales_account", relationIncludeForField(groupResolution.apiField?.name ?? ""));
    const scan = groupResolution.groupBy === "source"
      ? await scanViews(ctx, {
        entity: "contacts",
        views: await contactViewsForScan(ctx),
        maxViews: ctx.config.contactsScanMaxViews,
        perPage,
        maxPages: ctx.config.contactsScanMaxPages,
        include,
        annotateMatchedView: true,
        matches: () => true
      })
      : await scanView(ctx, {
        entity: "contacts",
        viewId: ctx.config.defaultContactsViewId,
        perPage,
        maxPages: ctx.config.contactsScanMaxPages,
        include,
        matches: () => true
      });
    const groups = new Map<string, number>();

    for (const contact of scan.records) {
      const key = groupKey(groupResolution.groupBy, contact, sourceField, contactStatusLookup);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }

    return {
      group_by: params.groupBy,
      group_api_field: groupResolution.apiField?.name ?? null,
      group_ui_label: groupResolution.apiField?.label ?? null,
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
  groupBy: "status" | "month" | "source",
  contact: Record<string, unknown>,
  sourceField?: ReturnType<typeof validateFieldName>,
  contactStatusLookup?: ContactStatusLookup
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

  return contactStatusNameForId(contactStatusLookup, contact.contact_status_id) ?? contactStatusFromRecord(contact) ?? "Unknown";
}

function resolveContactGroup(groupBy: string, fields: FreshsalesFieldDefinition[]): {
  groupBy: "status" | "month" | "source";
  apiField?: FreshsalesFieldDefinition;
} {
  const normalized = normalizeGroupInput(groupBy);
  const builtin = contactGroupAliases.get(normalized);
  if (builtin) {
    const apiField = builtin === "source"
      ? fields.find(field => field.name === "source" || field.label?.trim().toLowerCase() === "source")
      : fields.find(field => field.name === "contact_status_id" || field.label?.trim().toLowerCase() === "status");
    return { groupBy: builtin, apiField };
  }

  const resolved = resolveFieldAlias(fields, groupBy).apiField;
  if (resolved.name === "source") {
    return { groupBy: "source", apiField: resolved };
  }

  if (resolved.name === "contact_status_id") {
    return { groupBy: "status", apiField: resolved };
  }

  throw new AppError("UNSUPPORTED_GROUP_BY", `Unsupported contacts_summary group_by field: ${groupBy}. Supported groups are status, month, and source.`);
}

function normalizeGroupInput(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const contactGroupAliases = new Map<string, "status" | "month" | "source">([
  ["status", "status"],
  ["contactstatus", "status"],
  ["contactstatusid", "status"],
  ["month", "month"],
  ["source", "source"]
]);

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
