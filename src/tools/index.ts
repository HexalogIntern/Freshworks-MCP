import type { JsonRecord } from "../types.js";
import type { ToolDefinition } from "./common.js";
import { getDealTool } from "./getDeal.js";
import { getLeadTool } from "./getLead.js";
import { listDealsTool } from "./listDeals.js";
import { listLeadsTool } from "./listLeads.js";
import { listNotesTool } from "./listNotes.js";
import { pipelineSummaryTool } from "./pipelineSummary.js";
import { searchContactsTool } from "./searchContacts.js";
import { usageStatusTool } from "./usageStatus.js";

export const toolDefinitions: Array<ToolDefinition<any, any, JsonRecord>> = [
  listLeadsTool,
  getLeadTool,
  listDealsTool,
  getDealTool,
  searchContactsTool,
  listNotesTool,
  pipelineSummaryTool,
  usageStatusTool
];
