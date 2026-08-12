import { z } from "zod";

import { accountNameFromRecord, contactStatusFromRecord, emailFromRecord, getCollection, getPrimaryRecord, nameFromRecord, ownerNameFromRecord, salesAccountsFromRecord, tagNamesFromRecord } from "../freshsales/mappers.js";
import { scanView, scanViews } from "../freshsales/paginatedScan.js";
import { dynamicRecordFromSchema, fetchFieldSchema, fieldValueFor, isFieldSchemaCacheMiss, mergeIncludes, relationIncludeForField, resolveFieldAlias, validateFieldName, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { cachedViewsForFilter } from "../freshsales/viewCache.js";
import { listContactViews, resolveContactViewId } from "../freshsales/views.js";
import { AppError } from "../utils/errors.js";
import { isIsoDate } from "../utils/time.js";
import type { ToolExecutionContext } from "./common.js";
import { approvalFields, defineTool } from "./common.js";

const sortOrderSchema = z.enum(["asc", "desc"]);
const matchModeSchema = z.enum(["exact", "contains"]);

const schema = z
  .object({
    ...approvalFields,
    view: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().min(1).max(100).optional(),
    filter_by: z.string().trim().min(1).max(100).optional(),
    filter_value: z.string().trim().min(1).max(200).optional(),
    match_mode: matchModeSchema.default("exact"),
    sort_by: z.string().trim().min(1).max(100).optional(),
    sort_order: sortOrderSchema.default("asc"),
    hydrate_relations: z.boolean().default(false),
    owner: z.string().trim().min(1).max(100).optional(),
    date_from: z.string().trim().optional(),
    date_to: z.string().trim().optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface ListContactsParams {
  view?: string;
  source?: string;
  filterBy?: string;
  filterValue?: string;
  matchMode: "exact" | "contains";
  sortBy?: string;
  sortOrder: "asc" | "desc";
  hydrateRelations: boolean;
  owner?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  perPage: number;
}

export const listContactsTool = defineTool({
  name: "list_contacts",
  title: "List Contacts",
  description:
    "Preview or list live Freshsales contacts from the configured default contacts view, or pass view to target any saved Freshsales view by name or id. Field output, source, filter_by, and sort_by accept either raw API field names or UI display labels, case-insensitively, and are validated against Freshsales contact field metadata. Relation-backed fields may add targeted include hydration cost. Run discover_views once after deploy or after adding custom Freshsales views to warm the view cache; then filtered source/filter_by queries can go straight to likely matching views instead of broad multi-view scanning. Filtered queries scan up to CONTACTS_SCAN_MAX_PAGES pages and return scanned_records plus truncated when the scan cap is reached. match_mode defaults to exact; contains performs a case-insensitive substring match for source and filter_value.",
  inputSchema: schema,
  resolve(input): ListContactsParams {
    if (input.date_from && !isIsoDate(input.date_from)) {
      throw new AppError("INVALID_DATE", "date_from must be a valid ISO date or datetime.");
    }

    if (input.date_to && !isIsoDate(input.date_to)) {
      throw new AppError("INVALID_DATE", "date_to must be a valid ISO date or datetime.");
    }

    return {
      view: input.view,
      source: input.source,
      filterBy: input.filter_by,
      filterValue: input.filter_value,
      matchMode: input.match_mode,
      sortBy: input.sort_by,
      sortOrder: input.sort_order,
      hydrateRelations: input.hydrate_relations,
      owner: input.owner,
      dateFrom: input.date_from,
      dateTo: input.date_to,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params, ctx) {
    const multiView = shouldScanAllViews(params);
    const cachedViewCount = multiView
      ? cachedViewsForFilter("contacts", ctx.config, {
        field: params.source ? "source" : params.filterBy,
        value: params.source ?? params.filterValue
      }).length
      : 0;
    const viewsToScan = cachedViewCount > 0 ? cachedViewCount : ctx.config.contactsScanMaxViews;
    const scanPages = shouldScan(params) ? ctx.config.contactsScanMaxPages : 1;
    const hydrationCalls = params.hydrateRelations
      ? (shouldScan(params) ? scanPages * params.perPage * (multiView ? viewsToScan : 1) : params.perPage)
      : 0;
    return (params.view || (multiView && cachedViewCount === 0) ? 1 : 0)
      + (multiView ? scanPages * viewsToScan : scanPages)
      + (isFieldSchemaCacheMiss(ctx, "contacts") ? 1 : 0)
      + hydrationCalls;
  },
  async execute(params, ctx) {
    if (params.hydrateRelations && params.perPage > 10) {
      throw new AppError("HYDRATION_LIMIT_EXCEEDED", "hydrate_relations is capped at per_page <= 10 to protect the Freshsales daily call budget.");
    }

    const fieldSchema = await fetchFieldSchema(ctx, "contacts");
    const filterResolution = params.filterBy ? resolveFieldAlias(fieldSchema, params.filterBy) : undefined;
    const filterField = filterResolution?.apiField;
    const sourceField = params.source ? validateFieldName(fieldSchema, "source") : undefined;
    const sortResolution = params.sortBy ? resolveFieldAlias(fieldSchema, params.sortBy) : undefined;
    const sortField = sortResolution?.apiField;
    const viewId = params.view
      ? await resolveContactViewId(ctx, params.view)
      : ctx.config.defaultContactsViewId;

    const nativeSort = sortField && nativeContactSortFields.has(sortField.name);

    const include = mergeIncludes(
      "owner,sales_account",
      relationIncludeForField(filterField?.name ?? ""),
      relationIncludeForField(sortField?.name ?? "")
    );
    const rawContacts = shouldScanAllViews(params)
      ? await scanViews(ctx, {
        entity: "contacts",
        views: await contactViewsForScan(ctx, {
          field: params.source ? "source" : filterField?.name,
          value: params.source ?? params.filterValue
        }),
        maxViews: ctx.config.contactsScanMaxViews,
        perPage: params.perPage,
        maxPages: ctx.config.contactsScanMaxPages,
        include,
        annotateMatchedView: true,
        matches: (contact, view) => matchesContact(contact, {
          sourceField,
          source: params.source,
          filterField,
          filterValue: params.filterValue,
          matchMode: params.matchMode,
          owner: params.owner,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          viewName: view?.name
        })
      })
      : shouldScan(params)
      ? (await scanView(ctx, {
        entity: "contacts",
        viewId,
        perPage: params.perPage,
        maxPages: ctx.config.contactsScanMaxPages,
        include,
        matches: contact => matchesContact(contact, {
          sourceField,
          source: params.source,
          filterField,
          filterValue: params.filterValue,
          matchMode: params.matchMode,
          owner: params.owner,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo
        })
      }))
      : await fetchContactsPage(ctx, viewId, params, include, nativeSort ? sortField?.name : undefined);
    const contactsForOutput = "records" in rawContacts ? rawContacts.records : rawContacts;
    const hydratedContacts = params.hydrateRelations
      ? await hydrateContactRelations(contactsForOutput, ctx)
      : contactsForOutput;

    const contacts = hydratedContacts
      .sort((left, right) => sortField && !nativeSort ? compareFieldValues(left, right, sortField, params.sortOrder) : 0)
      .map(contact => ({
        ...dynamicRecordFromSchema(contact, fieldSchema),
        status: contactStatusFromRecord(contact),
        tags: tagNamesFromRecord(contact),
        owner: ownerNameFromRecord(contact),
        account: accountNameFromRecord(contact),
        sales_accounts: salesAccountsFromRecord(contact),
        name: nameFromRecord(contact),
        email: emailFromRecord(contact)
      }));

    return {
      data: contacts,
      page: params.page,
      per_page: params.perPage,
      scanned_records: "scannedRecords" in rawContacts ? rawContacts.scannedRecords : contactsForOutput.length,
      views_scanned: "viewsScanned" in rawContacts ? rawContacts.viewsScanned : [],
      views_skipped_due_to_cap: "viewsSkippedDueToCap" in rawContacts ? rawContacts.viewsSkippedDueToCap : [],
      truncated: "truncated" in rawContacts ? rawContacts.truncated : false,
      filters_applied: {
        view: params.view ?? null,
        source: params.source ?? null,
        filter_by: params.filterBy ?? null,
        filter_api_field: filterResolution?.apiField.name ?? null,
        filter_ui_label: filterResolution?.apiField.label ?? null,
        filter_value: params.filterValue ?? null,
        sort_by: params.sortBy ?? null,
        sort_api_field: sortResolution?.apiField.name ?? null,
        sort_ui_label: sortResolution?.apiField.label ?? null,
        sort_order: params.sortBy ? params.sortOrder : null,
        sort_scope: params.sortBy ? (nativeSort ? "freshsales" : "page") : null,
        hydrate_relations: params.hydrateRelations,
        owner: params.owner ?? null,
        date_from: params.dateFrom ?? null,
        date_to: params.dateTo ?? null,
        match_mode: params.matchMode
      }
    };
  },
  willCallFreshsales: true
});

const nativeContactSortFields = new Set(["lead_score", "created_at", "updated_at", "open_deals_amount", "last_contacted"]);

function shouldScan(params: ListContactsParams): boolean {
  return Boolean(params.source || params.filterBy || params.owner || params.dateFrom || params.dateTo);
}

function shouldScanAllViews(params: ListContactsParams): boolean {
  return shouldScan(params) && !params.view;
}

async function contactViewsForScan(ctx: ToolExecutionContext, filter?: { field?: string; value?: string }) {
  const cachedViews = filter ? cachedViewsForFilter("contacts", ctx.config, filter) : [];
  if (cachedViews.length > 0) {
    return cachedViews;
  }

  const views = await listContactViews(ctx);
  return views.length > 0 ? views : [{ id: ctx.config.defaultContactsViewId, name: "Default contacts view" }];
}

async function fetchContactsPage(
  ctx: ToolExecutionContext,
  viewId: string,
  params: ListContactsParams,
  include: string,
  sortField?: string
): Promise<Array<Record<string, unknown>>> {
  const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/contacts/view/${viewId}`, {
    query: {
      page: params.page,
      per_page: params.perPage,
      include,
      sort: sortField,
      sort_type: sortField ? params.sortOrder : undefined
    }
  });

  return getCollection(payload, "contacts");
}

async function hydrateContactRelations(
  contacts: Array<Record<string, unknown>>,
  ctx: ToolExecutionContext
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(contacts.map(async contact => {
    const id = contact.id;
    if (id === undefined || id === null) {
      return contact;
    }

    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/contacts/${id}`, {
      query: {
        include: "owner,sales_accounts,sales_account"
      }
    });
    const detail = getPrimaryRecord(payload, "contact");

    return {
      ...contact,
      ...detail,
      custom_field: {
        ...asRecord(contact.custom_field),
        ...asRecord(detail.custom_field)
      }
    };
  }));
}

