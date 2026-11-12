/**
 * COD confirmation lifecycle:
 *   new COD order → risk score → confirmation message (≤1 min) → reminder (2h) → hold (24h)
 * Replies: CONFIRM | CANCEL | EDIT_ADDRESS | PAY_ONLINE (5% off). Free text goes to the agent.
 * All transitions are conditional on the current status + version (no double-processing).
 */
import type { CodConfirmation, CodStatus, Order, Prisma } from "@prisma/client";
import { prisma, type Tx } from "../../lib/prisma.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { fmtInr } from "../../lib/format.js";
import { env } from "../../config/env.js";
import { scoreCodRisk, type RiskReason } from "../../risk/codRisk.js";
import { prepaidConversion, isPreDispatch } from "../../policies/index.js";
import { getSettings } from "../settings/settings.js";
import { audit, type Actor } from "../audit/audit.js";
import { addNote } from "../orders/service.js";
import { enqueue } from "../../jobs/queues.js";
import { getOrCreateOrderConversation, sendAutomatedMessage, addMessage, emitMessage } from "../conversations/service.js";
import { publish } from "../../lib/events.js";

export const COD_CHOICES = ["CONFIRM", "CANCEL", "EDIT_ADDRESS", "PAY_ONLINE"] as const;
export type CodChoice = (typeof COD_CHOICES)[number];
const OPEN: CodStatus[] = ["AWAITING", "ADDRESS_EDIT_REQUESTED", "ON_HOLD"];

export const COD_QUICK_REPLIES = [
  { id: "CONFIRM", label: "✅ Confirm order" },
  { id: "CANCEL", label: "❌ Cancel order" },
  { id: "EDIT_ADDRESS", label: "📍 Edit address" },
  { id: "PAY_ONLINE", label: "💳 Pay online & get 5% off" },
];

export async function computeRisk(order: Order) {
  const settings = await getSettings();
  const others = await prisma.order.findMany({ where: { customerId: order.customerId, id: { not: order.id }, placedAt: { lt: order.placedAt } } });
  const dayAgo = new Date(order.placedAt.getTime() - 86_400_000);
  return scoreCodRisk(
    {
      orderTotal: order.total,
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      landmark: order.landmark,
      priorOrders: others.length,
      deliveredOrders: others.filter((o) => o.status === "DELIVERED").length,
      previousCodRefusals: others.filter((o) => o.paymentMethod === "COD" && (o.status === "RTO_INITIATED" || o.status === "RTO_DELIVERED")).length,
      recentCodOrders: others.filter((o) => o.paymentMethod === "COD" && o.placedAt >= dayAgo).length,
    },
    settings.risk,
  );
}

/** Idempotent: a second call for the same order does nothing. */
export async function startCodFlow(orderId: string): Promise<{ created: boolean; confirmation: CodConfirmation }> {
  const existing = await prisma.codConfirmation.findUnique({ where: { orderId } });
  if (existing) return { created: false, confirmation: existing };
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const risk = await computeRisk(order);
  let confirmation: CodConfirmation;
  try {
    confirmation = await prisma.$transaction(async (tx) => {
      const c = await tx.codConfirmation.create({
        data: { orderId, riskScore: risk.score, riskBand: risk.band, reasons: risk.reasons as unknown as Prisma.InputJsonValue, status: "AWAITING" },
      });
      if (order.status !== "PENDING_CONFIRMATION") await tx.order.update({ where: { id: orderId }, data: { status: "PENDING_CONFIRMATION" } });
      await audit(tx, { actor: "system", entityType: "cod", entityId: order.orderNumber, action: "COD_RISK_SCORED", newValue: { score: risk.score, band: risk.band, signals: risk.reasons.map((r) => `${r.signal} ${r.points >= 0 ? "+" : ""}${r.points}`) } });
      return c;
    });
  } catch (e) {
    // unique(orderId) race → someone else created it
    const again = await prisma.codConfirmation.findUnique({ where: { orderId } });
    if (again) return { created: false, confirmation: again };
    throw e;
  }
  const s = await getSettings();
  await enqueue({ name: "cod-confirm", orderId }, `cod-confirm-${orderId}`, { delay: s.cod.confirmationDelaySec * 1000 });
  await enqueue({ name: "cod-reminder", orderId }, `cod-reminder-${orderId}`, { delay: (s.cod.confirmationDelaySec + s.cod.reminderDelaySec) * 1000 });
  await enqueue({ name: "cod-hold", orderId }, `cod-hold-${orderId}`, { delay: (s.cod.confirmationDelaySec + s.cod.holdDelaySec) * 1000 });
  await publish({ type: "order:updated", orderId, orderNumber: order.orderNumber });
  return { created: true, confirmation };
}

