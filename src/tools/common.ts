import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { FreshsalesClientLike } from "../freshsales/types.js";
import { ApprovalStore } from "../state/approvalStore.js";
import { DailyUsageTracker } from "../state/dailyUsageTracker.js";
import type { JsonRecord, Logger, PendingApprovalResponse } from "../types.js";
import { AppError, redactKnownSecrets } from "../utils/errors.js";

export const approvalFields = {
  approved: z.boolean().optional(),
  request_id: z.string().min(1).optional()
};

interface ApprovalAwareInput extends JsonRecord {
  approved?: boolean;
  request_id?: string;
}

export interface ToolExecutionContext {
  config: AppConfig;
  freshsales: FreshsalesClientLike;
  approvalStore: ApprovalStore;
  usageTracker: DailyUsageTracker;
  logger: Logger;
  now: () => Date;
}

export interface ToolDefinition<TInput extends ApprovalAwareInput, TResolved, TResult extends JsonRecord> {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  resolve: (input: TInput, ctx: ToolExecutionContext) => TResolved;
  estimateCallCount: (params: TResolved, ctx: ToolExecutionContext) => number;
  execute: (params: TResolved, ctx: ToolExecutionContext) => Promise<TResult>;
  willCallFreshsales: boolean;
}

export interface ToolCallResult<TResult extends JsonRecord> {
  payload: PendingApprovalResponse | TResult;
  isError: boolean;
}

export function defineTool<TInput extends ApprovalAwareInput, TResolved, TResult extends JsonRecord>(
  definition: ToolDefinition<TInput, TResolved, TResult>
): ToolDefinition<TInput, TResolved, TResult> {
  return definition;
}

export async function runTool<TInput extends ApprovalAwareInput, TResolved, TResult extends JsonRecord>(
  definition: ToolDefinition<TInput, TResolved, TResult>,
  rawInput: unknown,
  ctx: ToolExecutionContext
): Promise<ToolCallResult<TResult>> {
  try {
    const parsedInput = definition.inputSchema.parse((rawInput ?? {}) as TInput);
    const now = ctx.now();

    if (parsedInput.approved === true) {
      if (!parsedInput.request_id) {
        throw new AppError("MISSING_REQUEST_ID", "A request_id is required when approved is true.");
      }

      const approval = ctx.approvalStore.consume<TResolved>(parsedInput.request_id, definition.name, now);
      ctx.usageTracker.ensureCapacity(approval.estimatedCallCount, now);

      const result = await definition.execute(approval.params, ctx);
      ctx.logger.info("tool_call_executed", {
        tool: definition.name,
        status: "success"
      });

      return {
        payload: {
          ...result,
          _meta: {
            fetched_at: now.toISOString()
          }
        },
        isError: false
      };
    }

    const resolved = definition.resolve(parsedInput, ctx);
    const estimatedCallCount = definition.estimateCallCount(resolved, ctx);
    const { requestId, expiresAt } = ctx.approvalStore.create(
      definition.name,
      resolved,
      estimatedCallCount,
      ctx.config.approvalTtlSeconds,
      now
    );

    ctx.logger.info("tool_call_pending_approval", {
      tool: definition.name,
      status: "pending_approval"
    });

    return {
      payload: {
        status: "pending_approval",
        request_id: requestId,
        tool: definition.name,
        params: toPreviewObject(resolved),
        will_call_freshsales: definition.willCallFreshsales,
        estimated_call_count: estimatedCallCount,
        expires_at: expiresAt.toISOString(),
        _meta: {
          fetched_at: now.toISOString()
        }
      },
      isError: false
    };
  } catch (error) {
    ctx.logger.warn("tool_call_rejected", {
      tool: definition.name,
      status: "error"
    });

    return {
      payload: {
        error: {
          code: error instanceof AppError ? error.code : "INVALID_INPUT",
          message: error instanceof Error
            ? redactKnownSecrets(error.message, ctx.config)
            : "The request could not be processed."
        }
      } as unknown as TResult,
      isError: true
    };
  }
}

function toPreviewObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }

  return value as Record<string, unknown>;
}