function matchesContact(record: Record<string, unknown>, filters: {
  sourceField?: FreshsalesFieldDefinition;
  source?: string;
  filterField?: FreshsalesFieldDefinition;
  filterValue?: string;
  matchMode: "exact" | "contains";
  owner?: string;
  dateFrom?: string;
  dateTo?: string;
  viewName?: string;
}): boolean {
  return matchesSource(record, filters)
    && matchesDynamicFilter(record, filters.filterField, filters.filterValue, filters.matchMode, "filter_value")
    && matchesOwner(record, filters.owner)
    && matchesDateRange(record, filters.dateFrom, filters.dateTo);
}

function matchesSource(record: Record<string, unknown>, filters: {
  sourceField?: FreshsalesFieldDefinition;
  source?: string;
  matchMode: "exact" | "contains";
  viewName?: string;
}): boolean {
  if (!filters.source) {
    return true;
  }

  const sourceValue = filters.sourceField ? fieldValueFor(record, filters.sourceField) : undefined;
  if (sourceValue !== undefined && sourceValue !== null && String(sourceValue).trim() !== "") {
    return matchesText(sourceValue, filters.source, filters.matchMode);
  }

  return filters.viewName ? matchesViewName(filters.viewName, filters.source) : true;
}

function matchesViewName(viewName: string, source: string): boolean {
  return normalizeToken(viewName).includes(normalizeToken(source));
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchesDynamicFilter(
  record: Record<string, unknown>,
  field: FreshsalesFieldDefinition | undefined,
  filterValue: string | undefined,
  matchMode: "exact" | "contains",
  valueName: string
): boolean {
  if (!field) {
    return true;
  }

  if (!filterValue) {
    throw new AppError("MISSING_FILTER_VALUE", `${valueName} is required when its field is provided.`);
  }

  return matchesText(fieldValueFor(record, field), filterValue, matchMode);
}

function matchesText(candidate: unknown, expected: string, mode: "exact" | "contains"): boolean {
  const left = String(candidate ?? "").toLowerCase();
  const right = expected.toLowerCase();
  return mode === "contains" ? left.includes(right) : left === right;
}

function compareFieldValues(left: Record<string, unknown>, right: Record<string, unknown>, field: FreshsalesFieldDefinition, order: "asc" | "desc"): number {
  const direction = order === "asc" ? 1 : -1;
  return compareValues(fieldValueFor(left, field), fieldValueFor(right, field)) * direction;
}

function matchesDateRange(record: Record<string, unknown>, dateFrom?: string, dateTo?: string): boolean {
  const raw = String(record.created_at ?? record.updated_at ?? "");
  if (!raw) {
    return !dateFrom && !dateTo;
  }

  const timestamp = new Date(raw).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }

  if (dateFrom && timestamp < new Date(dateFrom).getTime()) {
    return false;
  }

  if (dateTo && timestamp > new Date(dateTo).getTime()) {
    return false;
  }

  return true;
}

function compareValues(left: unknown, right: unknown): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  const leftDate = Date.parse(String(left ?? ""));
  const rightDate = Date.parse(String(right ?? ""));
  if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) {
    return leftDate - rightDate;
  }

  return String(left ?? "").localeCompare(String(right ?? ""));
}

function matchesOwner(record: Record<string, unknown>, owner?: string): boolean {
  if (!owner) {
    return true;
  }

  const haystacks = [ownerNameFromRecord(record), String(record.owner_id ?? "")].map(value => value?.toLowerCase() ?? "");
  return haystacks.some(candidate => candidate === owner.toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
