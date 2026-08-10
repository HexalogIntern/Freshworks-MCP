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
    message?: string;
  };
  error?: {
    code?: string | number;
    message?: string;
  };
  message?: string;
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
    return this.request<T>(path, options);
  }

  private async request<T>(path: string, options?: FreshsalesRequestOptions): Promise<T> {
    const url = new URL(path, `${this.deps.config.freshsalesDomain}/`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    while (true) {
      this.deps.usageTracker.recordCall(this.now());

      const response = await this.fetchWithTimeout(url);

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

      return (await response.json()) as T;
    }
  }

  // Every outbound call gets an explicit deadline. Without this, a stuck
  // upstream TCP connection (or a hung load balancer on Freshsales' side)
  // leaves the fetch promise pending forever, which in turn leaves the
  // /mcp request that awaited it hanging indefinitely with no response
  // ever sent back to the client.
  private async fetchWithTimeout(url: URL): Promise<Response> {
    const timeoutMs = this.deps.config.freshsalesRequestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Token token=${this.deps.config.freshsalesApiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
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

    try {
      body = (await response.json()) as FreshsalesErrorBody;
    } catch {
      body = undefined;
    }

    const rawMessage =
      body?.errors?.message ??
      body?.error?.message ??
      body?.message ??
      response.statusText ??
      "Freshsales request failed.";

    const safeMessage = redactKnownSecrets(rawMessage, this.deps.config);

    if (response.status === 401 || response.status === 403) {
      return new AppError("AUTH_FAILED", "Freshsales authentication failed. Check the server-side credentials.", response.status);
    }

    if (response.status === 404) {
      return new AppError("NOT_FOUND", "The requested Freshsales record was not found.", 404);
    }

    return new AppError("FRESHSALES_REQUEST_FAILED", safeMessage, response.status);
  }
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
  return Math.max(exponential, Math.min(resetBased, maxRetryWaitMs));
}
