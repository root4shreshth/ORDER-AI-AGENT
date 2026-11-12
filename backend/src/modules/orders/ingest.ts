/**
 * Creating orders — one code path for every source:
 *   store webhook (order.created) · dashboard "New order" (via the same signed webhook) ·
 *   chat orders placed by the agent after the customer's explicit "yes".
 * Quotes are computed here (never by the LLM): prices from the catalogue, live stock,
 * shipping, COD fee / eligibility, prepaid discount, bulk limit.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { fmtInr, normalizePhone } from "../../lib/format.js";
import { checkCodEligibility, checkOrderQuantity, deliveryEstimate, POLICY, shippingFee } from "../../policies/index.js";
import { audit, type Actor } from "../audit/audit.js";
import { computeRisk, startCodFlow } from "../cod/service.js";
import { getPincode } from "./service.js";
import { getSettings } from "../settings/settings.js";
import { publish } from "../../lib/events.js";
import { enqueue } from "../../jobs/queues.js";
import { env } from "../../config/env.js";

export const ORDER_SOURCES = ["store", "dashboard", "chat_telegram", "chat_web"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

const ItemSchema = z.object({ sku: z.string().min(3).max(20), size: z.string().min(1).max(5), quantity: z.number().int().min(1).max(10) });

export const OrderWebhookSchema = z.object({
  event_id: z.string().min(6).max(80),
  type: z.literal("order.created"),
  order: z.object({
    order_number: z.string().regex(/^WL\d{4,8}$/).optional(),
    source: z.enum(["store", "dashboard"]).optional(),
    customer: z.object({ name: z.string().min(2).max(80), phone: z.string().min(10).max(16), email: z.string().email().optional() }),
    payment_method: z.enum(["COD", "PREPAID"]),
    items: z.array(ItemSchema).min(1).max(20),
    address: z.object({ line1: z.string().min(3).max(200), line2: z.string().max(200).optional(), landmark: z.string().max(120).optional(), pincode: z.string().regex(/^\d{6}$/) }),
  }),
});
export type OrderWebhook = z.infer<typeof OrderWebhookSchema>;

export async function nextOrderNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ max: number | null }[]>`SELECT MAX(CAST(SUBSTRING("orderNumber" FROM 3) AS INTEGER)) AS max FROM "Order"`;
  return `WL${(rows[0]?.max ?? 10300) + 1}`;
}

// ---------------------------------------------------------------- quote
export interface QuoteInput {
  items: { sku: string; size: string; quantity: number }[];
  pincode: string;
  paymentMethod: "COD" | "PREPAID";
  /** chat orders that choose prepaid instead of COD get the "switch to prepaid" 5% off */
  prepaidDiscount?: boolean;
  /** team-approved bulk quote: its unit prices apply, no bulk limit, made to order (no stock check) */
  approvedQuote?: { items: { sku: string; size: string; quantity: number; unitPrice: number }[] };
}

