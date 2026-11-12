/**
 * One customer turn:
 *  lock conversation → save message → (muted if a human owns it) → deterministic escalation guard
 *  → engine (Claude tool loop, or MOCK) → post-guards (handover / failures / verification lock)
 *  → ownership re-check → persist + emit the reply.
 */
import { randomUUID } from "node:crypto";
import type { Conversation, Message, Prisma, SupportTicket } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { waitForLock } from "../lib/redis.js";
import { env, llmEngine } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isoDateIST } from "../lib/format.js";
import { getSettings } from "../modules/settings/settings.js";
import { addMessage, emitMessage } from "../modules/conversations/service.js";
import { createHandover, type HandoverReason } from "../modules/tickets/service.js";
import { audit } from "../modules/audit/audit.js";
import { publish } from "../lib/events.js";
import { detectEscalation, detectInjection, detectLanguage, detectOtherCustomerProbe, type Lang } from "./safety.js";
import { renderContext } from "./prompts.js";
import { channelVerifiedPhone } from "./tools/identity.js";
import { maskPhone } from "../lib/mask.js";
import { describeQuote, type ApprovedQuote } from "../modules/team/service.js";
import type { ToolContext } from "./tools/context.js";
import type { Engine, EngineResult, HistoryMessage } from "./llm/types.js";
import { ClaudeEngine } from "./llm/claude.js";
import { MockEngine } from "./llm/mock.js";

let engines: { claude?: ClaudeEngine; mock?: MockEngine } = {};
export function getEngine(): Engine {
  return llmEngine() === "claude" ? (engines.claude ??= new ClaudeEngine()) : (engines.mock ??= new MockEngine());
}
export function resetEngines(): void {
  engines = {};
}

export interface TurnResult {
  conversationId: string;
  status: Conversation["status"];
  customerMessage: Message;
  reply: Message | null;
  ticket: SupportTicket | null;
  toolCalls: { name: string; ok: boolean; code?: string }[];
  engine: "claude" | "mock" | "guard" | "none";
  suppressed?: boolean;
}

const FALLBACK: Record<Lang, string> = {
  en: "Sorry, I couldn't fetch the details right now. I can arrange a callback from our support team, or you can try again in a few minutes.",
  hinglish: "Sorry, abhi details fetch nahi ho payi. Main hamari support team se callback arrange kar sakta hoon, ya aap thodi der baad try kar sakte hain.",
  hi: "क्षमा करें, अभी जानकारी नहीं मिल पाई। मैं हमारी सपोर्ट टीम से कॉलबैक करवा सकता हूँ, या आप कुछ मिनट बाद फिर कोशिश करें।",
};

const INTENT_BY_TOOL: Record<string, string> = {
  propose_new_order: "new_order",
  ask_team: "team_request",
  search_knowledge_base: "general_question",
  list_my_orders: "order_status",
  get_shipment_status: "order_status",
  get_order_details: "order_status",
  check_cancellation_eligibility: "cancel_order",
  check_return_eligibility: "return",
  check_exchange_eligibility: "exchange",
  get_refund_status: "refund_status",
  get_product_info: "product_help",
  check_stock: "product_help",
  get_policy_info: "policy_question",
  check_pincode: "policy_question",
  respond_cod_confirmation: "cod_confirmation",
};

function deriveIntent(ctx: ToolContext, flags: string[]): string {
  if (ctx.handover) return `handover:${ctx.handover.reason.toLowerCase()}`;
  const propose = ctx.trace.find((t) => t.name === "propose_action");
  if (propose) return String((propose.input as { action?: string }).action ?? "action");
  if (ctx.trace.some((t) => t.name === "confirm_action")) return "confirm_action";
  for (const t of ctx.trace) if (INTENT_BY_TOOL[t.name]) return INTENT_BY_TOOL[t.name]!;
  if (flags.includes("prompt_injection")) return "prompt_injection";
  if (flags.includes("other_customer_probe")) return "data_leak_probe";
  if (ctx.trace.some((t) => t.name === "verify_customer")) return "verification";
  return "general";
}

