import type { JsonRecord } from "../types.js";
import type { ToolDefinition } from "./common.js";
import { getContactTool } from "./getContact.js";
import { getDealTool } from "./getDeal.js";
import { listContactsTool } from "./listContacts.js";
import { listDealsTool } from "./listDeals.js";
import { listNotesTool } from "./listNotes.js";
import { pipelineSummaryTool } from "./pipelineSummary.js";
import { searchContactsTool } from "./searchContacts.js";
import { usageStatusTool } from "./usageStatus.js";

export const toolDefinitions: Array<ToolDefinition<any, any, JsonRecord>> = [
  listContactsTool,
  getContactTool,
  listDealsTool,
  getDealTool,
  searchContactsTool,
  listNotesTool,
  pipelineSummaryTool,
  usageStatusTool
];
