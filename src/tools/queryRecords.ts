import { z } from "zod";

import { queryRecords, type QueryConditionInput, type QueryGroupInput } from "../freshsales/queryEngine.js";
import { isFieldSchemaCacheMiss } from "../freshsales/fieldSchema.js";
import { approvalFields, defineTool } from "./common.js";

const entitySchema = z.enum(["contacts", "deals"]);
const operatorSchema = z.enum([
  "is", "equals", "contains", "not_contains", "starts_with", "is_in", "not_in",
  "contains_any", "contains_all", "is_null", "is_not_null", "between", "before",
  "after", "in_the_last_N_days", "in_the_next_N_days", "greater_than", "less_than",
  "is_true", "is_false"
]);
const conditionSchema = z.object({
  field: z.string().trim().min(1).max(120),
  operator: operatorSchema,
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
    z.null()
  ]).optional()
}).strict();
const groupSchema = z.object({
  logic: z.enum(["and", "or"]).default("and"),
  conditions: z.array(conditionSchema).max(20).default([])
}).strict();

const schema = z.object({
  ...approvalFields,
  entity: entitySchema,
  filters: z.array(conditionSchema).max(20).default([]),
  filter_groups: z.array(groupSchema).max(10).default([]),
  query: z.string().trim().min(1).max(200).optional(),
  include_notes: z.boolean().default(false),
  include_linked: z.boolean().default(false),
  fields: z.array(z.string().trim().min(1).max(120)).max(80).optional(),
  page: z.number().int().min(1).max(1000).default(1),
  per_page: z.number().int().min(1).max(100).default(25)
}).strict();

interface Params {
  entity: "contacts" | "deals";
  groups: QueryGroupInput[];
  query?: string;
  includeNotes: boolean;
  includeLinked: boolean;
  fields?: string[];
  page: number;
  perPage: number;
}

export const queryRecordsTool = defineTool({
  name: "query_records",
  title: "Query Records",
  description:
    "Field-agnostic Freshsales query tool for contacts and deals. filters use AND; filter_groups can express AND or OR groups. Field names accept raw API field names or UI labels. Dropdown labels are resolved to Freshsales ids and unknown labels fail loudly. OR groups are executed as merged native queries, so totals are marked merged.",
  inputSchema: schema,
  resolve(input): Params {
    const groups = input.filter_groups.length > 0
      ? input.filter_groups as QueryGroupInput[]
      : [{ logic: "and" as const, conditions: input.filters as QueryConditionInput[] }];
    return {
      entity: input.entity,
      groups,
      query: input.query,
      includeNotes: input.include_notes,
      includeLinked: input.include_linked,
      fields: input.fields,
      page: input.page,
      perPage: input.per_page
    };
  },
  estimateCallCount(params, ctx) {
    const nativeGroups = params.groups.some(group => group.logic === "or")
      ? params.groups.reduce((sum, group) => sum + Math.max(group.conditions.length, 1), 0)
      : 1;
    const enrich = (params.includeNotes || params.includeLinked) ? params.perPage : 0;
    return nativeGroups + enrich + (isFieldSchemaCacheMiss(ctx, params.entity) ? 1 : 0);
  },
  async execute(params, ctx) {
    return {
      ...await queryRecords(ctx, {
      entity: params.entity,
      groups: params.groups,
      query: params.query,
      includeNotes: params.includeNotes,
      includeLinked: params.includeLinked,
      fields: params.fields,
      page: params.page,
      perPage: params.perPage
      })
    };
  },
  willCallFreshsales: true
});
