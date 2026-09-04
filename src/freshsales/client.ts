import type { AppConfig } from "../config.js";
import { DailyUsageTracker } from "../state/dailyUsageTracker.js";
import type { Logger } from "../types.js";
import { AppError, redactKnownSecrets } from "../utils/errors.js";
import type { FreshsalesClientLike, FreshsalesRequestOptions, FreshsalesRateLimitSnapshot } from "./types.js";

type FetchLike = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

export interface FreshsalesClientDependencies {
  config: AppConfig;
  usageTracker: DailyUsageTracker;
  logger: Logger;
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  now?: () => Date;
}

interface FreshsalesErrorBody {
  errors?: {
    code?: string | number;
    message?: unknown;
  };
  error?: {
    code?: string | number;
    message?: unknown;
  };
  message?: unknown;
}

interface UpstreamNonJsonDetails {
  upstreamContentType: string | null;
  upstreamBodySnippet: string;
  upstreamStatus: number;
}

export class FreshsalesClient implements FreshsalesClientLike {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepFn;
  private readonly now: () => Date;

  public constructor(private readonly deps: FreshsalesClientDependencies) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date());
  }

  public async get<T>(path: string, options?: FreshsalesRequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  public async post<T>(path: string, options?: FreshsalesRequestOptions): Promise<T> {
    return this.request<T>("POST", path, options);
  }

  private async request<T>(method: "GET" | "POST", path: string, options?: FreshsalesRequestOptions): Promise<T> {
    // Tool paths must not start with "/" because Freshsales domains can include
    // "/crm/sales"; absolute paths would make new URL() drop that base path.
    const url = new URL(path, `${this.deps.config.freshsalesDomain}/`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    while (true) {
      this.deps.usageTracker.recordCall(this.now(), {
        method,
        path: redactPathForUsage(url)
      });

      let response: Response;
      try {
        response = await this.fetchWithTimeout(method, url, options?.body);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "FRESHSALES_TIMEOUT" || attempt >= this.deps.config.max429Retries) {
          throw error;
        }

        const waitMs = computeBackoffMs(attempt, {}, this.deps.config.maxRetryWaitMs);
        this.deps.logger.warn("freshsales_timeout_retry", { attempt, wait_ms: waitMs });
        attempt += 1;
        await this.sleep(waitMs);
        continue;
      }

      const rateLimit = parseRateLimitHeaders(response.headers);

      if (response.status === 429) {
        const waitMs = computeBackoffMs(attempt, rateLimit, this.deps.config.maxRetryWaitMs);
        this.deps.logger.warn("freshsales_rate_limited", {
          attempt,
          wait_ms: waitMs,
          remaining: rateLimit.remaining,
          reset_at: rateLimit.resetAt
        });

        if (attempt >= this.deps.config.max429Retries || waitMs > this.deps.config.maxRetryWaitMs) {
          throw new AppError(
            "RATE_LIMITED",
            `Freshsales rate limit reached. Remaining: ${rateLimit.remaining ?? "unknown"}. Reset at ${rateLimit.resetAt ?? "unknown"}.`,
            429
          );
        }

        attempt += 1;
        await this.sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw await this.buildHttpError(response);
      }

      if (!isJsonResponse(response)) {
        const details = await this.readNonJsonDetails(response);
        this.logNonJsonResponse("freshsales_non_json_response", details);
        throw withUpstreamDetails(
          new AppError(
            "UPSTREAM_NON_JSON",
            "Freshsales returned a non-JSON response (likely an auth redirect or wrong FRESHSALES_DOMAIN) instead of API data.",
            response.status
          ),
          details
        );
      }

      return (await response.json()) as T;
    }
  }

  // Every outbound call gets an explicit deadline. Without this, a stuck
  // upstream TCP connection (or a hung load balancer on Freshsales' side)
  // leaves the fetch promise pending forever, which in turn leaves the
  // /mcp request that awaited it hanging indefinitely with no response
  // ever sent back to the client.
  private async fetchWithTimeout(method: "GET" | "POST", url: URL, body?: unknown): Promise<Response> {
    const timeoutMs = this.deps.config.freshsalesRequestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Token token=${this.deps.config.freshsalesApiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new AppError(
          "FRESHSALES_TIMEOUT",
          `Freshsales request timed out after ${timeoutMs}ms.`,
          504
        );
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async buildHttpError(response: Response): Promise<AppError> {
    let body: FreshsalesErrorBody | undefined;

    if (!isJsonResponse(response)) {
      const details = await this.readNonJsonDetails(response);
      this.logNonJsonResponse("freshsales_non_json_error_response", details);
      return withUpstreamDetails(
        new AppError(
          "FRESHSALES_REQUEST_FAILED",
          "Freshsales returned a non-JSON error response. Check the server-side credentials and FRESHSALES_DOMAIN.",
          response.status
        ),
        details
      );
    }

    body = (await response.json()) as FreshsalesErrorBody;

    const messageCandidate =
      normalizeErrorMessage(body?.errors?.message) ??
      normalizeErrorMessage(body?.error?.message) ??
      normalizeErrorMessage(body?.message);
    const rawMessage =
      typeof messageCandidate === "string"
        ? messageCandidate
        : response.statusText || "Freshsales request failed.";

    const safeMessage = redactKnownSecrets(rawMessage, this.deps.config);

    if (response.status === 401 || response.status === 403) {
      return new AppError("AUTH_FAILED", "Freshsales authentication failed. Check the server-side credentials.", response.status);
    }

    if (response.status === 404) {
      return new AppError("NOT_FOUND", "The requested Freshsales record was not found.", 404);
    }

    return new AppError("FRESHSALES_REQUEST_FAILED", safeMessage, response.status);
  }

  private async readNonJsonDetails(response: Response): Promise<UpstreamNonJsonDetails> {
    const rawBody = await response.text();

    return {
      upstreamContentType: response.headers.get("content-type"),
      upstreamBodySnippet: truncate(redactKnownSecrets(rawBody, this.deps.config), 500),
      upstreamStatus: response.status
    };
  }

  private logNonJsonResponse(event: string, details: UpstreamNonJsonDetails): void {
    this.deps.logger.warn(event, {
      upstream_status: details.upstreamStatus,
      upstream_content_type: details.upstreamContentType,
      upstream_body_snippet: details.upstreamBodySnippet
    });
  }
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") === true;
}

function withUpstreamDetails(error: AppError, details: UpstreamNonJsonDetails): AppError {
  const enriched = error as AppError & {
    upstreamContentType?: string | null;
    upstreamBodySnippet?: string;
    upstreamStatus?: number;
  };
  enriched.upstreamContentType = details.upstreamContentType;
  enriched.upstreamBodySnippet = details.upstreamBodySnippet;
  enriched.upstreamStatus = details.upstreamStatus;

  return error;
}

function normalizeErrorMessage(value: unknown): unknown {
  return Array.isArray(value) ? value.join("; ") : value;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function redactPathForUsage(url: URL): string {
  return url.search ? `${url.pathname}?${redactSearchParams(url.searchParams)}` : url.pathname;
}

function redactSearchParams(searchParams: URLSearchParams): string {
  const safe = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    safe.set(key, key.toLowerCase().includes("token") || key.toLowerCase().includes("key") ? "[REDACTED]" : value);
  }

  return safe.toString();
}

function parseRateLimitHeaders(headers: Headers): FreshsalesRateLimitSnapshot {
  const total = headers.get("x-ratelimit-total");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");

  return {
    total: total ? Number(total) : undefined,
    remaining: remaining ? Number(remaining) : undefined,
    resetAt: reset ? normalizeResetHeader(reset) : undefined
  };
}

function normalizeResetHeader(raw: string): string {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return raw;
  }

  if (numeric > 1_000_000_000) {
    return new Date(numeric * 1000).toISOString();
  }

  return new Date(Date.now() + numeric * 1000).toISOString();
}

function computeBackoffMs(attempt: number, rateLimit: FreshsalesRateLimitSnapshot, maxRetryWaitMs: number): number {
  const exponential = Math.min(250 * 2 ** attempt, maxRetryWaitMs);
  const resetBased = rateLimit.resetAt ? Math.max(0, new Date(rateLimit.resetAt).getTime() - Date.now()) : 0;
  const base = Math.max(exponential, Math.min(resetBased, maxRetryWaitMs));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.25)));
  return Math.min(base + jitter, maxRetryWaitMs);
}
