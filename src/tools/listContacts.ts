import { z } from "zod";

import { emailFromRecord, getCollection, nameFromRecord, ownerNameFromRecord } from "../freshsales/mappers.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    source: z.string().trim().min(1).max(100).optional(),
    owner: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface ListContactsParams {
  source?: string;
  owner?: string;
  page: number;
  perPage: number;
}

export const listContactsTool = defineTool({
  name: "list_contacts",
  title: "List Contacts",
  description:
    "Preview or list live Freshsales contacts from the configured default contacts view. Optional source and owner filters are applied after fetching the view page.",
  inputSchema: schema,
  resolve(input): ListContactsParams {
    return {
      source: input.source,
      owner: input.owner,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount() {
    return 1;
  },
  async execute(params, ctx) {
    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/contacts/view/${ctx.config.defaultContactsViewId}`, {
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
        source: params.source ?? null,
        owner: params.owner ?? null
      }
    };
  },
  willCallFreshsales: true
});

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
