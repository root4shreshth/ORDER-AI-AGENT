/**
 * Order domain services. All mutations:
 *  - re-load fresh state inside a transaction,
 *  - re-run the deterministic policy,
 *  - apply a conditional (optimistic-lock) update on `version`,
 *  - write an audit row with masked before/after values.
 */
import type { Order, OrderItem, Prisma, Product } from "@prisma/client";
import { prisma, type Db, type Tx } from "../../lib/prisma.js";
import { conflict, notFound, AppError } from "../../lib/errors.js";
import { addWorkingDays, DAY_MS, fmtDate, fmtInr, normalizePhone } from "../../lib/format.js";
import {
  checkAddressChange,
  checkCancellation,
  checkExchange,
  checkManualReview,
  checkReturn,
  deliveryEstimate,
  refundMethodPolicy,
  type Decision,
  type PincodeInfo,
} from "../../policies/index.js";
import { audit, type Actor } from "../audit/audit.js";
import { publish } from "../../lib/events.js";
import { getSettings } from "../settings/settings.js";

export type OrderWithItems = Order & { items: (OrderItem & { product: Product })[] };

export async function getOrderByNumber(db: Db, orderNumber: string): Promise<OrderWithItems | null> {
  return db.order.findUnique({ where: { orderNumber }, include: { items: { include: { product: true } } } });
}

export async function getPincode(db: Db, pincode: string): Promise<PincodeInfo | null> {
  const p = await db.pincode.findUnique({ where: { pincode } });
  return p ? { pincode: p.pincode, serviceable: p.serviceable, codAvailable: p.codAvailable, zone: p.zone, city: p.city } : null;
}

export async function getStock(db: Db, sku: string, size: string): Promise<number | null> {
  const product = await db.product.findUnique({ where: { sku }, include: { variants: true } });
  if (!product) return null;
  const v = product.variants.find((x) => x.size.toUpperCase() === size.toUpperCase());
  return v ? v.stock : null;
}

export async function returnsInLast60Days(db: Db, customerId: string, now = new Date()): Promise<number> {
  return db.returnRequest.count({
    where: { type: "RETURN", order: { customerId }, createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) }, status: { not: "REJECTED" } },
  });
}

/** Customer-safe order view used by agent tools (no internal ids, no other customers). */
export function orderView(o: OrderWithItems) {
  return {
    order_number: o.orderNumber,
    status: o.status,
    payment_method: o.paymentMethod,
    placed_on: fmtDate(o.placedAt),
    shipped_on: fmtDate(o.shippedAt),
    delivered_on: fmtDate(o.deliveredAt),
    items: o.items.map((i, idx) => ({
      item_no: idx + 1,
      sku: i.sku,
      name: i.product.name,
      size: i.size,
      quantity: i.quantity,
      price: fmtInr(i.unitPrice),
      returned: i.returned,
      exchanges_used: i.exchangeCount,
    })),
    items_total: fmtInr(o.itemsTotal),
    shipping_fee: fmtInr(o.shippingFee),
    cod_fee: fmtInr(o.codFee),
    discount: fmtInr(o.discount),
    total: fmtInr(o.total),
    delivery_city: `${o.city} ${o.pincode}`,
  };
}

async function addNote(tx: Tx, orderId: string, by: string, text: string): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { notes: true } });
  const notes = Array.isArray(o.notes) ? (o.notes as Prisma.JsonArray) : [];
  await tx.order.update({ where: { id: orderId }, data: { notes: [...notes, { at: new Date().toISOString(), by, text }] } });
}
export { addNote };

/** Optimistic-lock update: fails with 409 if someone changed the order meanwhile. */
async function guardedUpdate(tx: Tx, order: Order, data: Prisma.OrderUpdateManyMutationInput): Promise<void> {
  const res = await tx.order.updateMany({ where: { id: order.id, version: order.version }, data: { ...data, version: { increment: 1 } } });
  if (res.count !== 1) throw conflict("Order was modified concurrently, please retry.");
}

function findItem(o: OrderWithItems, sku?: string, itemNo?: number) {
  if (itemNo !== undefined) return o.items[itemNo - 1];
  if (sku) return o.items.find((i) => i.sku.toUpperCase() === sku.toUpperCase());
  return o.items.length === 1 ? o.items[0] : undefined;
}

// ---------------------------------------------------------------- read-side eligibility (used by tools)
/**
 * unused_with_tags may be unknown: the hard rules (innerwear, sale, window, manual review) are
 * evaluated first, and only if the item condition is the deciding factor do we ask for it.
 */