function summaryText(o: Order & { items: { sku: string; size: string; quantity: number; product: { name: string } }[] }) {
  const items = o.items.map((i) => `• ${i.product.name} (${i.size}) × ${i.quantity}`).join("\n");
  return `${items}\nAmount to pay on delivery: ${fmtInr(o.total)} (incl. ${fmtInr(o.codFee)} COD fee)`;
}

export async function sendCodConfirmation(orderId: string): Promise<"sent" | "skipped"> {
  const cod = await prisma.codConfirmation.findUnique({ where: { orderId } });
  if (!cod || cod.status !== "AWAITING" || cod.sentAt) return "skipped";
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { product: true } }, customer: true } });
  const conv = await getOrCreateOrderConversation(orderId, "COD");
  const claimed = await prisma.codConfirmation.updateMany({ where: { id: cod.id, sentAt: null }, data: { sentAt: new Date(), conversationId: conv.id } });
  if (claimed.count === 0) return "skipped"; // another worker already sent it
  const s = await getSettings();
  const { discount, newTotal } = prepaidConversion(order, s.cod.prepaidDiscountPct);
  const text =
    `Hi ${order.customer.name.split(" ")[0]}, thanks for shopping with Wishluck! Please confirm your Cash on Delivery order ${order.orderNumber}:\n` +
    `${summaryText(order)}\nDelivering to ${order.city} ${order.pincode}.\n\n` +
    `Pay online now and get ${s.cod.prepaidDiscountPct}% off — you'd pay ${fmtInr(newTotal)} (save ${fmtInr(discount + order.codFee)}).\n` +
    `Reply with one of the options below, or type your question.`;
  await sendAutomatedMessage(conv.id, text, { quickReplies: COD_QUICK_REPLIES, orderNumber: order.orderNumber, kind: "COD_CONFIRMATION" } as Prisma.InputJsonValue);
  await audit(prisma, { actor: "system", entityType: "cod", entityId: order.orderNumber, action: "COD_CONFIRMATION_SENT", meta: { conversationId: conv.id } });
  return "sent";
}

export async function sendCodReminder(orderId: string): Promise<"sent" | "skipped"> {
  const cod = await prisma.codConfirmation.findUnique({ where: { orderId }, include: { order: true } });
  if (!cod || !cod.conversationId || !["AWAITING", "ADDRESS_EDIT_REQUESTED"].includes(cod.status) || cod.reminderSentAt) return "skipped";
  const claimed = await prisma.codConfirmation.updateMany({ where: { id: cod.id, reminderSentAt: null, status: { in: ["AWAITING", "ADDRESS_EDIT_REQUESTED"] } }, data: { reminderSentAt: new Date() } });
  if (claimed.count === 0) return "skipped";
  await sendAutomatedMessage(
    cod.conversationId,
    `Reminder: your COD order ${cod.order.orderNumber} (${fmtInr(cod.order.total)}) is waiting for confirmation. Please confirm so we can ship it — or pay online for 5% off.`,
    { quickReplies: COD_QUICK_REPLIES, orderNumber: cod.order.orderNumber, kind: "COD_REMINDER" } as Prisma.InputJsonValue,
  );
  await audit(prisma, { actor: "system", entityType: "cod", entityId: cod.order.orderNumber, action: "COD_REMINDER_SENT" });
  return "sent";
}

