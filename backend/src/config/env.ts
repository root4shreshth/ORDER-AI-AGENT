import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6385"),
  QUEUE_NAME: z.string().default("wishluck-jobs"),
  PORT: z.coerce.number().int().default(4000),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  /** Customer-facing web app (chat widget, dummy payment page). */
  WEB_URL: z.string().default("http://localhost:5173"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.string().default("info"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(20_000),
  LLM_MAX_RETRIES: z.coerce.number().int().default(2),
  ORDER_WEBHOOK_SECRET: z.string().min(8),
  COURIER_WEBHOOK_SECRET: z.string().min(8),
  ADMIN_API_KEY: z.string().optional().default(""),
  /** Force the mock LLM even when a key is present (used by deterministic tests). */
  LLM_MODE: z.enum(["auto", "mock", "claude"]).default("auto"),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;

export function llmEngine(): "claude" | "mock" {
  if (env.LLM_MODE === "mock") return "mock";
  if (env.LLM_MODE === "claude") return "claude";
  return env.ANTHROPIC_API_KEY.trim() ? "claude" : "mock";
}
