import { randomBytes } from "node:crypto";

import { AppError } from "../utils/errors.js";

export interface PendingRequest<TParams> {
  toolName: string;
  params: TParams;
  estimatedCallCount: number;
  expiresAt: Date;
}

export class ApprovalStore {
  private readonly pending = new Map<string, PendingRequest<unknown>>();

  public create<TParams>(
    toolName: string,
    params: TParams,
    estimatedCallCount: number,
    ttlSeconds: number,
    now: Date
  ): { requestId: string; expiresAt: Date } {
    this.prune(now);

    const requestId = randomBytes(9).toString("base64url");
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    this.pending.set(requestId, {
      toolName,
      params,
      estimatedCallCount,
      expiresAt
    });

    return { requestId, expiresAt };
  }

  public consume<TParams>(requestId: string, toolName: string, now: Date): PendingRequest<TParams> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.toolName !== toolName) {
      this.prune(now);
      throw new AppError("UNKNOWN_REQUEST_ID", "The approval request was not found or does not match this tool.");
    }

    this.pending.delete(requestId);

    if (entry.expiresAt.getTime() <= now.getTime()) {
      throw new AppError("REQUEST_ID_EXPIRED", "The approval request expired. Propose the tool call again.");
    }

    return entry as PendingRequest<TParams>;
  }

  private prune(now: Date): void {
    for (const [requestId, entry] of this.pending.entries()) {
      if (entry.expiresAt.getTime() <= now.getTime()) {
        this.pending.delete(requestId);
      }
    }
  }
}
