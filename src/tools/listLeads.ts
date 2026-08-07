import { z } from "zod";

import { emailFromRecord, getCollection, nameFromRecord, ownerNameFromRecord } from "../freshsales/mappers.js";
import { AppError } from "../utils/errors.js";
import type { ToolExecutionContext } from "./common.js";
import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields,
    filter: z.string().trim().min(1).max(100).optional(),
    page: z.number().int().min(1).max(100).default(1),
    per_page: z.number().int().min(1).max(50).default(25)
  })
  .strict();

interface ListLeadsParams {
  filter?: string;
  page: number;
  perPage: number;
}

interface FilterPayload {
  filters?: Array<{ id?: string | number; name?: string }>;
}

export const listLeadsTool = defineTool({
  name: "list_leads",
  title: "List Leads",
  description:
    "Preview or list live Freshsales leads from a whitelisted leads view. First call returns a pending approval preview; second call with approved:true executes the live request.",
  inputSchema: schema,
  resolve(input): ListLeadsParams {
    return {
      filter: input.filter,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params) {
    return params.filter ? 2 : 1;
  },
  async execute(params, ctx) {
    const viewId = params.filter
      ? await resolveLeadViewId(ctx, params.filter)
      : ctx.config.defaultLeadsViewId;

    const payload = await ctx.freshsales.get<Record<string, unknown>>(`/api/leads/view/${viewId}`, {
      query: {
        page: params.page,
        per_page: params.perPage,
        include: "owner"
      }
    });

    const leads = getCollection(payload, "leads").map(lead => ({
      id: lead.id ?? null,
      name: nameFromRecord(lead),
      email: emailFromRecord(lead),
      status: String(lead.status_name ?? lead.status ?? "Unknown"),
      owner: ownerNameFromRecord(lead),
      created_at: lead.created_at ?? null
    }));

    return {
      data: leads,
      page: params.page,
      per_page: params.perPage,
      total: typeof (payload.meta as { total?: unknown } | undefined)?.total === "number"
        ? (payload.meta as { total: number }).total
        : leads.length
    };
  },
  willCallFreshsales: true
});

async function resolveLeadViewId(ctx: ToolExecutionContext, filter: string): Promise<string> {
  const payload = await ctx.freshsales.get<FilterPayload>("/api/leads/filters");
  const matched = payload.filters?.find(candidate => {
    const id = candidate.id !== undefined ? String(candidate.id) : "";
    const name = candidate.name?.toLowerCase() ?? "";
    return id === filter || name === filter.toLowerCase();
  });

  if (!matched?.id) {
    throw new AppError("INVALID_FILTER", `Unknown Freshsales lead filter: ${filter}.`);
  }

  return String(matched.id);
}
