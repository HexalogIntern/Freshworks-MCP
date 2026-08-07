import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

import { getConfig } from "./config.js";
import { FreshsalesClient } from "./freshsales/client.js";
import { createHttpApp } from "./mcp/http.js";
import { createMcpServer } from "./mcp/server.js";
import { ApprovalStore } from "./state/approvalStore.js";
import { DailyUsageTracker } from "./state/dailyUsageTracker.js";
import { OAuthStore } from "./state/oauthStore.js";
import { createLogger } from "./utils/logging.js";

export async function bootstrap() {
  const config = getConfig();
  const logger = createLogger();
  const approvalStore = new ApprovalStore();
  const oauthStore = new OAuthStore();
  const usageTracker = new DailyUsageTracker(config);
  const freshsales = new FreshsalesClient({
    config,
    usageTracker,
    logger
  });

  const context = {
    config,
    freshsales,
    approvalStore,
    usageTracker,
    logger,
    now: () => new Date()
  };

  const mcpServer = createMcpServer(context);
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  await mcpServer.connect(transport);

  const app = createHttpApp({
    config,
    logger,
    transport,
    oauthStore
  });

  const httpServer = createServer(app);

  return {
    config,
    app,
    httpServer,
    close: async () => {
      await mcpServer.close();
      httpServer.close();
    }
  };
}

const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isDirectRun) {
  const { config, httpServer, close } = await bootstrap();

  httpServer.listen(config.port, () => {
    console.info(JSON.stringify({ level: "info", event: "server_started", port: config.port }));
  });

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
