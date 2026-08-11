import { z } from "zod";

import { accountNameFromRecord, contactStatusFromRecord, emailFromRecord, getCollection, getPrimaryRecord, nameFromRecord, ownerNameFromRecord, salesAccountsFromRecord, tagNamesFromRecord } from "../freshsales/mappers.js";
import { dynamicRecordFromSchema, fetchFieldSchema, fieldValueFor, isFieldSchemaCacheMiss, validateFieldName, type FreshsalesFieldDefinition } from "../freshsales/fieldSchema.js";
import { AppError } from "../utils/errors.js";
import type { ToolExecutionContext } from "./common.js";
import { approvalFields, defineTool } from "./common.js";

const sortOrderSchema = z.enum(["asc", "desc"]);

const schema = z
  .object({
    ...approvalFields,
    view: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().min(1).max(100).optional(),
    filter_by: z.string().trim().min(1).max(100).optional(),
    filter_value: z.string().trim().min(1).max(200).optional(),
    sort_by: z.string().trim().min(1).max(100).optional(),
    sort_order: sortOrderSchema.default("asc"),
    hydrate_relations: z.boolean().default(false),
    owner: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface ListContactsParams {
  view?: string;
  source?: string;
  filterBy?: string;
  filterValue?: string;
  sortBy?: string;
  sortOrder: "asc" | "desc";
  hydrateRelations: boolean;
  owner?: string;
  page: number;
  perPage: number;
}

interface FilterPayload {
  filters?: Array<{ id?: string | number; name?: string }>;
}

export const listContactsTool = defineTool({
  name: "list_contacts",
  title: "List Contacts",
  description:
    "Preview or list live Freshsales contacts from the configured default contacts view, or pass view to target any saved Freshsales view by name or id. Field output, filter_by, and sort_by are validated against Freshsales contact field metadata.",
  inputSchema: schema,
  resolve(input): ListContactsParams {
    return {
      view: input.view,
      source: input.source,
      filterBy: input.filter_by,
      filterValue: input.filter_value,
      sortBy: input.sort_by,
      sortOrder: input.sort_order,
      hydrateRelations: input.hydrate_relations,
      owner: input.owner,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params, ctx) {
    return (params.view ? 2 : 1) + (isFieldSchemaCacheMiss(ctx, "contacts") ? 1 : 0) + (params.hydrateRelations ? params.perPage : 0);
  },
  async execute(params, ctx) {
    if (params.hydrateRelations && params.perPage > 10) {
      throw new AppError("HYDRATION_LIMIT_EXCEEDED", "hydrate_relations is capped at per_page <= 10 to protect the Freshsales daily call budget.");
    }

    const fieldSchema = await fetchFieldSchema(ctx, "contacts");
    const filterField = params.filterBy ? validateFieldName(fieldSchema, params.filterBy) : undefined;
    const sortField = params.sortBy ? validateFieldName(fieldSchema, params.sortBy) : undefined;
    const viewId = params.view
      ? await resolveContactViewId(ctx, params.view)
      : ctx.config.defaultContactsViewId;

    const nativeSort = sortField && nativeContactSortFields.has(sortField.name);

    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/contacts/view/${viewId}`, {
      query: {
        page: params.page,
        per_page: params.perPage,
        include: "owner,sales_account",
        sort: nativeSort ? sortField.name : undefined,
        sort_type: nativeSort ? params.sortOrder : undefined
      }
    });

    const rawContacts = getCollection(payload, "contacts");
    const hydratedContacts = params.hydrateRelations
      ? await hydrateContactRelations(rawContacts, ctx)
      : rawContacts;

    const contacts = hydratedContacts
      .filter(contact => matchesSource(contact, params.source))
      .filter(contact => matchesDynamicFilter(contact, filterField, params.filterValue))
      .filter(contact => matchesOwner(contact, params.owner))
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
      filters_applied: {
        view: params.view ?? null,
        source: params.source ?? null,
        filter_by: params.filterBy ?? null,
        filter_value: params.filterValue ?? null,
        sort_by: params.sortBy ?? null,
        sort_order: params.sortBy ? params.sortOrder : null,
        sort_scope: params.sortBy ? (nativeSort ? "freshsales" : "page") : null,
        hydrate_relations: params.hydrateRelations,
        owner: params.owner ?? null
      }
    };
  },
  willCallFreshsales: true
});

const nativeContactSortFields = new Set(["lead_score", "created_at", "updated_at", "open_deals_amount", "last_contacted"]);

async function resolveContactViewId(ctx: ToolExecutionContext, view: string): Promise<string> {
  const payload = await ctx.freshsales.get<FilterPayload>("api/contacts/filters");
  const matched = payload.filters?.find(candidate => {
    const id = candidate.id !== undefined ? String(candidate.id) : "";
    const name = candidate.name?.toLowerCase() ?? "";
    return id === view || name === view.toLowerCase();
  });

  if (!matched?.id) {
    throw new AppError("INVALID_FILTER", `Unknown Freshsales contact filter: ${view}.`);
  }

  return String(matched.id);
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

function matchesSource(record: Record<string, unknown>, source?: string): boolean {
  if (!source) {
    return true;
  }

  const customField = asRecord(record.custom_field);
  // Freshsales custom-field keys vary by account and the exact source field
  // has not been confirmed yet, so this intentionally checks likely shapes.
  const candidates = [
    customField.source,
    customField.cf_source,
    record.lead_source,
    record.source
  ];

  return candidates.some(candidate => String(candidate ?? "").toLowerCase() === source.toLowerCase());
}

function matchesDynamicFilter(record: Record<string, unknown>, field: FreshsalesFieldDefinition | undefined, filterValue: string | undefined): boolean {
  if (!field) {
    return true;
  }

  if (!filterValue) {
    throw new AppError("MISSING_FILTER_VALUE", "filter_value is required when filter_by is provided.");
  }

  return String(fieldValueFor(record, field) ?? "").toLowerCase() === filterValue.toLowerCase();
}

function compareFieldValues(left: Record<string, unknown>, right: Record<string, unknown>, field: FreshsalesFieldDefinition, order: "asc" | "desc"): number {
  const direction = order === "asc" ? 1 : -1;
  return compareValues(fieldValueFor(left, field), fieldValueFor(right, field)) * direction;
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
