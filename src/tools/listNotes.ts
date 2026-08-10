import { z } from "zod";

import { getCollection, getPrimaryRecord, noteSummary } from "../freshsales/mappers.js";
import { approvalFields, defineTool } from "./common.js";

const entityTypeSchema = z.enum(["lead", "deal", "contact"]);

const schema = z
  .object({
    ...approvalFields,
    entity_type: entityTypeSchema.optional(),
    entity_id: z.string().trim().min(1).max(100).optional()
  })
  .strict();

interface ListNotesParams {
  entityType: "lead" | "deal" | "contact";
  entityId: string;
}

const pathByEntityType: Record<ListNotesParams["entityType"], string> = {
  lead: "leads",
  deal: "deals",
  contact: "contacts"
};

const resourceKeyByEntityType: Record<ListNotesParams["entityType"], string> = {
  lead: "lead",
  deal: "deal",
  contact: "contact"
};

export const listNotesTool = defineTool({
  name: "list_notes",
  title: "List Notes",
  description:
    "Preview or fetch notes tied to one lead, deal, or contact by loading that record with a whitelisted include=notes expansion.",
  inputSchema: schema,
  resolve(input): ListNotesParams {
    if (!input.entity_type || !input.entity_id) {
      throw new Error("entity_type and entity_id are required before approval.");
    }

    return {
      entityType: input.entity_type,
      entityId: input.entity_id
    };
  },
  estimateCallCount() {
    return 1;
  },
  async execute(params, ctx) {
    const path = `api/${pathByEntityType[params.entityType]}/${params.entityId}`;
    const payload = await ctx.freshsales.get<Record<string, unknown>>(path, {
      query: {
        include: "notes"
      }
    });

    const entity = getPrimaryRecord(payload, resourceKeyByEntityType[params.entityType]);
    const notes = getCollection(entity, "notes").map(noteSummary);

    return {
      entity_type: params.entityType,
      entity_id: params.entityId,
      data: notes
    };
  },
  willCallFreshsales: true
});