async function loadHistory(conversationId: string, beforeId: string): Promise<HistoryMessage[]> {
  const rows = await prisma.message.findMany({ where: { conversationId, id: { not: beforeId } }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows
    .reverse()
    .filter((m) => m.role !== "SYSTEM" && m.content.trim())
    .map((m) => ({
      role: m.role === "CUSTOMER" ? ("user" as const) : ("assistant" as const),
      text: m.role === "HUMAN" ? `[Wishluck support agent]: ${m.content}` : m.content,
    }));
}

async function describeFlow(conv: Conversation): Promise<string | null> {
  const c = (conv.context ?? {}) as { orderNumber?: string; flow?: string };
  if (!c.orderNumber || !c.flow) return null;
  if (c.flow === "COD") {
    const cod = await prisma.codConfirmation.findFirst({ where: { order: { orderNumber: c.orderNumber } } });
    if (cod && ["AWAITING", "ADDRESS_EDIT_REQUESTED", "ON_HOLD"].includes(cod.status)) return `COD confirmation pending for ${c.orderNumber} (status ${cod.status})`;
  }
  if (c.flow === "NDR") {
    const sh = await prisma.shipment.findFirst({ where: { order: { orderNumber: c.orderNumber } } });
    if (sh?.ndrOpen) return `failed delivery follow-up for ${c.orderNumber} (attempt ${sh.attemptCount}, courier reason "${sh.lastFailureReason ?? "n/a"}")`;
  }
  return null;
}

function templateHandoverNote(reason: HandoverReason, text: string, lang: Lang) {
  const why: Record<string, string> = {
    LEGAL_THREAT: "mentioned legal action / consumer court",
    PUBLIC_COMPLAINT_THREAT: "threatened to post a complaint publicly",
    CUSTOMER_REQUESTED_HUMAN: "asked to speak to a person",
    ANGRY_CUSTOMER: "is clearly upset",
    BULK_ORDER: "asked about a bulk/wholesale order",
  };
  return {
    summary: `Customer ${why[reason] ?? "needs a human"}. Last message: "${text.slice(0, 220)}". Please review the conversation and order context before replying.`,
    suggestedReply:
      lang === "en"
        ? "Hi, I'm from the Wishluck support team. I'm really sorry for the trouble — I've gone through your chat and I'm looking into this personally right now."
        : lang === "hi"
          ? "नमस्ते, मैं Wishluck सपोर्ट टीम से हूँ। असुविधा के लिए खेद है — मैंने आपकी चैट देख ली है और खुद इसे देख रहा/रही हूँ।"
          : "Hi, main Wishluck support team se hoon. Pareshani ke liye sorry — maine aapki chat dekh li hai aur abhi khud isko dekh raha/rahi hoon.",
  };
}

export interface TurnOptions {
  /** how the customer produced the text (voice = browser speech-to-text) */
  inputMode?: "text" | "voice";
}

export async function handleCustomerMessage(conversationId: string, rawText: string, opts: TurnOptions = {}): Promise<TurnResult> {
  const text = rawText.trim().slice(0, 2000);
  const release = await waitForLock(`conv:${conversationId}`);
  const started = Date.now();
  try {
    let conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (conv.status === "RESOLVED") {
      conv = await prisma.conversation.update({ where: { id: conv.id }, data: { status: "AI_HANDLING", version: { increment: 1 }, failedTurnCount: 0 } });
    }
    const language = detectLanguage(text);
    const flags: string[] = [];
    if (detectInjection(text)) flags.push("prompt_injection");
    if (detectOtherCustomerProbe(text)) flags.push("other_customer_probe");

    const customerMessage = await addMessage(prisma, { conversationId, role: "CUSTOMER", content: text, language, meta: flags.length || opts.inputMode === "voice" ? { ...(flags.length ? { flags } : {}), ...(opts.inputMode === "voice" ? { inputMode: "voice" } : {}) } : undefined });
    await prisma.conversation.update({ where: { id: conv.id }, data: { language } });
    await emitMessage(customerMessage);
    if (flags.length) await audit(prisma, { actor: "system", entityType: "conversation", entityId: conv.id, action: "GUARD_FLAG", meta: { flags, text } });

    // AI is muted while the conversation needs / has a human.
    if (conv.status !== "AI_HANDLING") {
      return { conversationId, status: conv.status, customerMessage, reply: null, ticket: null, toolCalls: [], engine: "none" };
    }

    const settings = await getSettings();
    const engine = getEngine();

    // Deterministic escalation guard (legal threat, public complaint, human request, anger, bulk).
    const trigger = detectEscalation(text, settings.handover);
    if (trigger) {
      const history = await loadHistory(conversationId, "");
      const note = (await engine.summarizeForHandover?.(history, trigger.reason, language)) ?? { ...templateHandoverNote(trigger.reason, text, language), mood: trigger.mood };
      const ctxOrder = ((conv.context ?? {}) as { orderNumber?: string }).orderNumber ?? conv.verifiedOrderNumbers[0] ?? null;
      const { ticket, customerMessage: reply } = await createHandover(conversationId, {
        reason: trigger.reason,
        mood: trigger.mood === "angry" ? "angry" : note.mood,
        summary: note.summary,
        suggestedReply: note.suggestedReply,
        orderNumber: ctxOrder,
        actor: "system",
        language,
      });
      await prisma.message.update({ where: { id: customerMessage.id }, data: { intent: `handover:${trigger.reason.toLowerCase()}` } });
      await setFirstResponse(conv, customerMessage.createdAt);
      return { conversationId, status: "NEEDS_HUMAN", customerMessage, reply, ticket, toolCalls: [], engine: "guard" };
    }

    // Engine turn.
    const turnId = randomUUID();
    const ctx: ToolContext = { conversationId, turnId, conversation: conv, customerText: text, language, trace: [], systemFailures: 0 };
    const pending = await prisma.pendingAction.findFirst({ where: { conversationId, status: "PENDING", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
    const now = new Date();
    const contextBlock = renderContext({
      today: isoDateIST(now),
      weekday: now.toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" }),
      language: language === "hi" ? "Hindi (Devanagari)" : language === "hinglish" ? "Hinglish (Roman script)" : "English",
      verifiedOrders: conv.verifiedOrderNumbers,
      activeFlow: await describeFlow(conv),
      pendingAction: pending ? { id: pending.id, summary: pending.summary } : null,
      channelVerifiedPhone: await channelVerifiedPhone(conv).then((p) => (p ? maskPhone(p) : null)),
      earlierTools: (await prisma.toolCall.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: 10 }))
        .reverse()
        .map((t) => {
          const order = (t.input as { order_number?: string } | null)?.order_number;
          return `${t.toolName}${order ? `(${order})` : ""}→${(t.output as { code?: string } | null)?.code ?? (t.ok ? "ok" : "error")}`;
        }),
      teamRequests: await teamRequestLines(conversationId),
      flags,
    });
    const history = await loadHistory(conversationId, customerMessage.id);

    let result: EngineResult;
    try {
      result = await engine.run(ctx, history, contextBlock, settings.agent.maxToolIterations);
    } catch (err) {
      logger.error({ err: String(err) }, "engine crashed");
      result = { text: "", engine: engine.name, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCalls: 0 }, costUsd: 0, failure: "LLM_ERROR" };
    }

    const intent = deriveIntent(ctx, flags);
    await prisma.message.update({ where: { id: customerMessage.id }, data: { intent } });
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastIntent: intent } });

    // Verification locked → hand over (never keep guessing).
    if (!ctx.handover && ctx.trace.some((t) => t.output.code === "VERIFICATION_LOCKED")) {
      ctx.handover = {
        reason: "VERIFICATION_FAILED",
        mood: "frustrated",
        summary: "Customer failed order/phone verification repeatedly. No order details were shared. Please verify identity manually.",
        suggestedReply: "Hi, I'm from the Wishluck team. I can help you with your order — could you confirm the order number and the phone number used at checkout?",
      };
    }

    // Failures: LLM down, refusal, loop limit, or ≥2 system tool failures in this turn.
    const failed = !ctx.handover && (!!result.failure || ctx.systemFailures >= 2 || !result.text.trim());
    let failedTurnCount = conv.failedTurnCount;
    if (failed) failedTurnCount++;
    else if (!ctx.handover) failedTurnCount = 0;
    await prisma.conversation.update({ where: { id: conversationId }, data: { failedTurnCount } });
    if (failed && failedTurnCount >= settings.handover.maxFailedTurns) {
      ctx.handover = {
        reason: ctx.systemFailures > 0 ? "TOOL_FAILURE" : "REPEATED_FAILURE",
        mood: "frustrated",
        summary: `The assistant could not resolve the customer's request ${failedTurnCount} times in a row (${result.failure ?? (ctx.systemFailures ? "tool failures" : "no answer")}). Last message: "${text.slice(0, 200)}".`,
        suggestedReply: FALLBACK[language].replace(/^Sorry, /, "Hi, I'm from the Wishluck team — sorry for the wait. "),
        orderNumber: conv.verifiedOrderNumbers[0] ?? null,
      };
    }

    const toolCalls = ctx.trace.map((t) => ({ name: t.name, ok: t.output.ok, code: t.output.code }));

    if (ctx.handover) {
      const { ticket, customerMessage: reply } = await createHandover(conversationId, {
        ...ctx.handover,
        toolsCalled: toolCalls,
        actor: "ai",
        language,
      });
      if (reply) await linkUsage(reply.id, turnId, result, started);
      await setFirstResponse(conv, customerMessage.createdAt);
      return { conversationId, status: "NEEDS_HUMAN", customerMessage, reply, ticket, toolCalls, engine: result.engine };
    }

    const replyText = failed ? FALLBACK[language] : result.text;

    // Ownership re-check right before sending: if a human took over meanwhile, drop the AI reply.
    const reply = await prisma.$transaction(async (tx) => {
      const fresh = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      if (fresh.status !== "AI_HANDLING") return null;
      return addMessage(tx, {
        conversationId,
        role: "AI",
        content: replyText,
        engine: result.engine,
        language,
        intent,
        meta: (failed ? { fallback: true, failure: result.failure ?? "tool_failures" } : { toolCalls: toolCalls.length }) as Prisma.InputJsonValue,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        costUsd: result.costUsd,
        latencyMs: Date.now() - started,
      });
    });

    if (!reply) {
      await audit(prisma, { actor: "system", entityType: "conversation", entityId: conversationId, action: "AI_REPLY_SUPPRESSED", meta: { reason: "human took over during generation" } });
      const latest = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      return { conversationId, status: latest.status, customerMessage, reply: null, ticket: null, toolCalls, engine: result.engine, suppressed: true };
    }
    await prisma.toolCall.updateMany({ where: { turnId }, data: { messageId: reply.id } });
    await setFirstResponse(conv, customerMessage.createdAt);
    await emitMessage(reply);
    return { conversationId, status: "AI_HANDLING", customerMessage, reply, ticket: null, toolCalls, engine: result.engine };
  } finally {
    await release();
    await publish({ type: "conversation:updated", conversationId });
  }
}

