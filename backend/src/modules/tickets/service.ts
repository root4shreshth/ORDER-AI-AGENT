import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { publish } from "../../lib/events.js";
import { audit, type Actor } from "../audit/audit.js";
import { addMessage, emitMessage } from "../conversations/service.js";
import { maskDeep } from "../../lib/mask.js";
import { fmtInr } from "../../lib/format.js";
import { getOrderByNumber } from "../orders/service.js";

export const HANDOVER_REASONS = [
  "CUSTOMER_REQUESTED_HUMAN",
  "LEGAL_THREAT",
  "PUBLIC_COMPLAINT_THREAT",
  "ANGRY_CUSTOMER",
  "MANUAL_REVIEW_REQUIRED",
  "REFUND_ABOVE_THRESHOLD",
  "REPEATED_FAILURE",
  "TOOL_FAILURE",
  "UNCLEAR_REQUEST",
  "VERIFICATION_FAILED",
  "BULK_ORDER",
  "NDR_NO_RESPONSE",
  "PROMPT_INJECTION",
  "OTHER",
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

const HANDOVER_MESSAGE: Record<string, string> = {
  en: "I've passed this to our support team with all the details. Someone from the team will join this chat shortly.",
  hi: "मैंने आपकी पूरी जानकारी हमारी सपोर्ट टीम को दे दी है। टीम का कोई सदस्य जल्द ही इस चैट में जुड़ेगा।",
  hinglish: "Maine aapki saari details hamari support team ko de di hain. Team ka koi member jaldi hi is chat mein join karega.",
};

export interface HandoverInput {
  reason: HandoverReason;
  mood: string;
  summary: string;
  suggestedReply: string;
  orderNumber?: string | null;
  toolsCalled?: unknown;
  actor?: Actor;
  language?: string | null;
  notifyCustomer?: boolean;
}

/**
 * Hand the conversation to a human: AI_HANDLING → NEEDS_HUMAN (conditional), create a ticket
 * with summary / order context / mood / suggested reply, tell the customer. Idempotent: if the
 * conversation is already with a human, the existing open ticket is returned.
 */
export async function createHandover(conversationId: string, input: HandoverInput) {
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  if (conv.status !== "AI_HANDLING") {
    const t = await prisma.supportTicket.findFirst({ where: { conversationId, status: { not: "CLOSED" } }, orderBy: { createdAt: "desc" } });
    if (t) return { ticket: t, alreadyHandedOver: true, customerMessage: null };
  }

  let orderContext: Prisma.InputJsonValue | undefined;
  if (input.orderNumber && conv.verifiedOrderNumbers.includes(input.orderNumber)) {
    const o = await getOrderByNumber(prisma, input.orderNumber);
    if (o) {
      const shipment = await prisma.shipment.findUnique({ where: { orderId: o.id } });
      orderContext = maskDeep({
        orderNumber: o.orderNumber,
        status: o.status,
        paymentMethod: o.paymentMethod,
        total: fmtInr(o.total),
        items: o.items.map((i) => `${i.product.name} (${i.size}) x${i.quantity}`),
        shipment: shipment ? { awb: shipment.awb, status: shipment.status, attempts: shipment.attemptCount, lastFailure: shipment.lastFailureReason } : null,
        city: `${o.city} ${o.pincode}`,
      }) as Prisma.InputJsonValue;
    }
  }

  const ticket = await prisma.$transaction(async (tx) => {
    const moved = await tx.conversation.updateMany({
      where: { id: conversationId, status: "AI_HANDLING" },
      data: { status: "NEEDS_HUMAN", handoverReason: input.reason, version: { increment: 1 } },
    });
    if (moved.count === 0) {
      const existing = await tx.supportTicket.findFirst({ where: { conversationId, status: { not: "CLOSED" } } });
      if (existing) return existing;
    }
    const t = await tx.supportTicket.create({
      data: {
        conversationId,
        orderNumber: input.orderNumber ?? null,
        reason: input.reason,
        mood: input.mood.slice(0, 40),
        summary: input.summary.slice(0, 600),
        suggestedReply: input.suggestedReply.slice(0, 1200),
        orderContext,
        toolsCalled: input.toolsCalled ? (maskDeep(input.toolsCalled) as Prisma.InputJsonValue) : undefined,
      },
    });
    await audit(tx, { actor: input.actor ?? "ai", entityType: "conversation", entityId: conversationId, action: "HANDOVER", newValue: { reason: input.reason, mood: input.mood, ticketId: t.id } });
    return t;
  });

  let customerMessage = null;
  if (input.notifyCustomer !== false) {
    const lang = input.language && HANDOVER_MESSAGE[input.language] ? input.language : "en";
    customerMessage = await addMessage(prisma, { conversationId, role: "AI", content: HANDOVER_MESSAGE[lang]!, engine: "template", intent: "handover", meta: { handover: true, reason: input.reason } });
    await emitMessage(customerMessage);
  }
  await publish({ type: "ticket:new", conversationId, ticketId: ticket.id });
  await publish({ type: "conversation:updated", conversationId, status: "NEEDS_HUMAN" });
  return { ticket, alreadyHandedOver: false, customerMessage };
}
