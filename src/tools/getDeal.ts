import { z } from "zod";

import { amountFromDeal, getPrimaryRecord, linkedAccountFromDeal, linkedContactFromDeal, ownerNameFromRecord, stageNameFromDeal } from "../freshsales/mappers.js";
import { dynamicRecordFromSchema, fetchFieldSchema, isFieldSchemaCacheMiss } from "../freshsales/fieldSchema.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    id: z.string().trim().min(1).max(100).optional()
  })
  .strict();

interface GetDealParams {
  id: string;
}

export const getDealTool = defineTool({
  name: "get_deal",
  title: "Get Deal",
  description:
    "Preview or fetch one live Freshsales deal, including curated linked contact and account details after approval.",
  inputSchema: schema,
  resolve(input): GetDealParams {
    if (!input.id) {
      throw new Error("Deal id is required before approval.");
    }

    return { id: input.id };
  },
  estimateCallCount(_params, ctx) {
    return 1 + (isFieldSchemaCacheMiss(ctx, "deals") ? 1 : 0);
  },
  async execute(params, ctx) {
    const fieldSchema = await fetchFieldSchema(ctx, "deals");
    const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/deals/${params.id}`, {
      query: {
        include: "owner,sales_account,contacts,deal_stage"
      }
    });

    const deal = getPrimaryRecord(payload, "deal");

    return {
      data: {
        ...dynamicRecordFromSchema(deal, fieldSchema),
        id: deal.id ?? null,
        name: deal.name ?? null,
        amount: amountFromDeal(deal),
        stage: stageNameFromDeal(deal),
        owner: ownerNameFromRecord(deal),
        expected_close: deal.expected_close ?? deal.close_date ?? null,
        probability: deal.probability ?? null,
        description: deal.description ?? null,
        linked_contact: linkedContactFromDeal(deal),
        linked_account: linkedAccountFromDeal(deal),
        created_at: deal.created_at ?? null,
        updated_at: deal.updated_at ?? null
      }
    };
  },
  willCallFreshsales: true
});