export async function holdCodOrder(orderId: string): Promise<"held" | "skipped"> {
  const result = await prisma.$transaction(async (tx) => {
    const cod = await tx.codConfirmation.findUnique({ where: { orderId }, include: { order: true } });
    if (!cod || !["AWAITING", "ADDRESS_EDIT_REQUESTED"].includes(cod.status)) return null;
    const moved = await tx.codConfirmation.updateMany({ where: { id: cod.id, version: cod.version, status: cod.status }, data: { status: "ON_HOLD", heldAt: new Date(), version: { increment: 1 } } });
    if (moved.count === 0) return null;
    await tx.order.updateMany({ where: { id: orderId, status: "PENDING_CONFIRMATION" }, data: { status: "ON_HOLD", version: { increment: 1 } } });
    await addNote(tx, orderId, "system", "COD order put on hold — no confirmation received in time");
    await audit(tx, { actor: "system", entityType: "cod", entityId: cod.order.orderNumber, action: "COD_ON_HOLD", oldValue: { status: cod.status }, newValue: { status: "ON_HOLD" } });
    return cod;
  });
  if (!result) return "skipped";
  if (result.conversationId) {
    await sendAutomatedMessage(
      result.conversationId,
      `We haven't heard back, so order ${result.order.orderNumber} is on hold and won't ship yet. Reply "Confirm" anytime to release it, or "Cancel" if you no longer need it.`,
      { quickReplies: COD_QUICK_REPLIES.slice(0, 2), orderNumber: result.order.orderNumber, kind: "COD_HOLD" } as Prisma.InputJsonValue,
    );
  }
  await publish({ type: "order:updated", orderId, orderNumber: result.order.orderNumber });
  return "held";
}

export interface CodResponseResult {
  orderNumber: string;
  choice: CodChoice;
  status: CodStatus;
  message: string;
  paymentLink?: string;
}

