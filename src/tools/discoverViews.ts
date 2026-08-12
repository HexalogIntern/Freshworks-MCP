import { z } from "zod";

import { fetchFieldSchema, fieldMetadata, isFieldSchemaCacheMiss } from "../freshsales/fieldSchema.js";
import { getCollection } from "../freshsales/mappers.js";
import { inspectFieldCoverage, upsertViewFieldCoverage, type ViewEntity, type ViewFieldCoverage } from "../freshsales/viewCache.js";
import { listContactViews, listDealViews, type FreshsalesView } from "../freshsales/views.js";
import type { JsonRecord } from "../types.js";
import { approvalFields, defineTool, type ToolExecutionContext } from "./common.js";

const entitySchema = z.enum(["contacts", "deals", "both"]);

const schema = z
  .object({
    ...approvalFields,
    entity: entitySchema.default("both"),
    sample_pages_per_view: z.number().int().min(1).max(3).default(1)
  })
  .strict();

interface DiscoverViewsParams {
  entity: "contacts" | "deals" | "both";
  samplePagesPerView: number;
  plannedViews: Array<{ entity: ViewEntity; views: FreshsalesView[] }>;
}

interface WarmViewCachesResult extends JsonRecord {
  views_scanned: number;
  total_sample_calls: number;
  findings: Array<{
    entity: ViewEntity;
    view_id: string;
    view_name: string;
    fields_detected: Array<{ api_field: string; ui_label: string | null }>;
    strong_filter_candidates: string[];
  }>;
}

export async function warmViewCaches(
  ctx: ToolExecutionContext,
  entity: "contacts" | "deals" | "both" = "both",
  samplePagesPerView = 1
): Promise<WarmViewCachesResult> {
  const boundedSamplePages = Math.min(Math.max(Math.trunc(samplePagesPerView), 1), 3);
  const plannedViews = await viewsForEntity(ctx, entity);

  return warmPlannedViewCaches(ctx, plannedViews, boundedSamplePages);
}

export const discoverViewsTool = defineTool({
  name: "discover_views",
  title: "Discover Views",
  description:
    "Proactively scans all saved Freshsales contact and/or deal views and caches which fields and sample values each view contains. Findings include api_field and ui_label when field metadata is available. This lets later filtered list_contacts and list_deals requests with source/filter criteria skip broad multi-view discovery and go directly to likely matching views. Run once after deploy, and again after adding custom Freshsales views or when the view cache may be stale.",
  inputSchema: schema,
  async resolve(input, ctx): Promise<DiscoverViewsParams> {
    return {
      entity: input.entity,
      samplePagesPerView: input.sample_pages_per_view,
      plannedViews: await viewsForEntity(ctx, input.entity)
    };
  },
  estimateCallCount(params, ctx) {
    return params.plannedViews.reduce((total, plan) => {
      const schemaCall = isFieldSchemaCacheMiss(ctx, plan.entity) ? 1 : 0;
      return total + schemaCall + plan.views.length * params.samplePagesPerView;
    }, 0);
  },
  async execute(params, ctx) {
    return warmPlannedViewCaches(ctx, params.plannedViews, params.samplePagesPerView);
  },
  willCallFreshsales: true
});

async function viewsForEntity(
  ctx: ToolExecutionContext,
  entity: "contacts" | "deals" | "both"
): Promise<Array<{ entity: ViewEntity; views: FreshsalesView[] }>> {
  const plans: Array<{ entity: ViewEntity; views: FreshsalesView[] }> = [];

  if (entity === "contacts" || entity === "both") {
    plans.push({ entity: "contacts", views: await listContactViews(ctx) });
  }

  if (entity === "deals" || entity === "both") {
    plans.push({ entity: "deals", views: await listDealViews(ctx) });
  }

  return plans;
}

async function warmPlannedViewCaches(
  ctx: ToolExecutionContext,
  plannedViews: Array<{ entity: ViewEntity; views: FreshsalesView[] }>,
  samplePagesPerView: number
): Promise<WarmViewCachesResult> {
  const findings: WarmViewCachesResult["findings"] = [];
  let totalSampleCalls = 0;

  for (const plan of plannedViews) {
    const coverage: ViewFieldCoverage[] = [];
    const fieldLabels = new Map(
      fieldMetadata(await fetchFieldSchema(ctx, plan.entity)).map(field => [field.api_field, field.ui_label])
    );

    for (const view of plan.views) {
      ctx.logger.info("freshsales_view_discovery_started", {
        entity: plan.entity,
        view_id: view.id,
        view_name: view.name,
        sample_pages_per_view: samplePagesPerView
      });

      const records: Array<Record<string, unknown>> = [];
      for (let page = 1; page <= samplePagesPerView; page += 1) {
        const payload = await ctx.freshsales.get<Record<string, unknown>>(`api/${plan.entity}/view/${view.id}`, {
          query: {
            page,
            per_page: 50
          }
        });
        totalSampleCalls += 1;

        const pageRecords = getCollection(payload, plan.entity);
        records.push(...pageRecords);
        if (pageRecords.length < 50) {
          break;
        }
      }

      const viewCoverage = inspectFieldCoverage(plan.entity, view, records);
      coverage.push(viewCoverage);
      findings.push({
        entity: plan.entity,
        view_id: view.id,
        view_name: view.name,
        fields_detected: viewCoverage.populatedFields.map(field => {
          const apiField = field.field.startsWith("custom_field.") ? field.field.slice("custom_field.".length) : field.field;
          return {
            api_field: apiField,
            ui_label: fieldLabels.get(apiField) ?? null
          };
        }),
        strong_filter_candidates: viewCoverage.strongFilterCandidates
      });
    }

    upsertViewFieldCoverage(plan.entity, coverage, ctx.config);
  }

  return {
    views_scanned: findings.length,
    total_sample_calls: totalSampleCalls,
    findings
  };
}
