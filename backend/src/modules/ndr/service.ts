/**
 * Failed-delivery (NDR) workflow:
 *  courier webhook → dedupe by event id → timeline + shipment state → (failed) customer outreach
 *  → capture new date (≤3 days) / address / alternate phone / RTO → courier API + order note
 *  → if attempts ≥ 2 and no customer response → human handover.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError, notFound } from "../../lib/errors.js";
import { fmtDate, isoDateIST, normalizePhone, addDays } from "../../lib/format.js";
import { checkRescheduleDate } from "../../policies/index.js";
import { getSettings } from "../settings/settings.js";
import { audit, type Actor } from "../audit/audit.js";
import { addNote, getPincode } from "../orders/service.js";
import { enqueue } from "../../jobs/queues.js";
import { getOrCreateOrderConversation, sendAutomatedMessage } from "../conversations/service.js";
import { createHandover } from "../tickets/service.js";
import { publish } from "../../lib/events.js";
import { sendCourierInstruction, toCourierStatus, type CourierWebhookPayload } from "../../courier/mockCourier.js";

export const NDR_QUICK_REPLIES = [
  { id: "NDR_RESCHEDULE", label: "📅 Deliver on another day" },
  { id: "NDR_ADDRESS", label: "📍 Correct address / landmark" },
  { id: "NDR_PHONE", label: "📞 Give another phone number" },
  { id: "NDR_CANCEL", label: "🚫 I don't want the order" },
];

export async function processCourierEvent(p: CourierWebhookPayload): Promise<{ duplicate: boolean; shipmentId?: string }> {
  const shipment = await prisma.shipment.findUnique({ where: { awb: p.awb }, include: { order: true } });
  if (!shipment) throw notFound(`Shipment ${p.awb}`);
  const type = toCourierStatus(p.status);
  const occurredAt = new Date(p.occurred_at);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.shipmentEvent.create({ data: { shipmentId: shipment.id, externalEventId: p.event_id, type, reason: p.reason, location: p.location, occurredAt } });
      const order = shipment.order;
      switch (type) {
        case "PICKED_UP":
        case "IN_TRANSIT":
        case "OUT_FOR_DELIVERY":
          await tx.shipment.update({ where: { id: shipment.id }, data: { status: type } });
          if (order.status === "CONFIRMED") await tx.order.update({ where: { id: order.id }, data: { status: "SHIPPED", shippedAt: order.shippedAt ?? occurredAt, version: { increment: 1 } } });
          break;
        case "DELIVERY_FAILED":
          await tx.shipment.update({
            where: { id: shipment.id },
            data: { status: type, attemptCount: { increment: 1 }, lastFailureReason: p.reason ?? "Not specified", ndrOpen: true, ndrRespondedAt: null },
          });
          await addNote(tx, order.id, "courier", `Delivery attempt failed: ${p.reason ?? "no reason given"}`);
          break;
        case "DELIVERED":
          await tx.shipment.update({ where: { id: shipment.id }, data: { status: type, ndrOpen: false, expectedDeliveryAt: null } });
          await tx.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: occurredAt, version: { increment: 1 } } });
          break;
        case "RTO_INITIATED":
          await tx.shipment.update({ where: { id: shipment.id }, data: { status: type, ndrOpen: false } });
          await tx.order.update({ where: { id: order.id }, data: { status: "RTO_INITIATED", rtoReason: order.rtoReason ?? p.reason ?? "Courier initiated RTO", version: { increment: 1 } } });
          break;
        default:
          break;
      }
      await audit(tx, { actor: "courier", entityType: "shipment", entityId: shipment.awb, action: `COURIER_${type}`, oldValue: { status: shipment.status }, newValue: { status: type, reason: p.reason }, meta: { eventId: p.event_id, order: order.orderNumber } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { duplicate: true, shipmentId: shipment.id };
    throw e;
  }

  if (type === "DELIVERY_FAILED") {
    const s = await getSettings();
    const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    await enqueue({ name: "ndr-outreach", shipmentId: shipment.id, eventId: p.event_id }, `ndr-outreach-${p.event_id}`, { delay: s.ndr.outreachDelaySec * 1000 });
    await enqueue(
      { name: "ndr-no-response", shipmentId: shipment.id, attempt: fresh.attemptCount },
      `ndr-noresp-${shipment.id}-${fresh.attemptCount}`,
      { delay: (s.ndr.outreachDelaySec + s.ndr.noResponseDelaySec) * 1000 },
    );
  }
  await publish({ type: "order:updated", orderId: shipment.orderId, orderNumber: shipment.order.orderNumber });
  return { duplicate: false, shipmentId: shipment.id };
}

export async function sendNdrOutreach(shipmentId: string, eventId: string): Promise<"sent" | "skipped"> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, include: { order: { include: { customer: true } } } });
  if (!shipment || shipment.status !== "DELIVERY_FAILED" || !shipment.ndrOpen) return "skipped";
  // exactly-once per courier event (BullMQ jobId already dedupes; this guards manual retries)
  const already = await prisma.auditLog.findFirst({ where: { entityType: "shipment", entityId: shipment.awb, action: "NDR_OUTREACH_SENT", meta: { path: ["eventId"], equals: eventId } } });
  if (already) return "skipped";
  const s = await getSettings();
  const conv = await getOrCreateOrderConversation(shipment.orderId, "NDR");
  const o = shipment.order;
  const lastDay = fmtDate(addDays(new Date(), s.ndr.rescheduleWindowDays));
  const text =
    `Hi ${o.customer.name.split(" ")[0]}, our courier couldn't deliver your order ${o.orderNumber} today (attempt ${shipment.attemptCount}).\n` +
    `Courier's reason: "${shipment.lastFailureReason ?? "not specified"}".\n\n` +
    `How should we deliver it? You can pick a new delivery date (up to ${lastDay}), correct the address or add a landmark, give another phone number, or tell us if you no longer want the order.`;
  await sendAutomatedMessage(conv.id, text, { quickReplies: NDR_QUICK_REPLIES, orderNumber: o.orderNumber, kind: "NDR_OUTREACH" } as Prisma.InputJsonValue);
  await audit(prisma, { actor: "system", entityType: "shipment", entityId: shipment.awb, action: "NDR_OUTREACH_SENT", meta: { eventId, attempt: shipment.attemptCount, conversationId: conv.id } });
  return "sent";
}

export async function checkNdrNoResponse(shipmentId: string, attempt: number): Promise<"handover" | "skipped"> {
  const s = await getSettings();
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, include: { order: true } });
  if (!shipment || !shipment.ndrOpen || shipment.ndrRespondedAt || shipment.attemptCount !== attempt) return "skipped";
  if (attempt < s.ndr.attemptsBeforeHandover) return "skipped";
  const conv = await getOrCreateOrderConversation(shipment.orderId, "NDR");
  await createHandover(conv.id, {
    reason: "NDR_NO_RESPONSE",
    mood: "unresponsive",
    summary: `Delivery for ${shipment.order.orderNumber} has failed ${attempt} times (last reason: "${shipment.lastFailureReason ?? "n/a"}"). The customer did not respond to the automated follow-up. Please call the customer before the courier marks it RTO.`,
    suggestedReply: `Hi, this is the Wishluck support team. Our courier has tried to deliver your order ${shipment.order.orderNumber} ${attempt} times. Could you share a convenient date or an alternate number so we can get it to you?`,
    orderNumber: shipment.order.orderNumber,
    actor: "system",
    notifyCustomer: false,
  });
  return "handover";
}

// ---------------------------------------------------------------- customer NDR actions (after confirmation)
async function loadOpenNdr(orderNumber: string) {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: { shipment: true } });
  if (!order?.shipment) throw notFound("Shipment");
  const sh = order.shipment;
  if (sh.status === "RTO_INITIATED" || order.status === "RTO_INITIATED") throw new AppError(409, "ALREADY_RTO", "This shipment is already being returned to us, so delivery details can't be changed now.");
  if (sh.status === "DELIVERED") throw new AppError(409, "ALREADY_DELIVERED", "This order has already been delivered.");
  if (sh.status !== "DELIVERY_FAILED" && sh.status !== "OUT_FOR_DELIVERY" && sh.status !== "IN_TRANSIT") {
    throw new AppError(409, "NO_ACTIVE_NDR", "There is no failed delivery to update for this order.");
  }
  return { order, shipment: sh };
}

async function finishNdrUpdate(orderNumber: string, actor: Actor, data: Prisma.ShipmentUpdateInput, note: string, action: string, value: unknown) {
  const { order, shipment } = await loadOpenNdr(orderNumber);
  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({ where: { id: shipment.id }, data: { ...data, ndrOpen: false, ndrRespondedAt: new Date() } });
    await addNote(tx, order.id, actor, note);
    await audit(tx, { actor, entityType: "shipment", entityId: shipment.awb, action, newValue: value, meta: { order: orderNumber } });
  });
  await publish({ type: "order:updated", orderId: order.id, orderNumber });
}

export async function rescheduleDelivery(orderNumber: string, date: string, actor: Actor) {
  const { shipment } = await loadOpenNdr(orderNumber);
  const s = await getSettings();
  const d = checkRescheduleDate(date, new Date(), s.ndr.rescheduleWindowDays);
  if (!d.allowed) throw new AppError(422, d.code, d.reason);
  const { reference } = await sendCourierInstruction(shipment.awb, { type: "RESCHEDULE", date });
  await finishNdrUpdate(orderNumber, actor, { rescheduledFor: new Date(`${date}T10:00:00+05:30`), expectedDeliveryAt: new Date(`${date}T18:00:00+05:30`) }, `NDR: re-delivery scheduled for ${date} (courier ref ${reference})`, "NDR_RESCHEDULED", { date, reference });
  return { order_number: orderNumber, new_delivery_date: fmtDate(new Date(`${date}T12:00:00+05:30`)), courier_reference: reference };
}

export async function updateNdrAddress(orderNumber: string, addr: { address_line1: string; landmark?: string; pincode?: string }, actor: Actor) {
  const { order, shipment } = await loadOpenNdr(orderNumber);
  const pincode = addr.pincode ?? order.pincode;
  const pin = await getPincode(prisma, pincode);
  if (!pin?.serviceable) throw new AppError(422, "PINCODE_NOT_SERVICEABLE", `We can't deliver to pincode ${pincode}.`);
  if (pincode !== order.pincode && order.paymentMethod === "COD" && !pin.codAvailable) throw new AppError(422, "COD_NOT_AVAILABLE_NEW_PINCODE", "COD isn't available at the new pincode.");
  const { reference } = await sendCourierInstruction(shipment.awb, { type: "ADDRESS_UPDATE", address_line1: addr.address_line1, landmark: addr.landmark, pincode });
  await prisma.order.update({ where: { id: order.id }, data: { addressLine1: addr.address_line1, landmark: addr.landmark ?? order.landmark, pincode, city: pin.city, version: { increment: 1 } } });
  await finishNdrUpdate(orderNumber, actor, { deliveryNote: addr.landmark ? `Landmark: ${addr.landmark}` : null }, `NDR: address corrected (courier ref ${reference})`, "NDR_ADDRESS_UPDATED", { address_line1: addr.address_line1, landmark: addr.landmark, pincode, reference });
  return { order_number: orderNumber, address_updated: true, courier_reference: reference };
}

export async function addAlternatePhone(orderNumber: string, phoneInput: string, actor: Actor) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new AppError(422, "INVALID_PHONE", "Please share a valid 10-digit mobile number.");
  const { shipment } = await loadOpenNdr(orderNumber);
  const { reference } = await sendCourierInstruction(shipment.awb, { type: "ALTERNATE_PHONE", phone });
  await finishNdrUpdate(orderNumber, actor, { alternatePhone: phone }, `NDR: alternate phone added (courier ref ${reference})`, "NDR_ALT_PHONE", { phone, reference });
  return { order_number: orderNumber, alternate_phone_added: true, courier_reference: reference };
}

export async function requestRto(orderNumber: string, reason: string, actor: Actor) {
  const { order, shipment } = await loadOpenNdr(orderNumber);
  const { reference } = await sendCourierInstruction(shipment.awb, { type: "RTO", reason });
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: "RTO_INITIATED", rtoReason: reason.slice(0, 300), version: { increment: 1 } } });
    await tx.shipment.update({ where: { id: shipment.id }, data: { status: "RTO_INITIATED", ndrOpen: false, ndrRespondedAt: new Date() } });
    await addNote(tx, order.id, actor, `Customer declined the order — marked for RTO. Reason: ${reason} (courier ref ${reference})`);
    await audit(tx, { actor, entityType: "order", entityId: orderNumber, action: "MARKED_RTO", oldValue: { status: order.status }, newValue: { status: "RTO_INITIATED", reason } });
  });
  await publish({ type: "order:updated", orderId: order.id, orderNumber });
  return { order_number: orderNumber, status: "RTO_INITIATED", courier_reference: reference };
}

export const todayIST = (): string => isoDateIST(new Date());
