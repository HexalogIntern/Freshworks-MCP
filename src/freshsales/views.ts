import { AppError } from "../utils/errors.js";
import type { ToolExecutionContext } from "../tools/common.js";

export interface FreshsalesView {
  id: string;
  name: string;
}

interface FilterPayload {
  filters?: Array<{ id?: string | number; name?: string }>;
}

export async function listContactViews(ctx: ToolExecutionContext): Promise<FreshsalesView[]> {
  return listViews(ctx, "contacts");
}

export async function listDealViews(ctx: ToolExecutionContext): Promise<FreshsalesView[]> {
  return listViews(ctx, "deals");
}

export async function resolveContactViewId(ctx: ToolExecutionContext, view: string): Promise<string> {
  return resolveViewId(await listContactViews(ctx), view, "contact");
}

export async function resolveDealViewId(ctx: ToolExecutionContext, view: string): Promise<string> {
  return resolveViewId(await listDealViews(ctx), view, "deal");
}

async function listViews(ctx: ToolExecutionContext, entity: "contacts" | "deals"): Promise<FreshsalesView[]> {
  const payload = await ctx.freshsales.get<FilterPayload>(`api/${entity}/filters`);
  return (payload.filters ?? [])
    .filter(candidate => candidate.id !== undefined && candidate.id !== null)
    .map(candidate => ({
      id: String(candidate.id),
      name: candidate.name?.trim() || String(candidate.id)
    }));
}

function resolveViewId(views: FreshsalesView[], view: string, entityLabel: "contact" | "deal"): string {
  const normalized = view.toLowerCase();
  const matched = views.find(candidate => candidate.id === view || candidate.name.toLowerCase() === normalized);

  if (!matched) {
    throw new AppError("INVALID_FILTER", `Unknown Freshsales ${entityLabel} filter: ${view}.`);
  }

  return matched.id;
}
