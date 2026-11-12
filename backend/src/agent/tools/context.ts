import type { Conversation } from "@prisma/client";
import type { Lang } from "../safety.js";
import type { HandoverReason } from "../../modules/tickets/service.js";

export interface ToolResult {
  ok: boolean;
  /** machine-readable outcome, e.g. RETURN_ELIGIBLE, NOT_VERIFIED, INTERNAL_ERROR */
  code?: string;
  /** customer-safe explanation the model can paraphrase */
  message?: string;
  data?: unknown;
}

export interface ToolTraceEntry {
  name: string;
  input: unknown;
  output: ToolResult;
  durationMs: number;
}

export interface HandoverRequest {
  reason: HandoverReason;
  mood: string;
  summary: string;
  suggestedReply: string;
  orderNumber?: string | null;
}

/** Per-turn state shared by the tool handlers. Identity comes ONLY from here, never from the model. */
export interface ToolContext {
  conversationId: string;
  turnId: string;
  conversation: Conversation;
  customerText: string;
  language: Lang;
  trace: ToolTraceEntry[];
  systemFailures: number;
  handover?: HandoverRequest;
}

/** Error codes that mean "the system failed" (vs. a policy decision or a validation problem). */
export const SYSTEM_FAILURE_CODES = new Set(["INTERNAL_ERROR", "TIMEOUT", "COURIER_UNAVAILABLE"]);
