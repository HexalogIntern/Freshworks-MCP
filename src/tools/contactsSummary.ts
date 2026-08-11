import { z } from "zod";

import { contactStatusFromRecord } from "../freshsales/mappers.js";
import { scanView } from "../freshsales/paginatedScan.js";
import { fetchFieldSchema, fieldValueFor, isFieldSchemaCacheMiss, validateFieldName } from "../freshsales/fieldSchema.js";
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
    return ctx.config.contactsScanMaxPages + (params.groupBy === "source" && isFieldSchemaCacheMiss(ctx, "contacts") ? 1 : 0);
  },
  async execute(params, ctx) {
    const perPage = 50;
    const fieldSchema = params.groupBy === "source" ? await fetchFieldSchema(ctx, "contacts") : [];
    const sourceField = params.groupBy === "source" ? validateFieldName(fieldSchema, "source") : undefined;
    const scan = await scanView(ctx, {
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
    return String(fieldValueFor(contact, sourceField) ?? "Unknown") || "Unknown";
  }

  return contactStatusFromRecord(contact) ?? "Unknown";
}