/** Apply a customer's COD choice. Exactly one of two concurrent responses wins (409 for the other). */
export async function respondToCod(orderNumber: string, choice: CodChoice, actor: Actor): Promise<CodResponseResult> {
  const s = await getSettings();
  const result = await prisma.$transaction(async (tx: Tx): Promise<CodResponseResult> => {
    const order = await tx.order.findUnique({ where: { orderNumber }, include: { codConfirmation: true, items: true } });
    if (!order) throw notFound("Order");
    const cod = order.codConfirmation;
    if (!cod) throw new AppError(422, "NOT_A_COD_ORDER", "This order has no pending COD confirmation.");
    if (!OPEN.includes(cod.status)) {
      throw new AppError(409, "COD_ALREADY_RESOLVED", `This COD order was already handled (${cod.status.toLowerCase().replace(/_/g, " ")}).`);
    }
    if (!isPreDispatch(order.status)) throw new AppError(409, "ORDER_NOT_PENDING", "This order is no longer awaiting confirmation.");

    const claim = async (status: CodStatus, extra: Prisma.CodConfirmationUpdateManyMutationInput = {}) => {
      const r = await tx.codConfirmation.updateMany({
        where: { id: cod.id, version: cod.version, status: { in: OPEN } },
        data: { status, respondedAt: new Date(), response: choice, version: { increment: 1 }, ...extra },
      });
      if (r.count !== 1) throw conflict("Another response for this order was processed first.");
    };
    const orderUpdate = async (data: Prisma.OrderUpdateManyMutationInput) => {
      const r = await tx.order.updateMany({ where: { id: order.id, version: order.version }, data: { ...data, version: { increment: 1 } } });
      if (r.count !== 1) throw conflict("Order changed concurrently, please retry.");
    };
    const wasHeld = cod.status === "ON_HOLD";

    switch (choice) {
      case "CONFIRM": {
        await claim("CONFIRMED");
        await orderUpdate({ status: "CONFIRMED" });
        await addNote(tx, order.id, actor, wasHeld ? "COD confirmed by customer after hold — released" : "COD confirmed by customer");
        await audit(tx, { actor, entityType: "cod", entityId: orderNumber, action: "COD_CONFIRMED", oldValue: { status: cod.status }, newValue: { status: "CONFIRMED" } });
        return { orderNumber, choice, status: "CONFIRMED", message: `Thank you! Order ${orderNumber} is confirmed${wasHeld ? " and released from hold" : ""}. We'll ship it soon — please keep ${fmtInr(order.total)} ready at delivery.` };
      }
      case "CANCEL": {
        await claim("CANCELLED");
        await orderUpdate({ status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Cancelled by customer at COD confirmation" });
        for (const it of order.items) {
          await tx.productVariant.updateMany({ where: { productId: it.productId, size: it.size }, data: { stock: { increment: it.quantity } } });
        }
        await addNote(tx, order.id, actor, "Cancelled by customer at COD confirmation");
        await audit(tx, { actor, entityType: "cod", entityId: orderNumber, action: "COD_CANCELLED", oldValue: { status: cod.status, orderStatus: order.status }, newValue: { status: "CANCELLED", orderStatus: "CANCELLED" } });
        return { orderNumber, choice, status: "CANCELLED", message: `Order ${orderNumber} has been cancelled. Nothing will be charged. Hope to see you again soon!` };
      }
      case "PAY_ONLINE": {
        const { discount, newTotal } = prepaidConversion(order, s.cod.prepaidDiscountPct);
        const paymentLink = `${env.WEB_URL}/pay/${orderNumber}`;
        await claim("CONVERTED_PREPAID", { paymentLink });
        await orderUpdate({ paymentMethod: "PREPAID", codFee: 0, discount, total: newTotal, status: "CONFIRMED" });
        await addNote(tx, order.id, actor, `Converted COD → prepaid with ${s.cod.prepaidDiscountPct}% off (${fmtInr(discount)}). New total ${fmtInr(newTotal)}`);
        await audit(tx, { actor, entityType: "cod", entityId: orderNumber, action: "COD_CONVERTED_PREPAID", oldValue: { paymentMethod: "COD", total: fmtInr(order.total) }, newValue: { paymentMethod: "PREPAID", total: fmtInr(newTotal), discount: fmtInr(discount) } });
        return {
          orderNumber,
          choice,
          status: "CONVERTED_PREPAID",
          paymentLink,
          message: `Great choice! Your new total is ${fmtInr(newTotal)} (${s.cod.prepaidDiscountPct}% off, no COD fee). Pay here: ${paymentLink} (demo payment link).`,
        };
      }
      case "EDIT_ADDRESS": {
        await claim("ADDRESS_EDIT_REQUESTED");
        await audit(tx, { actor, entityType: "cod", entityId: orderNumber, action: "COD_ADDRESS_EDIT_REQUESTED" });
        return { orderNumber, choice, status: "ADDRESS_EDIT_REQUESTED", message: "Sure — please type the full new delivery address with house/flat number, street, area and the 6-digit pincode." };
      }
    }
  });
  await publish({ type: "order:updated", orderId: orderNumber, orderNumber });
  return result;
}

/** Called from chat buttons: logs the customer's tap + the deterministic reply in the conversation. */
export async function respondFromChat(conversationId: string, orderNumber: string, choice: CodChoice) {
  const label = COD_QUICK_REPLIES.find((q) => q.id === choice)?.label ?? choice;
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  if (!conv.verifiedOrderNumbers.includes(orderNumber)) throw new AppError(403, "NOT_VERIFIED", "This conversation is not linked to that order.");
  const customerMsg = await addMessage(prisma, { conversationId, role: "CUSTOMER", content: label, intent: `cod_${choice.toLowerCase()}`, meta: { quickReply: choice } });
  await emitMessage(customerMsg);
  let reply: string;
  let result: CodResponseResult | null = null;
  try {
    result = await respondToCod(orderNumber, choice, "customer");
    reply = result.message;
  } catch (e) {
    reply = e instanceof AppError ? e.message : "Sorry, I couldn't update the order right now. Please try again in a moment.";
  }
  if (conv.status !== "AI_HANDLING") return { result, reply: null };
  const aiMsg = await addMessage(prisma, { conversationId, role: "AI", content: reply, engine: "template", intent: `cod_${choice.toLowerCase()}`, meta: result?.paymentLink ? { paymentLink: result.paymentLink } : undefined });
  await emitMessage(aiMsg);
  return { result, reply: aiMsg };
}

export function riskReasons(c: CodConfirmation): RiskReason[] {
  return (c.reasons as unknown as RiskReason[]) ?? [];
}
