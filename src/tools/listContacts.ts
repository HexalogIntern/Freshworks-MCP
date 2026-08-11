import { z } from "zod";

import { emailFromRecord, getCollection, nameFromRecord, ownerNameFromRecord } from "../freshsales/mappers.js";
import { AppError } from "../utils/errors.js";
import type { ToolExecutionContext } from "./common.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    view: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().min(1).max(100).optional(),
    owner: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface ListContactsParams {
  view?: string;
  source?: string;
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
    "Preview or list live Freshsales contacts from the configured default contacts view, or pass view to target any saved Freshsales view by name or id. Optional source and owner filters are applied after fetching the view page.",
  inputSchema: schema,
  resolve(input): ListContactsParams {
    return {
      view: input.view,
      source: input.source,
      owner: input.owner,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params) {
    return params.view ? 2 : 1;
  },
  async execute(params, ctx) {
    const viewId = params.view
      ? await resolveContactViewId(ctx, params.view)
      : ctx.config.defaultContactsViewId;

    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/contacts/view/${viewId}`, {
      query: {
        page: params.page,
        per_page: params.perPage,
        include: "owner"
      }
    });

    const contacts = getCollection(payload, "contacts")
      .filter(contact => matchesSource(contact, params.source))
      .filter(contact => matchesOwner(contact, params.owner))
      .map(contact => ({
        id: contact.id ?? null,
        name: nameFromRecord(contact),
        email: emailFromRecord(contact),
        owner: ownerNameFromRecord(contact),
        job_title: contact.job_title ?? null,
        company: contact.company_name ?? contact.account_name ?? contact.sales_account_name ?? null,
        mobile_number: contact.mobile_number ?? null,
        work_number: contact.work_number ?? null,
        created_at: contact.created_at ?? null,
        updated_at: contact.updated_at ?? null,
        custom_field: contact.custom_field ?? null
      }));

    return {
      data: contacts,
      page: params.page,
      per_page: params.perPage,
      filters_applied: {
        view: params.view ?? null,
        source: params.source ?? null,
        owner: params.owner ?? null
      }
    };
  },
  willCallFreshsales: true
});

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