export async function quoteOrder(q: QuoteInput) {
  if (q.approvedQuote) return quoteFromApproved(q);
  const qty = checkOrderQuantity(q.items);
  if (!qty.allowed) throw new AppError(422, qty.code, qty.reason);
  const pin = await getPincode(prisma, q.pincode);
  if (!pin?.serviceable) throw new AppError(422, "PINCODE_NOT_SERVICEABLE", `We don't deliver to pincode ${q.pincode} yet.`);
  const products = await prisma.product.findMany({ where: { sku: { in: q.items.map((i) => i.sku.toUpperCase()) } }, include: { variants: true } });
  const lines = q.items.map((i) => {
    const p = products.find((x) => x.sku === i.sku.toUpperCase());
    if (!p) throw new AppError(422, "UNKNOWN_SKU", `We don't have a product with code ${i.sku}.`);
    const v = p.variants.find((x) => x.size.toUpperCase() === i.size.toUpperCase());
    if (!v) throw new AppError(422, "SIZE_NOT_OFFERED", `${p.name} doesn't come in size ${i.size}.`);
    if (v.stock < i.quantity) throw new AppError(422, "OUT_OF_STOCK", `${p.name} in size ${v.size} is out of stock${v.stock > 0 ? ` (only ${v.stock} left)` : ""}.`);
    return { sku: p.sku, size: v.size, quantity: i.quantity, product: p, unitPrice: p.priceInr };
  });
  const itemsTotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const ship = shippingFee(itemsTotal);
  const codFee = q.paymentMethod === "COD" ? POLICY.COD_FEE : 0;
  const s = await getSettings();
  const discount = q.paymentMethod === "PREPAID" && q.prepaidDiscount ? Math.round((itemsTotal * s.cod.prepaidDiscountPct) / 100) : 0;
  const total = itemsTotal + ship + codFee - discount;
  if (q.paymentMethod === "COD") {
    const d = checkCodEligibility(total, pin);
    if (!d.allowed) throw new AppError(422, d.code, d.reason);
  }
  return { lines, itemsTotal, shippingFee: ship, codFee, discount, total, pin, eta: deliveryEstimate(pin.zone).text };
}
async function quoteFromApproved(q: QuoteInput) {
  const pin = await getPincode(prisma, q.pincode);
  if (!pin?.serviceable) throw new AppError(422, "PINCODE_NOT_SERVICEABLE", `We don't deliver to pincode ${q.pincode} yet.`);
  const items = q.approvedQuote!.items;
  const products = await prisma.product.findMany({ where: { sku: { in: items.map((i) => i.sku) } }, include: { variants: true } });
  const lines = items.map((i) => {
    const p = products.find((x) => x.sku === i.sku);
    if (!p) throw new AppError(422, "UNKNOWN_SKU", `Unknown product ${i.sku}`);
    return { sku: p.sku, size: i.size, quantity: i.quantity, product: p, unitPrice: i.unitPrice };
  });
  const itemsTotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const ship = shippingFee(itemsTotal);
  const codFee = q.paymentMethod === "COD" ? POLICY.COD_FEE : 0;
  const total = itemsTotal + ship + codFee;
  if (q.paymentMethod === "COD") {
    const d = checkCodEligibility(total, pin);
    if (!d.allowed) throw new AppError(422, d.code, `${d.reason} Bulk orders above that are paid online.`);
  }
  return { lines, itemsTotal, shippingFee: ship, codFee, discount: 0, total, pin, eta: `${deliveryEstimate(pin.zone).text} after dispatch (dispatch timeline as agreed with our team)` };
}

export type Quote = Awaited<ReturnType<typeof quoteOrder>>;

export function quoteSummary(q: Quote, paymentMethod: "COD" | "PREPAID"): string {
  const items = q.lines.map((l) => `${l.product.name} (size ${l.size}) × ${l.quantity} — ${fmtInr(l.unitPrice * l.quantity)}`).join("; ");
  const parts = [`Items: ${items}`, `Shipping: ${q.shippingFee ? fmtInr(q.shippingFee) : "free"}`];
  if (q.codFee) parts.push(`COD fee: ${fmtInr(q.codFee)}`);
  if (q.discount) parts.push(`Prepaid discount: −${fmtInr(q.discount)}`);
  parts.push(`Total: ${fmtInr(q.total)} (${paymentMethod === "COD" ? "pay on delivery" : "pay online"})`, `Delivery to ${q.pin.city} ${q.pin.pincode} in ${q.eta}`);
  return parts.join(". ");
}

// ---------------------------------------------------------------- create
export interface CreateOrderInput extends QuoteInput {
  orderNumber?: string;
  customer: { name: string; phone: string; email?: string };
  address: { line1: string; line2?: string; landmark?: string };
  source: OrderSource;
  /** the customer already said "yes" to the full summary in chat → no separate COD confirmation */
  confirmedInChat?: boolean;
  actor: Actor;
  eventId?: string;
}

