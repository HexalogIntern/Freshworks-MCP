import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
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
  defaultContactsViewId: "contact-view",
  defaultDealsViewId: "deal-view",
  mcpServerToken: "mcp-secret",
  oauthClientId: "claude-client",
  oauthClientSecret: "claude-secret",
  dailyCallLimit: 200,
  approvalTtlSeconds: 300,
  resetTimeZone: "UTC",
  allowedOrigins: [],
  allowedHosts: [],
  max429Retries: 1,
  maxRetryWaitMs: 2000,
  localRateLimitPerMinute: 60,
  pipelineSummaryMaxPages: 5,
  freshsalesRequestTimeoutMs: 10000,
  mcpRequestTimeoutMs: 25000
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

describe("request logging", () => {
  it("logs method, path, status, and duration for /health without touching the transport", async () => {
    const info = vi.fn();
    const app = createHttpApp({
      config,
      logger: { info, warn: vi.fn(), error: vi.fn() },
      transport: { handleRequest: vi.fn() } as never
    });

    await invokeHealth(app);

    expect(info).toHaveBeenCalledWith(
      "http_request",
      expect.objectContaining({ method: "GET", path: "/health", status: 200 })
    );
    const [, fields] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.duration_ms).toBeTypeOf("number");
  });

  it("logs the MCP method and tool name for /mcp tool calls without logging params or bodies", async () => {
    const info = vi.fn();
    const handleRequest = vi.fn(async (_req, res) => {
      res.end(JSON.stringify({ ok: true }));
    });
    const app = createHttpApp({
      config,
      logger: { info, warn: vi.fn(), error: vi.fn() },
      transport: { handleRequest } as never
    });

    await invokeApp(app, {
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer mcp-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_contacts", arguments: { secret_looking_field: "should-not-be-logged" } }
      })
    });

    const mcpLogCall = info.mock.calls.find(call => call[1]?.path === "/mcp");
    expect(mcpLogCall?.[1]).toMatchObject({ mcp_method: "tools/call", tool: "list_contacts", status: 200 });
    expect(JSON.stringify(mcpLogCall)).not.toContain("should-not-be-logged");
  });
});

describe("/mcp request timeout", () => {
  it("responds with REQUEST_TIMEOUT instead of hanging when the transport never resolves", async () => {
    const shortTimeoutConfig: AppConfig = { ...config, mcpRequestTimeoutMs: 30 };
    const handleRequest = vi.fn(() => new Promise(() => {})); // simulates a hang deep in the transport
    const app = createHttpApp({
      config: shortTimeoutConfig,
      logger,
      transport: { handleRequest } as never
    });

    const response = await invokeApp(app, {
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer mcp-secret",
        "content-type": "application/json"
      },
      body: "{}"
    });

    expect(response.statusCode).toBe(504);
    expect(response.body).toMatchObject({ error: { code: "REQUEST_TIMEOUT" } });
  });
});

describe("OAuth shim", () => {
  it("discovers endpoints, exchanges a code, and accepts the OAuth bearer for MCP", async () => {
    const handleRequest = vi.fn(async (_req, res) => {
      res.end(JSON.stringify({ ok: true }));
    });
    const app = createHttpApp({
      config,
      logger,
      transport: { handleRequest } as never
    });

    const metadata = await invokeApp(app, {
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
      headers: {
        host: "freshworks-mcp.onrender.com",
        "x-forwarded-proto": "https"
      }
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).toMatchObject({
      issuer: "https://freshworks-mcp.onrender.com",
      authorization_endpoint: "https://freshworks-mcp.onrender.com/authorize",
      token_endpoint: "https://freshworks-mcp.onrender.com/token"
    });

    const authorize = await invokeApp(app, {
      method: "GET",
      url: "/authorize?response_type=code&client_id=claude-client&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=abc",
      headers: {
        host: "freshworks-mcp.onrender.com",
        "x-forwarded-proto": "https"
      }
    });
    expect(authorize.statusCode).toBe(302);
    const redirect = new URL(String(authorize.headers.get("location")));
    expect(redirect.searchParams.get("state")).toBe("abc");

    const token = await invokeApp(app, {
      method: "POST",
      url: "/token",
      headers: {
        authorization: `Basic ${Buffer.from("claude-client:claude-secret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code") ?? "",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback"
      }).toString()
    });
    expect(token.statusCode).toBe(200);
    expect(token.body).toMatchObject({
      token_type: "Bearer",
      scope: "freshsales.read"
    });

    const mcp = await invokeApp(app, {
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${String(token.body.access_token)}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(mcp.statusCode).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});

async function invokeHealth(app: ReturnType<typeof createHttpApp>): Promise<{
  statusCode: number;
  body: { status?: string; server_time?: string };
}> {
  const response = await invokeApp(app, {
    method: "GET",
    url: "/health"
  });

  return {
    statusCode: response.statusCode,
    body: response.body as { status?: string; server_time?: string }
  };
}

async function invokeApp(app: ReturnType<typeof createHttpApp>, options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{
  statusCode: number;
  headers: Map<string, string | number | readonly string[]>;
  body: Record<string, unknown>;
  text: string;
}> {
  const headers = {
    ...(options.headers ?? {})
  };
  if (options.body && !headers["content-length"]) {
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }

  const request = Object.assign(Readable.from(options.body ? [Buffer.from(options.body)] : []), {
    method: options.method,
    url: options.url,
    headers,
    connection: {}
  });

  const chunks: Buffer[] = [];
  const responseHeaders = new Map<string, string | number | readonly string[]>();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      responseHeaders.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name: string) {
      return responseHeaders.get(name.toLowerCase());
    },
    removeHeader(name: string) {
      responseHeaders.delete(name.toLowerCase());
    },
    write(chunk?: string | Buffer) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      return true;
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

  const rawBody = Buffer.concat(chunks).toString("utf8");
  let body: Record<string, unknown> = {};
  try {
    body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
  } catch {
    body = {};
  }

  return {
    statusCode: response.statusCode,
    headers: responseHeaders,
    body,
    text: rawBody
  };
}
