import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { maskDeep } from "../../lib/mask.js";
import { TOOL_MAP } from "./registry.js";
import { SYSTEM_FAILURE_CODES, type ToolContext, type ToolResult } from "./context.js";

const TOOL_TIMEOUT_MS = 12_000;

const json = (v: unknown) => JSON.parse(JSON.stringify(maskDeep(v ?? null))) as Prisma.InputJsonValue;

/**
 * Validate (Zod) → run (with timeout) → record trace (masked) → return a structured result.
 * Unknown tools and invalid arguments never reach a handler.
 */
export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> {
  const started = Date.now();
  let output: ToolResult;
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    output = { ok: false, code: "UNKNOWN_TOOL", message: `Tool ${name} does not exist.` };
  } else {
    const parsed = tool.schema.safeParse(rawInput);
    if (!parsed.success) {
      output = { ok: false, code: "INVALID_ARGUMENTS", message: "Invalid tool arguments.", data: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    } else {
      try {
        output = await Promise.race([
          tool.handler(ctx, parsed.data),
          new Promise<ToolResult>((resolve) => setTimeout(() => resolve({ ok: false, code: "TIMEOUT", message: "The lookup timed out." }), TOOL_TIMEOUT_MS)),
        ]);
      } catch (err) {
        logger.error({ tool: name, err: String(err) }, "tool failed");
        output = { ok: false, code: "INTERNAL_ERROR", message: "Couldn't fetch the details right now (system error). Don't guess — apologise and offer a callback or a human." };
      }
    }
  }
  const durationMs = Date.now() - started;
  if (!output.ok && output.code && SYSTEM_FAILURE_CODES.has(output.code)) ctx.systemFailures++;
  ctx.trace.push({ name, input: rawInput, output, durationMs });
  await prisma.toolCall.create({
    data: { conversationId: ctx.conversationId, turnId: ctx.turnId, toolName: name, input: json(rawInput), output: json(output), ok: output.ok, errorCode: output.ok ? null : (output.code ?? null), durationMs },
  });
  return output;
}