export async function evaluateReturn(db: Db, o: OrderWithItems, args: { sku?: string; item_no?: number; unused_with_tags?: boolean }, now = new Date()) {
  const item = findItem(o, args.sku, args.item_no);
  if (!item) return { decision: { allowed: false, code: "ITEM_NOT_FOUND", reason: "I couldn't match that item on this order. Which item would you like to return?" } as Decision, item: null };
  const open = await db.returnRequest.count({ where: { orderItemId: item.id, status: { in: ["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "MANUAL_REVIEW"] } } });
  const decision = checkReturn(
    { returnClass: item.product.returnClass, deliveredAt: o.deliveredAt, returned: item.returned, exchangeCount: item.exchangeCount, hasOpenRequest: open > 0 },
    { now, unusedWithTags: args.unused_with_tags ?? true },
  );
  if (!decision.allowed) return { decision, item };
  const settings = await getSettings();
  const refundAmount = item.unitPrice * item.quantity;
  const review = checkManualReview({
    refundAmount,
    returnsLast60Days: await returnsInLast60Days(db, o.customerId, now),
    thresholdPaise: settings.handover.refundReviewThresholdInr * 100,
  });
  if (review.requiresManualReview) return { decision: { ...review, data: { ...review.data, refundAmount: fmtInr(refundAmount) } }, item };
  const refund = refundMethodPolicy(o.paymentMethod);
  if (args.unused_with_tags === undefined) {
    return {
      decision: {
        allowed: false,
        code: "NEEDS_ITEM_CONDITION",
        reason: "Eligible on date and product type. Ask the customer whether the item is unused with its original tags, then check again.",
        data: { refund_amount: fmtInr(refundAmount), refund_methods: refund.methods, refund_policy: refund.text },
      } as Decision,
      item,
    };
  }
  return {
    decision: { ...decision, data: { ...decision.data, refund_amount: fmtInr(refundAmount), refund_methods: refund.methods, refund_policy: refund.text } },
    item,
  };
}

export async function evaluateExchange(db: Db, o: OrderWithItems, args: { sku?: string; item_no?: number; new_size: string }, now = new Date()) {
  const item = findItem(o, args.sku, args.item_no);
  if (!item) return { decision: { allowed: false, code: "ITEM_NOT_FOUND", reason: "I couldn't match that item on this order." } as Decision, item: null };
  const open = await db.returnRequest.count({ where: { orderItemId: item.id, status: { in: ["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "MANUAL_REVIEW"] } } });
  const stock = await getStock(db, item.sku, args.new_size);
  const decision = checkExchange(
    { returnClass: item.product.returnClass, deliveredAt: o.deliveredAt, returned: item.returned, exchangeCount: item.exchangeCount, hasOpenRequest: open > 0, currentSize: item.size },
    { now, newSize: args.new_size.toUpperCase(), stockForNewSize: stock },
  );
  return { decision, item };
}

// ---------------------------------------------------------------- mutations
export async function cancelOrder(orderNumber: string, reason: string, actor: Actor) {
  const result = await prisma.$transaction(async (tx) => {
    const o = await getOrderByNumber(tx, orderNumber);
    if (!o) throw notFound("Order");
    const decision = checkCancellation(o);
    if (!decision.allowed) throw new AppError(422, decision.code, decision.reason);
    await guardedUpdate(tx, o, { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.slice(0, 300) });
    for (const it of o.items) {
      await tx.productVariant.updateMany({ where: { productId: it.productId, size: it.size }, data: { stock: { increment: it.quantity } } });
    }
    await tx.codConfirmation.updateMany({ where: { orderId: o.id, status: { in: ["AWAITING", "ON_HOLD", "ADDRESS_EDIT_REQUESTED"] } }, data: { status: "CANCELLED", respondedAt: new Date(), version: { increment: 1 } } });
    let refund = null;
    if (o.paymentMethod === "PREPAID") {
      refund = await tx.refund.create({
        data: { orderId: o.id, amount: o.total, method: "ORIGINAL_PAYMENT", status: "PROCESSING", expectedBy: addWorkingDays(new Date(), 7) },
      });
    }
    await addNote(tx, o.id, actor, `Order cancelled: ${reason}`);
    await audit(tx, { actor, entityType: "order", entityId: o.orderNumber, action: "CANCEL", oldValue: { status: o.status }, newValue: { status: "CANCELLED", reason, refund: refund ? fmtInr(refund.amount) : null } });
    return { order_number: o.orderNumber, status: "CANCELLED", refund: refund ? { amount: fmtInr(refund.amount), method: "original payment method", expected_by: fmtDate(refund.expectedBy) } : null };
  });
  await publish({ type: "order:updated", orderId: orderNumber, orderNumber });
  return result;
}

export interface NewAddress {
  address_line1: string;
  address_line2?: string;
  landmark?: string;
  pincode: string;
}

export async function changeAddress(orderNumber: string, addr: NewAddress, actor: Actor) {
  const result = await prisma.$transaction(async (tx) => {
    const o = await getOrderByNumber(tx, orderNumber);
    if (!o) throw notFound("Order");
    const pin = await getPincode(tx, addr.pincode);
    const decision = checkAddressChange(o, pin);
    if (!decision.allowed) throw new AppError(422, decision.code, decision.reason);
    const p = await tx.pincode.findUniqueOrThrow({ where: { pincode: addr.pincode } });
    await guardedUpdate(tx, o, {
      addressLine1: addr.address_line1,
      addressLine2: addr.address_line2 ?? null,
      landmark: addr.landmark ?? null,
      pincode: p.pincode,
      city: p.city,
      state: p.state,
    });
    await addNote(tx, o.id, actor, `Delivery address updated (pincode ${p.pincode})`);
    await audit(tx, {
      actor,
      entityType: "order",
      entityId: o.orderNumber,
      action: "ADDRESS_CHANGE",
      oldValue: { addressLine1: o.addressLine1, pincode: o.pincode },
      newValue: { addressLine1: addr.address_line1, pincode: p.pincode },
    });
    return { order_number: o.orderNumber, new_city: p.city, new_pincode: p.pincode, delivery_estimate: deliveryEstimate(p.zone).text };
  });
  await publish({ type: "order:updated", orderId: orderNumber, orderNumber });
  return result;
}

export async function createReturn(orderNumber: string, args: { sku?: string; item_no?: number; reason: string; refund_method?: string }, actor: Actor) {
  const result = await prisma.$transaction(async (tx) => {
    const o = await getOrderByNumber(tx, orderNumber);
    if (!o) throw notFound("Order");
    const { decision, item } = await evaluateReturn(tx, o, { ...args, unused_with_tags: true });
    if (!item || !decision.allowed) throw new AppError(422, decision.code, decision.reason);
    const methods = refundMethodPolicy(o.paymentMethod).methods;
    const method = args.refund_method && methods.includes(args.refund_method) ? args.refund_method : methods[0]!;
    if (o.paymentMethod === "COD" && !args.refund_method) {
      throw new AppError(422, "REFUND_METHOD_REQUIRED", "For COD orders please choose bank transfer or store credit for the refund.");
    }
    const req = await tx.returnRequest.create({
      data: { orderId: o.id, orderItemId: item.id, type: "RETURN", reason: args.reason.slice(0, 300), status: "PICKUP_SCHEDULED" },
    });
    await guardedUpdate(tx, o, {});
    await addNote(tx, o.id, actor, `Return requested for ${item.sku} (${item.size}) — refund via ${method}`);
    await audit(tx, { actor, entityType: "return", entityId: req.id, action: "RETURN_CREATED", newValue: { order: o.orderNumber, sku: item.sku, size: item.size, refundMethod: method } });
    return {
      return_id: req.id.slice(-8).toUpperCase(),
      order_number: o.orderNumber,
      item: `${item.product.name} (${item.size})`,
      status: "PICKUP_SCHEDULED",
      refund_amount: fmtInr(item.unitPrice * item.quantity),
      refund_method: method,
      refund_policy: refundMethodPolicy(o.paymentMethod).text,
    };
  });
  await publish({ type: "order:updated", orderId: orderNumber, orderNumber });
  return result;
}

export async function createExchange(orderNumber: string, args: { sku?: string; item_no?: number; new_size: string; reason: string }, actor: Actor) {
  const result = await prisma.$transaction(async (tx) => {
    const o = await getOrderByNumber(tx, orderNumber);
    if (!o) throw notFound("Order");
    const { decision, item } = await evaluateExchange(tx, o, args);
    if (!item || !decision.allowed) throw new AppError(422, decision.code, decision.reason);
    const newSize = args.new_size.toUpperCase();
    // reserve stock atomically — fails if someone else took the last piece
    const reserved = await tx.productVariant.updateMany({ where: { productId: item.productId, size: newSize, stock: { gt: 0 } }, data: { stock: { decrement: 1 } } });
    if (reserved.count !== 1) throw new AppError(422, "OUT_OF_STOCK", `Size ${newSize} just went out of stock.`);
    const bumped = await tx.orderItem.updateMany({ where: { id: item.id, exchangeCount: item.exchangeCount }, data: { exchangeCount: { increment: 1 } } });
    if (bumped.count !== 1) throw conflict("Item was modified concurrently.");
    const req = await tx.returnRequest.create({
      data: { orderId: o.id, orderItemId: item.id, type: "EXCHANGE", reason: args.reason.slice(0, 300), newSize, status: "PICKUP_SCHEDULED" },
    });
    await guardedUpdate(tx, o, {});
    await addNote(tx, o.id, actor, `Size exchange ${item.size} → ${newSize} for ${item.sku}`);
    await audit(tx, { actor, entityType: "return", entityId: req.id, action: "EXCHANGE_CREATED", oldValue: { size: item.size }, newValue: { order: o.orderNumber, sku: item.sku, newSize } });
    return { exchange_id: req.id.slice(-8).toUpperCase(), order_number: o.orderNumber, item: item.product.name, from_size: item.size, to_size: newSize, status: "PICKUP_SCHEDULED" };
  });
  await publish({ type: "order:updated", orderId: orderNumber, orderNumber });
  return result;
}

/** Customer verification: order number + the phone used on that order. */
export async function verifyOrderPhone(orderNumber: string, phoneInput: string): Promise<{ ok: boolean; customerId?: string }> {
  const phone = normalizePhone(phoneInput);
  if (!phone) return { ok: false };
  const o = await prisma.order.findUnique({ where: { orderNumber }, include: { customer: true } });
  if (!o || o.customer.phone !== phone) return { ok: false };
  return { ok: true, customerId: o.customerId };
}
