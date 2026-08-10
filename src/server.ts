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
  void logFreshsalesSanityCheck(freshsales, logger);

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

async function logFreshsalesSanityCheck(
  freshsales: FreshsalesClient,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    const payload = await freshsales.get<Record<string, unknown>>("api/contacts", {
      query: {
        page: 1,
        per_page: 1
      }
    });
    logger.info("freshsales_sanity_check", {
      contact_count: contactCountFromPayload(payload)
    });
  } catch (error) {
    logger.warn("freshsales_sanity_check_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function contactCountFromPayload(payload: Record<string, unknown>): number | null {
  const meta = payload.meta;
  if (meta !== null && typeof meta === "object") {
    const total = (meta as Record<string, unknown>).total;
    if (typeof total === "number") {
      return total;
    }
  }

  const total = payload.total;
  return typeof total === "number" ? total : null;
}

const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isDirectRun) {
  const { config, httpServer, close } = await bootstrap();

  // Without these, an unhandled rejection or a synchronous throw outside
  // an Express handler crashes the process with nothing but Node's default
  // stderr dump - which Render's log pipeline was silently swallowing
  // (no request-level logs and no visible crash reason before restart).
  // Logging first, in our own structured JSON format, means the actual
  // error and stack trace show up before the process exits and restarts.
  process.on("uncaughtException", error => {
    console.error(JSON.stringify({
      level: "error",
      event: "uncaught_exception",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }));
    process.exit(1);
  });

  process.on("unhandledRejection", reason => {
    console.error(JSON.stringify({
      level: "error",
      event: "unhandled_rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    }));
    process.exit(1);
  });

  httpServer.listen(config.port, () => {
    console.info(JSON.stringify({ level: "info", event: "server_started", port: config.port }));
  });

  const shutdown = async (signal: string) => {
    // Distinguishes an intentional stop/restart (Render cycling the
    // instance, e.g. on deploy) from an actual crash, since both were
    // previously indistinguishable in the logs.
    console.info(JSON.stringify({ level: "info", event: "shutdown_signal_received", signal }));
    await close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
