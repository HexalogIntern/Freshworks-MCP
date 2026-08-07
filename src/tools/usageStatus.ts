import { z } from "zod";

import { approvalFields, defineTool } from "./common.js";

const schema = z
  .object({
    ...approvalFields
  })
  .strict();

export const usageStatusTool = defineTool({
  name: "usage_status",
  title: "Usage Status",
  description:
    "Preview or inspect the local daily Freshsales call budget. This tool follows the same approval flow but never calls Freshsales and never increments usage.",
  inputSchema: schema,
  resolve() {
    return {};
  },
  estimateCallCount() {
    return 0;
  },
  async execute(_params, ctx) {
    return ctx.usageTracker.getSnapshot(ctx.now());
  },
  willCallFreshsales: false
});
