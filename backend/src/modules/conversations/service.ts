import { randomBytes } from "node:crypto";
import type { ConversationStatus, MessageRole, Prisma } from "@prisma/client";
import { prisma, type Db } from "../../lib/prisma.js";
import { publish } from "../../lib/events.js";
import { audit, type Actor } from "../audit/audit.js";
import { conflict, notFound } from "../../lib/errors.js";

export const newToken = (): string => randomBytes(18).toString("base64url");

export async function startConversation(channel = "web") {
  const c = await prisma.conversation.create({ data: { token: newToken(), channel } });
  await publish({ type: "conversation:updated", conversationId: c.id, status: c.status });
  return c;
}

/**
 * Proactive conversation for an order (COD confirmation / NDR follow-up). The message is
 * delivered to the phone on the order, so the conversation is pre-verified for THAT order only.
 */
export async function getOrCreateOrderConversation(orderId: string, flow: "COD" | "NDR" | "ORDER") {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });

  // Customer linked their phone to the Telegram bot → deliver there (Telegram verified that number).
  const tgChat = order.customer.telegramChatId;
  if (tgChat) {
    const tg = await prisma.conversation.findFirst({ where: { channel: "telegram", externalChatId: tgChat, status: { not: "RESOLVED" } }, orderBy: { createdAt: "desc" } });
    if (tg) {
      return prisma.conversation.update({
        where: { id: tg.id },
        data: {
          customerId: order.customerId,
          verifiedOrderNumbers: Array.from(new Set([...tg.verifiedOrderNumbers, order.orderNumber])),
          verifiedAt: tg.verifiedAt ?? new Date(),
          context: { orderNumber: order.orderNumber, flow },
        },
      });
    }
    const c = await prisma.conversation.create({
      data: { token: newToken(), channel: "telegram", externalChatId: tgChat, customerId: order.customerId, verifiedOrderNumbers: [order.orderNumber], verifiedAt: new Date(), context: { orderNumber: order.orderNumber, flow } },
    });
    await publish({ type: "conversation:updated", conversationId: c.id, status: c.status });
    return c;
  }

  const existing = await prisma.conversation.findFirst({
    where: { customerId: order.customerId, status: { not: "RESOLVED" }, verifiedOrderNumbers: { has: order.orderNumber } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    await prisma.conversation.update({ where: { id: existing.id }, data: { context: { orderNumber: order.orderNumber, flow } } });
    return existing;
  }
  const c = await prisma.conversation.create({
    data: {
      token: newToken(),
      channel: "web",
      customerId: order.customerId,
      verifiedOrderNumbers: [order.orderNumber],
      verifiedAt: new Date(),
      context: { orderNumber: order.orderNumber, flow },
    },
  });
  await publish({ type: "conversation:updated", conversationId: c.id, status: c.status });
  return c;
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  engine?: string;
  language?: string | null;
  intent?: string | null;
  meta?: Prisma.InputJsonValue;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

export async function addMessage(db: Db, m: NewMessage) {
  const msg = await db.message.create({ data: { ...m, language: m.language ?? undefined, intent: m.intent ?? undefined } });
  await db.conversation.update({ where: { id: m.conversationId }, data: { lastMessageAt: msg.createdAt } });
  return msg;
}

export async function emitMessage(msg: { conversationId: string }): Promise<void> {
  await publish({ type: "message:new", conversationId: msg.conversationId, message: msg });
  await publish({ type: "conversation:updated", conversationId: msg.conversationId });
}

/** Outbound automated message (COD / NDR templates). Skipped if a human owns the chat. */
export async function sendAutomatedMessage(conversationId: string, content: string, meta?: Prisma.InputJsonValue) {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const msg = await addMessage(prisma, { conversationId, role: "AI", content, engine: "template", meta });
  await emitMessage(msg);
  return { msg, conv };
}

// ---------------------------------------------------------------- ownership state machine
const TRANSITIONS: Record<string, { from: ConversationStatus[]; to: ConversationStatus }> = {
  takeover: { from: ["AI_HANDLING", "NEEDS_HUMAN"], to: "HUMAN_HANDLING" },
  release: { from: ["HUMAN_HANDLING", "NEEDS_HUMAN"], to: "AI_HANDLING" },
  resolve: { from: ["AI_HANDLING", "NEEDS_HUMAN", "HUMAN_HANDLING"], to: "RESOLVED" },
  reopen: { from: ["RESOLVED"], to: "AI_HANDLING" },
};

export async function transitionOwnership(conversationId: string, action: keyof typeof TRANSITIONS, agentName: string) {
  const t = TRANSITIONS[action]!;
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) throw notFound("Conversation");
  if (!t.from.includes(conv.status)) throw conflict(`Cannot ${action} a conversation in status ${conv.status}`);
  const res = await prisma.conversation.updateMany({
    where: { id: conversationId, version: conv.version },
    data: {
      status: t.to,
      version: { increment: 1 },
      assignedTo: t.to === "HUMAN_HANDLING" ? agentName : t.to === "AI_HANDLING" ? null : conv.assignedTo,
      failedTurnCount: t.to === "AI_HANDLING" ? 0 : conv.failedTurnCount,
    },
  });
  if (res.count !== 1) throw conflict("Conversation changed concurrently, please retry.");
  const actor: Actor = `human:${agentName}`;
  await audit(prisma, { actor, entityType: "conversation", entityId: conversationId, action: action.toUpperCase(), oldValue: { status: conv.status }, newValue: { status: t.to } });
  if (t.to === "RESOLVED") await prisma.supportTicket.updateMany({ where: { conversationId, status: { not: "CLOSED" } }, data: { status: "CLOSED", closedAt: new Date() } });
  if (t.to === "HUMAN_HANDLING") await prisma.supportTicket.updateMany({ where: { conversationId, status: "OPEN" }, data: { status: "IN_PROGRESS" } });
  const note =
    t.to === "HUMAN_HANDLING" ? `${agentName} from the Wishluck team has joined the chat.` : t.to === "AI_HANDLING" ? "You're chatting with the Wishluck assistant again." : null;
  if (note) {
    const msg = await addMessage(prisma, { conversationId, role: "SYSTEM", content: note, engine: "system" });
    await emitMessage(msg);
  }
  await publish({ type: "conversation:updated", conversationId, status: t.to });
  return { status: t.to };
}

/** Human agent reply — only allowed while a human owns the conversation. */
export async function humanReply(conversationId: string, agentName: string, content: string) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) throw notFound("Conversation");
  if (conv.status !== "HUMAN_HANDLING") throw conflict("Take over the conversation before replying.");
  const msg = await addMessage(prisma, { conversationId, role: "HUMAN", content, engine: "human", meta: { agent: agentName } });
  await audit(prisma, { actor: `human:${agentName}`, entityType: "conversation", entityId: conversationId, action: "HUMAN_REPLY", newValue: { length: content.length } });
  await emitMessage(msg);
  return msg;
}
