import type { IncomingMessage, ServerResponse } from "node:http";

import { hostHeaderValidation } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/server";
import express, { type NextFunction, type Request, type Response } from "express";

import type { AppConfig } from "../config.js";
import type { Logger } from "../types.js";
import { errorPayload, redactKnownSecrets } from "../utils/errors.js";

export interface HttpAppDependencies {
  config: AppConfig;
  logger: Logger;
  transport: NodeStreamableHTTPServerTransport;
}

export function createHttpApp({ config, logger, transport }: HttpAppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb", type: "application/json" }));

  if (config.allowedHosts.length > 0) {
    app.use(hostHeaderValidation(config.allowedHosts));
  }

  app.use((req, res, next) => {
    applyCors(req, res, config);
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }

    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server_time: new Date().toISOString()
    });
  });

  app.all("/mcp", authenticate(config), async (req, res, next) => {
    try {
      await transport.handleRequest(
        req as IncomingMessage & { auth?: AuthInfo },
        res as ServerResponse,
        req.body
      );
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("http_request_failed", { status: "error" });
    const payload = error instanceof Error
      ? errorPayload("HTTP_ERROR", redactKnownSecrets(error.message, config))
      : errorPayload("HTTP_ERROR", "Request failed.");
    res.status(500).json(payload);
  });

  return app;
}

function authenticate(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.mcpServerToken) {
      next();
      return;
    }

    const authHeader = req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    if (token !== config.mcpServerToken) {
      res.status(401).json(errorPayload("UNAUTHORIZED", "Missing or invalid MCP bearer token."));
      return;
    }

    next();
  };
}

function applyCors(req: Request, res: Response, config: AppConfig): void {
  const origin = req.header("origin");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (!origin) {
    return;
  }

  if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return;
  }
}
