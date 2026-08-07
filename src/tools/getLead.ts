import { z } from "zod";

import { emailFromRecord, getPrimaryRecord, nameFromRecord, ownerNameFromRecord } from "../freshsales/mappers.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    id: z.string().trim().min(1).max(100).optional()
  })
  .strict();

interface GetLeadParams {
  id: string;
}

export const getLeadTool = defineTool({
  name: "get_lead",
  title: "Get Lead",
  description:
    "Preview or fetch one live Freshsales lead by id. The approval call executes a curated read-only lookup.",
  inputSchema: schema,
  resolve(input): GetLeadParams {
    if (!input.id) {
      throw new Error("Lead id is required before approval.");
    }

    return { id: input.id };
  },
  estimateCallCount() {
    return 1;
  },
  async execute(params, ctx) {
    const payload = await ctx.freshsales.get<Record<string, unknown>>(`/api/leads/${params.id}`, {
      query: {
        include: "owner"
      }
    });

    const lead = getPrimaryRecord(payload, "lead");

    return {
      data: {
        id: lead.id ?? null,
        name: nameFromRecord(lead),
        email: emailFromRecord(lead),
        status: lead.status_name ?? lead.status ?? null,
        owner: ownerNameFromRecord(lead),
        company: lead.company_name ?? lead.company ?? null,
        phone: lead.mobile_number ?? lead.work_number ?? null,
        created_at: lead.created_at ?? null,
        updated_at: lead.updated_at ?? null,
        lead_score: lead.lead_score ?? null,
        last_contacted: lead.last_contacted ?? null
      }
    };
  },
  willCallFreshsales: true
});