async function linkUsage(messageId: string, turnId: string, result: EngineResult, started: number) {
  await prisma.message.update({
    where: { id: messageId },
    data: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, costUsd: result.costUsd, latencyMs: Date.now() - started, engine: result.engine },
  });
  await prisma.toolCall.updateMany({ where: { turnId }, data: { messageId } });
}

async function setFirstResponse(conv: Conversation, customerAt: Date) {
  if (conv.firstResponseMs !== null) return;
  const firstCustomer = await prisma.message.findFirst({ where: { conversationId: conv.id, role: "CUSTOMER" }, orderBy: { createdAt: "asc" } });
  const from = firstCustomer?.createdAt ?? customerAt;
  await prisma.conversation.updateMany({ where: { id: conv.id, firstResponseMs: null }, data: { firstResponseMs: Date.now() - from.getTime() } });
}

/** Open / answered team requests for the per-turn context (incl. approved quote ids). */
async function teamRequestLines(conversationId: string): Promise<string[]> {
  const reqs = await prisma.teamRequest.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: 3 });
  return reqs.map((r) => {
    if (r.status === "PENDING") return `request ${r.id} PENDING — waiting for the team ("${r.question.slice(0, 160)}")`;
    const quote = r.quote && !r.quoteUsedAt ? ` · approved quote_id=${r.id}: ${describeQuote(r.quote as unknown as ApprovedQuote)}` : r.quoteUsedAt ? " · quote already used for an order" : "";
    return `request ${r.id} ${r.status} — team said: "${(r.reply ?? "").slice(0, 300)}"${quote}`;
  });
}

