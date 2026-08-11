import { z } from "zod";

import { emailFromRecord, getPrimaryRecord, nameFromRecord, ownerNameFromRecord } from "../freshsales/mappers.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    id: z.string().trim().min(1).max(100).optional()
  })
  .strict();

interface GetContactParams {
  id: string;
}

export const getContactTool = defineTool({
  name: "get_contact",
  title: "Get Contact",
  description:
    "Preview or fetch one live Freshsales contact by id. The approval call executes a curated read-only lookup.",
  inputSchema: schema,
  resolve(input): GetContactParams {
    if (!input.id) {
      throw new Error("Contact id is required before approval.");
    }

    return { id: input.id };
  },
  estimateCallCount() {
    return 1;
  },
  async execute(params, ctx) {
    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/contacts/${params.id}`, {
      query: {
        include: "owner"
      }
    });

    const contact = getPrimaryRecord(payload, "contact");

    return {
      data: {
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
      }
    };
  },
  willCallFreshsales: true
});
