/**
 * New-order notifications:
 *  - customer: a welcome message with the order details. It is delivered to Telegram when the
 *    customer's number is linked to the bot, otherwise it waits in their web conversation.
 *    (COD orders get the COD confirmation message instead, which also greets the customer.)
 *  - team: a short alert for every new order (dashboard live toast via the event bus, plus an
 *    optional Telegram team chat when TEAM_TELEGRAM_CHAT_ID is set).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { fmtInr, fmtDate } from "../../lib/format.js";
import { maskPhone } from "../../lib/mask.js";
import { deliveryEstimate } from "../../policies/index.js";
import { getOrCreateOrderConversation, sendAutomatedMessage } from "../conversations/service.js";
import { audit } from "../audit/audit.js";

const SOURCE_LABEL: Record<string, string> = { store: "Website store", dashboard: "Dashboard (team)", chat_telegram: "Telegram chat", chat_web: "Website chat" };

export async function sendOrderWelcome(orderId: string): Promise<"sent" | "skipped"> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } }, customer: true } });
  if (!o || o.status === "CANCELLED") return "skipped";
  const already = await prisma.auditLog.findFirst({ where: { entityType: "order", entityId: o.orderNumber, action: "ORDER_WELCOME_SENT" } });
  if (already) return "skipped";
  const pin = await prisma.pincode.findUnique({ where: { pincode: o.pincode } });
  const conv = await getOrCreateOrderConversation(o.id, "ORDER");
  const items = o.items.map((i) => `• ${i.product.name} (${i.size}) × ${i.quantity}`).join("\n");
  const text =
    `Hi ${o.customer.name.split(" ")[0]} 👋 Thank you for shopping with Wishluck!\n` +
    `Your order ${o.orderNumber} is confirmed:\n${items}\n` +
    `Total: ${fmtInr(o.total)} (${o.paymentMethod === "PREPAID" ? "paid online" : "pay on delivery"})\n` +
    `Delivering to ${o.city} ${o.pincode}${pin ? ` in ${deliveryEstimate(pin.zone).text}` : ""}.\n\n` +
    `I'm your Wishluck assistant — message me here anytime to track this order, change the address before it ships, or for returns, exchanges and refunds.`;
  await sendAutomatedMessage(conv.id, text, {
    orderNumber: o.orderNumber,
    kind: "ORDER_WELCOME",
    quickReplies: [
      { id: "TRACK", label: "📦 Track my order" },
      { id: "HELP", label: "💬 I need help" },
    ],
  } as Prisma.InputJsonValue);
  await audit(prisma, { actor: "system", entityType: "order", entityId: o.orderNumber, action: "ORDER_WELCOME_SENT", meta: { conversationId: conv.id, channel: conv.channel } });
  return "sent";
}

export async function notifyTeamNewOrder(orderId: string): Promise<"sent" | "logged"> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } }, customer: true, codConfirmation: true } });
  if (!o) return "logged";
  const lines = [
    `🛒 New order ${o.orderNumber} — ${fmtInr(o.total)} (${o.paymentMethod})`,
    `Customer: ${o.customer.name} · ${maskPhone(o.customer.phone)}${o.customer.telegramChatId ? " · on Telegram" : ""}`,
    `Items: ${o.items.map((i) => `${i.product.name} ${i.size}×${i.quantity}`).join(", ")}`,
    `Ship to: ${o.city} ${o.pincode}`,
    `Source: ${SOURCE_LABEL[o.source] ?? o.source} · placed ${fmtDate(o.placedAt)}`,
  ];
  if (o.codConfirmation) lines.push(`COD risk: ${o.codConfirmation.riskScore}/100 (${o.codConfirmation.riskBand.toLowerCase()}) · ${o.codConfirmation.status.toLowerCase().replace(/_/g, " ")}`);
  lines.push(`${env.WEB_URL}/orders/${o.orderNumber}`);
  const text = lines.join("\n");

  if (env.TELEGRAM_BOT_TOKEN && env.TEAM_TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TEAM_TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await audit(prisma, { actor: "system", entityType: "order", entityId: o.orderNumber, action: "TEAM_NOTIFIED", meta: { channel: "telegram" } });
      return "sent";
    } catch (err) {
      logger.warn({ err: String(err) }, "team Telegram notification failed");
      throw err; // BullMQ retries with backoff
    }
  }
  await audit(prisma, { actor: "system", entityType: "order", entityId: o.orderNumber, action: "TEAM_NOTIFIED", meta: { channel: "dashboard" } });
  return "logged";
}
