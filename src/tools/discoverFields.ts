import { z } from "zod";

import { fetchFieldSchema, fieldMetadata, isFieldSchemaCacheMiss, type FieldSchemaEntity } from "../freshsales/fieldSchema.js";
import type { JsonRecord } from "../types.js";
import { approvalFields, defineTool } from "./common.js";

const entitySchema = z.enum(["contacts", "deals", "both"]);

const schema = z
  .object({
    ...approvalFields,
    entity: entitySchema.default("both"),
    refresh: z.boolean().default(false)
  })
  .strict();

interface DiscoverFieldsParams {
  entity: "contacts" | "deals" | "both";
  refresh: boolean;
}

export const discoverFieldsTool = defineTool({
  name: "discover_fields",
  title: "Discover Fields",
  description:
    "Fetches Freshsales contact and/or deal field metadata and returns api_field with the matching ui_label. Use this to see which raw API field names and UI display labels are accepted by filter_by, sort_by, and group_by.",
  inputSchema: schema,
  resolve(input): DiscoverFieldsParams {
    return {
      entity: input.entity,
      refresh: input.refresh
    };
  },
  estimateCallCount(params, ctx) {
    return entitiesFor(params.entity)
      .filter(entity => params.refresh || isFieldSchemaCacheMiss(ctx, entity))
      .length;
  },
  async execute(params, ctx) {
    const result: JsonRecord = {};
    for (const entity of entitiesFor(params.entity)) {
      const fields = await fetchFieldSchema(ctx, entity, { forceRefresh: params.refresh });
      result[entity] = {
        count: fields.length,
        fields: fieldMetadata(fields)
      };
    }

    return result;
  },
  willCallFreshsales: true
});

function entitiesFor(entity: DiscoverFieldsParams["entity"]): FieldSchemaEntity[] {
  return entity === "both" ? ["contacts", "deals"] : [entity];
}
