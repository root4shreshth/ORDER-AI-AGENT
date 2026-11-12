/**
 * Store "order.created" events → orders. Runs in the worker after the webhook was verified,
 * persisted and de-duplicated. Idempotent on order_number.
 */
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { normalizePhone } from "../../lib/format.js";
import { checkCodEligibility, POLICY, shippingFee } from "../../policies/index.js";
import { audit } from "../audit/audit.js";
import { startCodFlow } from "../cod/service.js";
import { getPincode } from "./service.js";
import { publish } from "../../lib/events.js";

export const OrderWebhookSchema = z.object({
  event_id: z.string().min(6).max(80),
  type: z.literal("order.created"),
  order: z.object({
    order_number: z.string().regex(/^WL\d{4,8}$/).optional(),
    customer: z.object({ name: z.string().min(2).max(80), phone: z.string().min(10).max(16), email: z.string().email().optional() }),
    payment_method: z.enum(["COD", "PREPAID"]),
    items: z.array(z.object({ sku: z.string(), size: z.string(), quantity: z.number().int().min(1).max(10) })).min(1).max(20),
    address: z.object({ line1: z.string().min(3).max(200), line2: z.string().max(200).optional(), landmark: z.string().max(120).optional(), pincode: z.string().regex(/^\d{6}$/) }),
  }),
});
export type OrderWebhook = z.infer<typeof OrderWebhookSchema>;

export async function nextOrderNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ max: number | null }[]>`SELECT MAX(CAST(SUBSTRING("orderNumber" FROM 3) AS INTEGER)) AS max FROM "Order"`;
  return `WL${(rows[0]?.max ?? 10300) + 1}`;
}

export async function ingestOrder(payload: OrderWebhook): Promise<{ orderId: string; orderNumber: string; created: boolean }> {
  const o = payload.order;
  const phone = normalizePhone(o.customer.phone);
  if (!phone) throw new AppError(422, "INVALID_PHONE", "Invalid customer phone");
  const pin = await getPincode(prisma, o.address.pincode);
  if (!pin?.serviceable) throw new AppError(422, "PINCODE_NOT_SERVICEABLE", `Pincode ${o.address.pincode} is not serviceable`);

  if (o.order_number) {
    const existing = await prisma.order.findUnique({ where: { orderNumber: o.order_number } });
    if (existing) {
      if (existing.paymentMethod === "COD") await startCodFlow(existing.id);
      return { orderId: existing.id, orderNumber: existing.orderNumber, created: false };
    }
  }

  const products = await prisma.product.findMany({ where: { sku: { in: o.items.map((i) => i.sku) } } });
  const lines = o.items.map((i) => {
    const p = products.find((x) => x.sku === i.sku);
    if (!p) throw new AppError(422, "UNKNOWN_SKU", `Unknown SKU ${i.sku}`);
    return { ...i, product: p, unitPrice: p.priceInr };
  });
  const itemsTotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const ship = shippingFee(itemsTotal);
  const codFee = o.payment_method === "COD" ? POLICY.COD_FEE : 0;
  const total = itemsTotal + ship + codFee;
  if (o.payment_method === "COD") {
    const d = checkCodEligibility(total, pin);
    if (!d.allowed) throw new AppError(422, d.code, d.reason);
  }

  const orderNumber = o.order_number ?? (await nextOrderNumber());
  const order = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.upsert({ where: { phone }, create: { name: o.customer.name, phone, email: o.customer.email }, update: {} });
    for (const l of lines) {
      const r = await tx.productVariant.updateMany({ where: { productId: l.product.id, size: l.size, stock: { gte: l.quantity } }, data: { stock: { decrement: l.quantity } } });
      if (r.count !== 1) throw new AppError(422, "OUT_OF_STOCK", `${l.sku} size ${l.size} is out of stock`);
    }
    const created = await tx.order.create({
      data: {
        orderNumber,
        customerId: customer.id,
        paymentMethod: o.payment_method,
        status: o.payment_method === "COD" ? "PENDING_CONFIRMATION" : "CONFIRMED",
        itemsTotal,
        shippingFee: ship,
        codFee,
        total,
        addressLine1: o.address.line1,
        addressLine2: o.address.line2,
        landmark: o.address.landmark,
        city: pin.city,
        state: (await tx.pincode.findUniqueOrThrow({ where: { pincode: pin.pincode } })).state,
        pincode: pin.pincode,
        notes: [{ at: new Date().toISOString(), by: "system", text: `Order received via webhook (${payload.event_id})` }],
        items: { create: lines.map((l) => ({ productId: l.product.id, sku: l.sku, size: l.size, quantity: l.quantity, unitPrice: l.unitPrice })) },
      },
    });
    await audit(tx, { actor: "system", entityType: "order", entityId: orderNumber, action: "ORDER_CREATED", newValue: { paymentMethod: o.payment_method, total, pincode: pin.pincode }, meta: { eventId: payload.event_id } });
    return created;
  });

  if (order.paymentMethod === "COD") await startCodFlow(order.id);
  await publish({ type: "order:updated", orderId: order.id, orderNumber });
  return { orderId: order.id, orderNumber, created: true };
}
