import { getConfig } from "../src/config.js";
import { FreshsalesClient } from "../src/freshsales/client.js";
import { fetchFieldSchema, type FreshsalesFieldDefinition, type FieldSchemaEntity } from "../src/freshsales/fieldSchema.js";
import { queryRecords, type QueryConditionInput } from "../src/freshsales/queryEngine.js";
import { DailyUsageTracker } from "../src/state/dailyUsageTracker.js";

type ValidationResult = {
  entity: FieldSchemaEntity;
  api_field: string;
  ui_label: string | null;
  type: string | null;
  operator: string | null;
  status: "pass" | "skip" | "fail";
  total: number | null;
  total_kind: string | null;
  reason?: string;
};

const config = getConfig();
const usageTracker = new DailyUsageTracker(config);
const logger = {
  info() {},
  warn(event: string, fields?: Record<string, unknown>) {
    console.error("WARN", event, JSON.stringify(fields ?? {}));
  },
  error(event: string, fields?: Record<string, unknown>) {
    console.error("ERR", event, JSON.stringify(fields ?? {}));
  }
};
const ctx = {
  config,
  freshsales: new FreshsalesClient({ config, usageTracker, logger }),
  approvalStore: null as never,
  usageTracker,
  logger,
  now: () => new Date()
};

const results: ValidationResult[] = [];

for (const entity of ["contacts", "deals"] as const) {
  const fields = await fetchFieldSchema(ctx, entity, { forceRefresh: true });
  for (const field of fields) {
    const condition = conditionFor(field);
    if (!condition) {
      results.push({
        entity,
        api_field: field.name,
        ui_label: field.label ?? null,
        type: field.type ?? null,
        operator: null,
        status: "skip",
        total: null,
        total_kind: null,
        reason: "No safe generic validation condition for this field."
      });
      continue;
    }

    try {
      const result = await queryRecords(ctx, {
        entity,
        groups: [{ logic: "and", conditions: [condition] }],
        page: 1,
        perPage: 1
      });
      results.push({
        entity,
        api_field: field.name,
        ui_label: field.label ?? null,
        type: field.type ?? null,
        operator: condition.operator,
        status: "pass",
        total: result.total,
        total_kind: result.total_kind
      });
    } catch (error) {
      results.push({
        entity,
        api_field: field.name,
        ui_label: field.label ?? null,
        type: field.type ?? null,
        operator: condition.operator,
        status: "fail",
        total: null,
        total_kind: null,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    await sleep(1100);
  }
}

const summary = {
  total_fields: results.length,
  passed: results.filter(result => result.status === "pass").length,
  failed: results.filter(result => result.status === "fail").length,
  skipped: results.filter(result => result.status === "skip").length,
  by_entity: Object.fromEntries((["contacts", "deals"] as const).map(entity => [
    entity,
    {
      total_fields: results.filter(result => result.entity === entity).length,
      passed: results.filter(result => result.entity === entity && result.status === "pass").length,
      failed: results.filter(result => result.entity === entity && result.status === "fail").length,
      skipped: results.filter(result => result.entity === entity && result.status === "skip").length
    }
  ]))
};

console.log(JSON.stringify({ summary, failures: results.filter(result => result.status === "fail"), skipped: results.filter(result => result.status === "skip") }, null, 2));

function conditionFor(field: FreshsalesFieldDefinition): QueryConditionInput | null {
  const type = field.type?.toLowerCase() ?? "text";
  if (type === "dropdown") {
    const firstChoice = Object.values(field.choiceLabelById ?? {})[0];
    return firstChoice ? { field: field.name, operator: "is", value: firstChoice } : { field: field.name, operator: "is_not_null" };
  }
  if (type === "multi_select_dropdown") {
    const firstChoice = Object.values(field.choiceLabelById ?? {})[0];
    return firstChoice ? { field: field.name, operator: "contains_any", value: [firstChoice] } : { field: field.name, operator: "is_not_null" };
  }
  if (type === "date" || type === "number" || type === "checkbox" || type === "boolean") {
    return { field: field.name, operator: "is_not_null" };
  }
  if (type === "textarea") {
    return { field: field.name, operator: "is_not_null" };
  }
  if (type === "text" || type === "email" || type === "phone" || type === "auto_complete") {
    return { field: field.name, operator: "is_not_null" };
  }
  return { field: field.name, operator: "is_not_null" };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
