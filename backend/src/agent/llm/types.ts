import type { ToolContext } from "../tools/context.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  llmCalls: number;
}

export interface EngineResult {
  text: string;
  engine: "claude" | "mock";
  usage: Usage;
  costUsd: number;
  /** set when the engine could not produce a grounded answer (LLM down, refusal, loop limit) */
  failure?: "LLM_ERROR" | "REFUSAL" | "MAX_ITERATIONS" | "MAX_TOKENS";
}

export interface Engine {
  readonly name: "claude" | "mock";
  run(ctx: ToolContext, history: HistoryMessage[], contextBlock: string, maxIterations: number): Promise<EngineResult>;
  summarizeForHandover?(history: HistoryMessage[], reason: string, language: string): Promise<{ summary: string; suggestedReply: string; mood: string } | null>;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCalls: 0 });

/** USD per million tokens (first-party list prices; ≤100K-token prompts for Haiku 5.5). */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export function estimateCostUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES["claude-haiku-5-5"]!;
  const cost = (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.input * 0.1 + u.outputTokens * p.output) / 1_000_000;
  return Math.round(cost * 1e7) / 1e7;
}
