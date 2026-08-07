import type { IncomingMessage, ServerResponse } from "node:http";

import { hostHeaderValidation } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { AuthInfo } from "@modelcontextprotocol/server";
import express, { type NextFunction, type Request, type Response } from "express";

import type { AppConfig } from "../config.js";
import { OAuthStore } from "../state/oauthStore.js";
import type { Logger } from "../types.js";
import { AppError, errorPayload, redactKnownSecrets } from "../utils/errors.js";

export interface HttpAppDependencies {
  config: AppConfig;
  logger: Logger;
  transport: NodeStreamableHTTPServerTransport;
  oauthStore?: OAuthStore;
}

export function createHttpApp({ config, logger, transport, oauthStore = new OAuthStore() }: HttpAppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb", type: "application/json" }));
  app.use(express.urlencoded({ extended: false }));

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

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const issuer = originFromRequest(req);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["plain", "S256"]
    });
  });

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const issuer = originFromRequest(req);
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"]
    });
  });

  app.get("/authorize", (req, res) => {
    if (!isOAuthConfigured(config)) {
      res.status(404).json(errorPayload("OAUTH_NOT_CONFIGURED", "OAuth is not configured for this server."));
      return;
    }

    const query = req.query;
    const clientId = stringQuery(query.client_id);
    const redirectUri = stringQuery(query.redirect_uri);
    const responseType = stringQuery(query.response_type);
    const state = stringQuery(query.state);
    const codeChallenge = stringQuery(query.code_challenge);
    const codeChallengeMethod = stringQuery(query.code_challenge_method);

    if (clientId !== config.oauthClientId || responseType !== "code" || !redirectUri) {
      res.status(400).json(errorPayload("INVALID_REQUEST", "Invalid OAuth authorization request."));
      return;
    }

    if (codeChallengeMethod && codeChallengeMethod !== "plain" && codeChallengeMethod !== "S256") {
      res.status(400).json(errorPayload("INVALID_REQUEST", "Unsupported PKCE challenge method."));
      return;
    }

    const code = oauthStore.createAuthorizationCode({
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      now: new Date()
    });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) {
      redirect.searchParams.set("state", state);
    }

    res.redirect(302, redirect.toString());
  });

  app.post("/token", (req, res) => {
    try {
      if (!isOAuthConfigured(config)) {
        throw new AppError("OAUTH_NOT_CONFIGURED", "OAuth is not configured for this server.", 404);
      }

      const clientAuth = parseClientAuth(req, config);
      if (!clientAuth.valid) {
        throw new AppError("INVALID_CLIENT", "Invalid OAuth client credentials.", 401);
      }

      const grantType = stringBody(req.body.grant_type);
      if (grantType === "authorization_code") {
        const tokenSet = oauthStore.exchangeAuthorizationCode({
          code: requireBodyString(req.body.code, "code"),
          clientId: clientAuth.clientId,
          redirectUri: requireBodyString(req.body.redirect_uri, "redirect_uri"),
          codeVerifier: stringBody(req.body.code_verifier),
          now: new Date()
        });
        res.json(toTokenResponse(tokenSet));
        return;
      }

      if (grantType === "refresh_token") {
        const tokenSet = oauthStore.refreshAccessToken({
          refreshToken: requireBodyString(req.body.refresh_token, "refresh_token"),
          clientId: clientAuth.clientId,
          now: new Date()
        });
        res.json(toTokenResponse(tokenSet));
        return;
      }

      throw new AppError("UNSUPPORTED_GRANT_TYPE", "Unsupported OAuth grant type.", 400);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 400;
      const code = error instanceof AppError ? error.code : "INVALID_REQUEST";
      const message = error instanceof Error ? redactKnownSecrets(error.message, config) : "Invalid OAuth token request.";
      res.status(status).json(errorPayload(code, message));
    }
  });

  app.all("/mcp", authenticate(config, oauthStore), async (req, res, next) => {
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

function authenticate(config: AppConfig, oauthStore: OAuthStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.mcpServerToken && !isOAuthConfigured(config)) {
      next();
      return;
    }

    const authHeader = req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const isStaticBearer = Boolean(config.mcpServerToken && token === config.mcpServerToken);
    const isOAuthBearer = Boolean(token && isOAuthConfigured(config) && oauthStore.hasAccessToken(token, new Date()));

    if (!isStaticBearer && !isOAuthBearer) {
      res.status(401).json(errorPayload("UNAUTHORIZED", "Missing or invalid MCP bearer token."));
      return;
    }

    next();
  };
}

function isOAuthConfigured(config: AppConfig): config is AppConfig & {
  oauthClientId: string;
  oauthClientSecret: string;
} {
  return Boolean(config.oauthClientId && config.oauthClientSecret);
}

function originFromRequest(req: Request): string {
  const protocol = req.header("x-forwarded-proto") ?? req.protocol;
  const host = req.header("x-forwarded-host") ?? req.header("host") ?? "localhost";
  return `${protocol}://${host}`;
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringBody(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireBodyString(value: unknown, fieldName: string): string {
  const result = stringBody(value);
  if (!result) {
    throw new AppError("INVALID_REQUEST", `Missing OAuth field: ${fieldName}.`, 400);
  }

  return result;
}

function parseClientAuth(req: Request, config: AppConfig & {
  oauthClientId: string;
  oauthClientSecret: string;
}): { valid: boolean; clientId: string } {
  const basic = parseBasicAuth(req.header("authorization"));
  const clientId = basic?.clientId ?? stringBody(req.body.client_id) ?? "";
  const clientSecret = basic?.clientSecret ?? stringBody(req.body.client_secret) ?? "";

  return {
    clientId,
    valid: clientId === config.oauthClientId && clientSecret === config.oauthClientSecret
  };
}

function parseBasicAuth(authHeader: string | undefined): { clientId: string; clientSecret: string } | undefined {
  if (!authHeader?.startsWith("Basic ")) {
    return undefined;
  }

  const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return undefined;
  }

  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1))
  };
}

function toTokenResponse(tokenSet: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}) {
  return {
    access_token: tokenSet.accessToken,
    token_type: "Bearer",
    expires_in: tokenSet.expiresIn,
    refresh_token: tokenSet.refreshToken,
    scope: "freshsales.read"
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