/**
 * The team answered a request (Team page). The assistant relays it to the customer in their
 * language — same agent, same tools (it may go on to propose a quoted order). Exactly once.
 */
export async function handleTeamUpdate(teamRequestId: string): Promise<"relayed" | "skipped" | "human_owns_chat"> {
  const tr = await prisma.teamRequest.findUnique({ where: { id: teamRequestId } });
  if (!tr || tr.status === "PENDING" || !tr.reply) return "skipped";
  const done = await prisma.auditLog.findFirst({ where: { entityType: "conversation", entityId: tr.conversationId, action: "TEAM_REPLY_RELAYED", meta: { path: ["teamRequestId"], equals: tr.id } } });
  if (done) return "skipped";
  const release = await waitForLock(`conv:${tr.conversationId}`);
  const started = Date.now();
  try {
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: tr.conversationId } });
    const quote = tr.quote ? (tr.quote as unknown as ApprovedQuote) : null;
    // Internal note for staff (never sent to the customer).
    const note = await addMessage(prisma, {
      conversationId: conv.id,
      role: "SYSTEM",
      content: `Team (${tr.answeredBy ?? "team"}) → assistant: ${tr.reply}${quote ? ` · Approved quote: ${describeQuote(quote)}` : ""}`,
      engine: "system",
      meta: { internal: true, teamRequestId: tr.id },
    });
    await emitMessage(note);
    await audit(prisma, { actor: "system", entityType: "conversation", entityId: conv.id, action: "TEAM_REPLY_RELAYED", meta: { teamRequestId: tr.id, delivered: conv.status === "AI_HANDLING" } });
    if (conv.status !== "AI_HANDLING") return "human_owns_chat";

    const language = (conv.language as Lang | null) ?? "en";
    const settings = await getSettings();
    const engine = getEngine();
    const turnId = randomUUID();
    const ctx: ToolContext = { conversationId: conv.id, turnId, conversation: conv, customerText: "", language, trace: [], systemFailures: 0 };
    const now = new Date();
    const update =
      `<team_update>The team answered your earlier request (${tr.id}): "${tr.reply}".` +
      (quote ? ` Approved quote (quote_id=${tr.id}): ${describeQuote(quote)}.` : "") +
      ` Relay this to the customer now in their language; if a quote was approved, offer to book it.</team_update>`;
    const contextBlock =
      renderContext({
        today: isoDateIST(now),
        weekday: now.toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" }),
        language: language === "hi" ? "Hindi (Devanagari)" : language === "hinglish" ? "Hinglish (Roman script)" : "English",
        verifiedOrders: conv.verifiedOrderNumbers,
        channelVerifiedPhone: await channelVerifiedPhone(conv).then((p) => (p ? maskPhone(p) : null)),
        teamRequests: await teamRequestLines(conv.id),
      }) + `\n\n${update}`;
    const history = await loadHistory(conv.id, "");

    let text: string;
    let result: EngineResult | null = null;
    if (engine.name === "claude") {
      result = await engine.run(ctx, history, contextBlock, settings.agent.maxToolIterations);
      text = result.failure || !result.text.trim() ? "" : result.text;
    } else text = "";
    // Deterministic fallback (MOCK mode or LLM failure): relay the team's words verbatim.
    if (!text) text = `Update from our team: ${tr.reply}${quote ? `\nApproved quote: ${describeQuote(quote)}. Shall I book it for you?` : ""}`;

    const reply = await prisma.$transaction(async (tx) => {
      const fresh = await tx.conversation.findUniqueOrThrow({ where: { id: conv.id } });
      if (fresh.status !== "AI_HANDLING") return null;
      return addMessage(tx, {
        conversationId: conv.id,
        role: "AI",
        content: text,
        engine: result && !result.failure ? "claude" : "template",
        language,
        intent: "team_update",
        meta: { teamRequestId: tr.id },
        inputTokens: result?.usage.inputTokens,
        outputTokens: result?.usage.outputTokens,
        cacheReadTokens: result?.usage.cacheReadTokens,
        costUsd: result?.costUsd,
        latencyMs: Date.now() - started,
      });
    });
    if (!reply) return "human_owns_chat";
    await prisma.toolCall.updateMany({ where: { turnId }, data: { messageId: reply.id } });
    await emitMessage(reply);
    return "relayed";
  } finally {
    await release();
  }
}

export const currentModel = (): string => (llmEngine() === "claude" ? env.ANTHROPIC_MODEL : "mock");