export async function createOrder(input: CreateOrderInput): Promise<{ orderId: string; orderNumber: string; created: boolean; total: number; paymentLink?: string }> {
  const phone = normalizePhone(input.customer.phone);
  if (!phone) throw new AppError(422, "INVALID_PHONE", "Please share a valid 10-digit mobile number.");

  if (input.orderNumber) {
    const existing = await prisma.order.findUnique({ where: { orderNumber: input.orderNumber } });
    if (existing) {
      if (existing.paymentMethod === "COD" && !input.confirmedInChat) await startCodFlow(existing.id);
      return { orderId: existing.id, orderNumber: existing.orderNumber, created: false, total: existing.total };
    }
  }
  const q = await quoteOrder(input);
  const orderNumber = input.orderNumber ?? (await nextOrderNumber());
  const confirmed = input.confirmedInChat || input.paymentMethod === "PREPAID";
  const paymentLink = input.paymentMethod === "PREPAID" && input.source.startsWith("chat") ? `${env.WEB_URL}/pay/${orderNumber}` : undefined;

  const order = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.upsert({ where: { phone }, create: { name: input.customer.name, phone, email: input.customer.email }, update: {} });
    // Bulk orders on an approved quote are made to order — no shelf-stock reservation.
    for (const l of input.approvedQuote ? [] : q.lines) {
      const r = await tx.productVariant.updateMany({ where: { productId: l.product.id, size: l.size, stock: { gte: l.quantity } }, data: { stock: { decrement: l.quantity } } });
      if (r.count !== 1) throw new AppError(422, "OUT_OF_STOCK", `${l.product.name} size ${l.size} just went out of stock.`);
    }
    const created = await tx.order.create({
      data: {
        orderNumber,
        customerId: customer.id,
        source: input.source,
        paymentMethod: input.paymentMethod,
        status: confirmed ? "CONFIRMED" : "PENDING_CONFIRMATION",
        itemsTotal: q.itemsTotal,
        shippingFee: q.shippingFee,
        codFee: q.codFee,
        discount: q.discount,
        total: q.total,
        addressLine1: input.address.line1,
        addressLine2: input.address.line2,
        landmark: input.address.landmark,
        city: q.pin.city,
        state: (await tx.pincode.findUniqueOrThrow({ where: { pincode: q.pin.pincode } })).state,
        pincode: q.pin.pincode,
        notes: [{ at: new Date().toISOString(), by: input.actor, text: `Order placed via ${input.source.replace("_", " ")}${input.eventId ? ` (${input.eventId})` : ""}${input.approvedQuote ? " — bulk order on a team-approved quote (made to order)" : ""}` }],
        items: { create: q.lines.map((l) => ({ productId: l.product.id, sku: l.sku, size: l.size, quantity: l.quantity, unitPrice: l.unitPrice })) },
      },
    });
    await audit(tx, { actor: input.actor, entityType: "order", entityId: orderNumber, action: "ORDER_CREATED", newValue: { source: input.source, paymentMethod: input.paymentMethod, total: fmtInr(q.total), pincode: q.pin.pincode }, meta: { eventId: input.eventId } });
    return created;
  });

  if (input.paymentMethod === "COD") {
    if (input.confirmedInChat) {
      // Still score the risk (shown on the order page) — the customer already confirmed in chat.
      const risk = await computeRisk(order);
      await prisma.codConfirmation.create({
        data: { orderId: order.id, riskScore: risk.score, riskBand: risk.band, reasons: risk.reasons as unknown as Prisma.InputJsonValue, status: "CONFIRMED", response: "CONFIRMED_IN_CHAT", respondedAt: new Date(), sentAt: new Date() },
      });
    } else {
      await startCodFlow(order.id); // risk score + confirmation message (greets the customer)
    }
  } else if (!input.source.startsWith("chat")) {
    await enqueue({ name: "order-welcome", orderId: order.id }, `order-welcome-${order.id}`, { delay: 2000 });
  }
  await enqueue({ name: "team-new-order", orderId: order.id }, `team-new-order-${order.id}`);
  await publish({ type: "order:new", orderId: order.id, orderNumber, source: input.source, total: q.total });
  await publish({ type: "order:updated", orderId: order.id, orderNumber });
  return { orderId: order.id, orderNumber, created: true, total: q.total, paymentLink };
}

/** Webhook path (store platform / dashboard "New order"). */
export async function ingestOrder(payload: OrderWebhook) {
  const o = payload.order;
  return createOrder({
    orderNumber: o.order_number,
    customer: o.customer,
    items: o.items,
    pincode: o.address.pincode,
    address: { line1: o.address.line1, line2: o.address.line2, landmark: o.address.landmark },
    paymentMethod: o.payment_method,
    source: o.source ?? "store",
    actor: "system",
    eventId: payload.event_id,
  });
}
