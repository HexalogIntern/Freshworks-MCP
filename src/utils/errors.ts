import type { AppConfig } from "../config.js";
import type { ErrorPayload } from "../types.js";

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function errorPayload(code: string, message: string): ErrorPayload {
  return {
    error: {
      code,
      message
    }
  };
}

export function redactKnownSecrets(value: string, config: Pick<AppConfig, "freshsalesApiKey" | "mcpServerToken">): string {
  return [config.freshsalesApiKey, config.mcpServerToken]
    .filter((candidate): candidate is string => Boolean(candidate))
    .reduce((message, secret) => message.split(secret).join("[REDACTED]"), value);
}
