import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createHttpApp } from "../src/mcp/http.js";
import type { Logger } from "../src/types.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  freshsalesApiKey: "freshsales-secret",
  freshsalesDomain: "https://example.myfreshworks.com",
  defaultLeadsViewId: "lead-view",
  defaultDealsViewId: "deal-view",
  mcpServerToken: "mcp-secret",
  dailyCallLimit: 200,
  approvalTtlSeconds: 300,
  resetTimeZone: "UTC",
  allowedOrigins: [],
  allowedHosts: [],
  max429Retries: 1,
  maxRetryWaitMs: 2000,
  localRateLimitPerMinute: 60,
  pipelineSummaryMaxPages: 5
};

describe("health endpoint", () => {
  it("responds without auth and without touching the MCP transport", async () => {
    const handleRequest = vi.fn();
    const app = createHttpApp({
      config,
      logger,
      transport: { handleRequest } as never
    });

    const { statusCode, body } = await invokeHealth(app);

    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.server_time).toBeTypeOf("string");
    expect(handleRequest).not.toHaveBeenCalled();
  });
});

async function invokeHealth(app: ReturnType<typeof createHttpApp>): Promise<{
  statusCode: number;
  body: { status?: string; server_time?: string };
}> {
  const request = Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/health",
    headers: {},
    connection: {}
  });

  const chunks: Buffer[] = [];
  const headers = new Map<string, string | number | readonly string[]>();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      response.emit("finish");
      return response;
    }
  });

  await new Promise<void>((resolve, reject) => {
    response.once("finish", resolve);
    const expressApp = app as unknown as {
      handle(req: unknown, res: unknown, callback: (error?: unknown) => void): void;
    };
    expressApp.handle(request, response, reject);
  });

  return {
    statusCode: response.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: string; server_time?: string }
  };
}
