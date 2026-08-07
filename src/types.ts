export interface ErrorPayload {
  error: {
    code: string;
    message: string;
  };
}

export interface ToolMeta {
  fetched_at: string;
}

export interface PendingApprovalResponse {
  status: "pending_approval";
  request_id: string;
  tool: string;
  params: Record<string, unknown>;
  will_call_freshsales: boolean;
  estimated_call_count: number;
  expires_at: string;
  _meta: ToolMeta;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type JsonRecord = Record<string, unknown>;
