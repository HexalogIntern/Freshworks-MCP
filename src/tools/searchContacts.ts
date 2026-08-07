import { z } from "zod";

import { emailFromRecord, getCollection, nameFromRecord, ownerNameFromRecord } from "../freshsales/mappers.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    query: z.string().trim().min(2).max(120).optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface SearchContactsParams {
  query: string;
  page: number;
  perPage: number;
}

export const searchContactsTool = defineTool({
  name: "search_contacts",
  title: "Search Contacts",
  description:
    "Preview or search live Freshsales contacts by name or email. Search executes only after explicit approval.",
  inputSchema: schema,
  resolve(input): SearchContactsParams {
    if (!input.query) {
      throw new Error("A search query is required before approval.");
    }

    return {
      query: input.query,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount() {
    return 1;
  },
  async execute(params, ctx) {
    const payload = await ctx.freshsales.get<Record<string, unknown>>("/api/search", {
      query: {
        q: params.query,
        include: "contact",
        page: params.page,
        per_page: params.perPage
      }
    });

    const results = getCollection(payload, "contacts").length > 0 ? getCollection(payload, "contacts") : getCollection(payload, "results");
    const contacts = results.map(contact => ({
      id: contact.id ?? null,
      name: nameFromRecord(contact),
      email: emailFromRecord(contact),
      owner: ownerNameFromRecord(contact),
      created_at: contact.created_at ?? null
    }));

    return {
      data: contacts,
      page: params.page,
      per_page: params.perPage,
      query: params.query
    };
  },
  willCallFreshsales: true
});
