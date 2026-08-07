export interface FreshsalesRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
}

export interface FreshsalesRateLimitSnapshot {
  total?: number;
  remaining?: number;
  resetAt?: string;
}

export interface FreshsalesClientLike {
  get<T>(path: string, options?: FreshsalesRequestOptions): Promise<T>;
}
