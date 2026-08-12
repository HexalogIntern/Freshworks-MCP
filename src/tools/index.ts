import type { JsonRecord } from "../types.js";
import type { ToolDefinition } from "./common.js";
import { contactsSummaryTool } from "./contactsSummary.js";
import { countContactsTool, countDealsTool } from "./countRecords.js";
import { discoverFieldsTool } from "./discoverFields.js";
import { discoverViewsTool } from "./discoverViews.js";
import { exportRecordsTool } from "./exportRecords.js";
import { getContactTool } from "./getContact.js";
import { getDealTool } from "./getDeal.js";
import { listContactsTool } from "./listContacts.js";
import { listDealsTool } from "./listDeals.js";
import { listNotesTool } from "./listNotes.js";
import { pipelineSummaryTool } from "./pipelineSummary.js";
import { queryRecordsTool } from "./queryRecords.js";
import { runReportTool } from "./runReport.js";
import { searchContactsTool } from "./searchContacts.js";
import { usageStatusTool } from "./usageStatus.js";

export const toolDefinitions: Array<ToolDefinition<any, any, JsonRecord>> = [
  discoverFieldsTool,
  discoverViewsTool,
  listContactsTool,
  queryRecordsTool,
  runReportTool,
  exportRecordsTool,
  countContactsTool,
  getContactTool,
  listDealsTool,
  countDealsTool,
  getDealTool,
  searchContactsTool,
  listNotesTool,
  contactsSummaryTool,
  pipelineSummaryTool,
  usageStatusTool
];
