import { config as loadEnv } from "dotenv";
import { z } from "zod";

// `quiet: true` suppresses dotenv's promotional startup banner (it prints a
// random "tip" line, including dotenvx ads, on every injection by default).
// Render injects real env vars directly in production, so this call mostly
// no-ops there anyway, but we still keep it quiet everywhere for clean logs.
loadEnv({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FRESHSALES_API_KEY: z.string().min(1),
  FRESHSALES_DOMAIN: z.string().min(1),
  FRESHSALES_DEFAULT_LEADS_VIEW_ID: z.string().min(1),
  FRESHSALES_DEFAULT_DEALS_VIEW_ID: z.string().min(1),
  MCP_SERVER_TOKEN: z.string().min(1).optional(),
  OAUTH_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  DAILY_CALL_LIMIT: z.coerce.number().int().min(1).default(200),
  APPROVAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  RESET_TIMEZONE: z.string().min(1).default("UTC"),
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  MCP_ALLOWED_HOSTS: z.string().default(""),
  FRESHSALES_MAX_429_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  FRESHSALES_MAX_RETRY_WAIT_MS: z.coerce.number().int().min(100).max(5000).default(2000),
  LOCAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  PIPELINE_SUMMARY_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(5),
  FRESHSALES_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000)
});

function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  freshsalesApiKey: string;
  freshsalesDomain: string;
  defaultLeadsViewId: string;
  defaultDealsViewId: string;
  mcpServerToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  dailyCallLimit: number;
  approvalTtlSeconds: number;
  resetTimeZone: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  max429Retries: number;
  maxRetryWaitMs: number;
  localRateLimitPerMinute: number;
  pipelineSummaryMaxPages: number;
  freshsalesRequestTimeoutMs: number;
  mcpRequestTimeoutMs: number;
}

export function getConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  const env = parsed.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    freshsalesApiKey: env.FRESHSALES_API_KEY,
    freshsalesDomain: normalizeDomain(env.FRESHSALES_DOMAIN),
    defaultLeadsViewId: env.FRESHSALES_DEFAULT_LEADS_VIEW_ID,
    defaultDealsViewId: env.FRESHSALES_DEFAULT_DEALS_VIEW_ID,
    mcpServerToken: env.MCP_SERVER_TOKEN,
    oauthClientId: env.OAUTH_CLIENT_ID,
    oauthClientSecret: env.OAUTH_CLIENT_SECRET,
    dailyCallLimit: env.DAILY_CALL_LIMIT,
    approvalTtlSeconds: env.APPROVAL_TTL_SECONDS,
    resetTimeZone: env.RESET_TIMEZONE,
    allowedOrigins: splitCsv(env.MCP_ALLOWED_ORIGINS),
    allowedHosts: splitCsv(env.MCP_ALLOWED_HOSTS),
    max429Retries: env.FRESHSALES_MAX_429_RETRIES,
    maxRetryWaitMs: env.FRESHSALES_MAX_RETRY_WAIT_MS,
    localRateLimitPerMinute: env.LOCAL_RATE_LIMIT_PER_MINUTE,
    pipelineSummaryMaxPages: env.PIPELINE_SUMMARY_MAX_PAGES,
    freshsalesRequestTimeoutMs: env.FRESHSALES_REQUEST_TIMEOUT_MS,
    mcpRequestTimeoutMs: env.MCP_REQUEST_TIMEOUT_MS
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
}
