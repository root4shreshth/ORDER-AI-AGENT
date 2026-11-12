/**
 * Confirmation protocol for sensitive mutations.
 *   propose_action  → backend re-runs policy, stores a PendingAction bound to {order, item, params}
 *                     and returns a summary the agent must repeat to the customer.
 *   confirm_action  → only executes if: same conversation, still PENDING, proposed in an EARLIER
 *                     turn, not expired, and the customer's latest message is a clear "yes".
 *                     Policy + state are re-checked inside the service transaction.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { fmtDate, fmtInr, normalizeOrderNumber, normalizePhone } from "../../lib/format.js";
import { checkAddressChange, checkCancellation, checkRescheduleDate } from "../../policies/index.js";
import { cancelOrder, changeAddress, createExchange, createReturn, evaluateExchange, evaluateReturn, getOrderByNumber, getPincode, type OrderWithItems } from "../../modules/orders/service.js";
import { addAlternatePhone, requestRto, rescheduleDelivery, updateNdrAddress } from "../../modules/ndr/service.js";
import { respondToCod } from "../../modules/cod/service.js";
import { getSettings } from "../../modules/settings/settings.js";
import { audit } from "../../modules/audit/audit.js";
import { isAffirmative } from "../safety.js";
import type { ToolContext, ToolResult } from "./context.js";

export const ACTIONS = ["cancel_order", "create_return", "create_exchange", "change_address", "ndr_reschedule", "ndr_update_address", "ndr_alternate_phone", "ndr_cancel_rto"] as const;
export type ActionType = (typeof ACTIONS)[number];

export const ProposeSchema = z.object({
  action: z.enum(ACTIONS),
  order_number: z.string().min(3).max(20),
  sku: z.string().max(20).optional().describe("Item SKU for returns/exchanges"),
  item_no: z.number().int().min(1).max(20).optional().describe("1-based item position for returns/exchanges"),
  new_size: z.string().max(5).optional().describe("create_exchange: requested size"),
  reason: z.string().max(300).optional().describe("Customer's reason (return/exchange/cancel/RTO)"),
  unused_with_tags: z.boolean().optional().describe("create_return: customer confirmed unused with tags"),
  refund_method: z.enum(["ORIGINAL_PAYMENT", "BANK_TRANSFER", "STORE_CREDIT"]).optional().describe("create_return on COD orders: BANK_TRANSFER or STORE_CREDIT, as chosen by the customer"),
  address_line1: z.string().max(200).optional().describe("New address incl. house/flat number and street"),
  address_line2: z.string().max(200).optional(),
  landmark: z.string().max(120).optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ndr_reschedule: YYYY-MM-DD"),
  phone: z.string().max(20).optional().describe("ndr_alternate_phone: 10-digit number"),
});
export type ProposeInput = z.infer<typeof ProposeSchema>;

const refuse = (code: string, message: string, data?: unknown): ToolResult => ({ ok: true, code, message, data: { eligible: false, ...((data as object) ?? {}) } });
const missing = (field: string): ToolResult => ({ ok: false, code: "MISSING_FIELD", message: `Ask the customer for: ${field}.` });

async function buildProposal(o: OrderWithItems, input: ProposeInput): Promise<{ summary: string; params: Record<string, unknown> } | ToolResult> {
  const s = await getSettings();
  switch (input.action) {
    case "cancel_order": {
      const d = checkCancellation(o);
      if (!d.allowed) return refuse(d.code, d.reason, d.data);
      const refund = o.paymentMethod === "PREPAID" ? ` The full ${fmtInr(o.total)} will be refunded to the original payment method.` : " Nothing will be charged.";
      return { summary: `Cancel order ${o.orderNumber} (${o.items.map((i) => `${i.product.name} ${i.size}`).join(", ")}).${refund}`, params: { reason: input.reason ?? "Customer request" } };
    }
    case "create_return": {
      if (!input.reason) return missing("the reason for the return");
      if (input.unused_with_tags !== true) return missing("confirmation that the item is unused and has its tags (unused_with_tags=true)");
      const { decision, item } = await evaluateReturn(prisma, o, { sku: input.sku, item_no: input.item_no, unused_with_tags: true });
      if (!decision.allowed || !item) return refuse(decision.code, decision.reason, { requires_manual_review: !!decision.requiresManualReview, ...((decision.data as object) ?? {}) });
      if (o.paymentMethod === "COD" && !input.refund_method) return missing("how they want the refund: bank transfer or store credit");
      const method = o.paymentMethod === "PREPAID" ? "ORIGINAL_PAYMENT" : input.refund_method!;
      const methodText = method === "ORIGINAL_PAYMENT" ? "to the original payment method within 5–7 working days after quality check" : method === "BANK_TRANSFER" ? "by bank transfer after quality check" : "as store credit after quality check";
      return {
        summary: `Create a return for ${item.product.name} (size ${item.size}) from order ${o.orderNumber}. We'll schedule a pickup; refund of ${fmtInr(item.unitPrice * item.quantity)} ${methodText}.`,
        params: { sku: item.sku, reason: input.reason, refund_method: method },
      };
    }
    case "create_exchange": {
      if (!input.new_size) return missing("the size they want");
      const { decision, item } = await evaluateExchange(prisma, o, { sku: input.sku, item_no: input.item_no, new_size: input.new_size });
      if (!decision.allowed || !item) return refuse(decision.code, decision.reason, decision.data);
      return {
        summary: `Exchange ${item.product.name} from size ${item.size} to size ${input.new_size.toUpperCase()} on order ${o.orderNumber}. We'll pick up the current piece and deliver the new size (this uses the item's one allowed exchange).`,
        params: { sku: item.sku, new_size: input.new_size.toUpperCase(), reason: input.reason ?? "Size change" },
      };
    }
    case "change_address": {
      if (!input.address_line1 || !input.pincode) return missing("the full new address with house/flat number and the 6-digit pincode");
      if (!/\d/.test(input.address_line1)) return missing("the house/flat number in the new address");
      const pin = await getPincode(prisma, input.pincode);
      const d = checkAddressChange(o, pin);
      if (!d.allowed) return refuse(d.code, d.reason);
      return {
        summary: `Change the delivery address of order ${o.orderNumber} to: ${input.address_line1}${input.address_line2 ? `, ${input.address_line2}` : ""}${input.landmark ? ` (landmark: ${input.landmark})` : ""}, ${pin!.city} ${pin!.pincode}.`,
        params: { address_line1: input.address_line1, address_line2: input.address_line2, landmark: input.landmark, pincode: input.pincode },
      };
    }
    case "ndr_reschedule": {
      if (!input.date) return missing("the new delivery date (within the next 3 days)");
      const sh = await prisma.shipment.findUnique({ where: { orderId: o.id } });
      if (!sh || sh.status !== "DELIVERY_FAILED") return refuse("NO_ACTIVE_NDR", "There's no failed delivery to reschedule for this order.");
      const d = checkRescheduleDate(input.date, new Date(), s.ndr.rescheduleWindowDays);
      if (!d.allowed) return refuse(d.code, d.reason);
      return { summary: `Ask the courier to re-attempt delivery of order ${o.orderNumber} on ${fmtDate(new Date(`${input.date}T12:00:00+05:30`))}.`, params: { date: input.date } };
    }
    case "ndr_update_address": {
      if (!input.address_line1 && !input.landmark) return missing("the corrected address or a landmark");
      const sh = await prisma.shipment.findUnique({ where: { orderId: o.id } });
      if (!sh || sh.status !== "DELIVERY_FAILED") return refuse("NO_ACTIVE_NDR", "There's no failed delivery to update for this order.");
      if (input.pincode) {
        const pin = await getPincode(prisma, input.pincode);
        if (!pin?.serviceable) return refuse("PINCODE_NOT_SERVICEABLE", `We can't deliver to pincode ${input.pincode}.`);
      }
      return {
        summary: `Update the delivery address for order ${o.orderNumber} to "${input.address_line1 ?? o.addressLine1}"${input.landmark ? ` with landmark "${input.landmark}"` : ""}${input.pincode ? `, pincode ${input.pincode}` : ""} and ask the courier to re-attempt.`,
        params: { address_line1: input.address_line1 ?? o.addressLine1, landmark: input.landmark, pincode: input.pincode },
      };
    }
    case "ndr_alternate_phone": {
      const phone = input.phone ? normalizePhone(input.phone) : null;
      if (!phone) return missing("a valid 10-digit alternate phone number");
      const sh = await prisma.shipment.findUnique({ where: { orderId: o.id } });
      if (!sh || sh.status !== "DELIVERY_FAILED") return refuse("NO_ACTIVE_NDR", "There's no failed delivery to update for this order.");
      return { summary: `Share the alternate number ending ${phone.slice(-4)} with the courier for order ${o.orderNumber}.`, params: { phone } };
    }
    case "ndr_cancel_rto": {
      if (!input.reason) return missing("why they don't want the order any more");
      const sh = await prisma.shipment.findUnique({ where: { orderId: o.id } });
      if (!sh || !["DELIVERY_FAILED", "OUT_FOR_DELIVERY", "IN_TRANSIT"].includes(sh.status)) return refuse("NO_ACTIVE_NDR", "This order can't be returned to origin from its current state.");
      return { summary: `Stop delivery of order ${o.orderNumber} and return it to us (RTO). Reason noted: "${input.reason}".`, params: { reason: input.reason } };
    }
  }
}

export async function proposeAction(ctx: ToolContext, input: ProposeInput): Promise<ToolResult> {
  const orderNumber = normalizeOrderNumber(input.order_number);
  if (!orderNumber || !ctx.conversation.verifiedOrderNumbers.includes(orderNumber)) {
    return { ok: false, code: "NOT_VERIFIED", message: "Verify the customer (order number + phone on the order) before proposing any change." };
  }
  const o = await getOrderByNumber(prisma, orderNumber);
  if (!o) return { ok: false, code: "ORDER_NOT_FOUND", message: "Order not found." };
  const proposal = await buildProposal(o, input);
  if ("ok" in proposal) return proposal;

  const s = await getSettings();
  await prisma.pendingAction.updateMany({ where: { conversationId: ctx.conversationId, status: "PENDING" }, data: { status: "CANCELLED" } });
  const pa = await prisma.pendingAction.create({
    data: {
      conversationId: ctx.conversationId,
      orderId: o.id,
      type: input.action,
      params: proposal.params as Prisma.InputJsonValue,
      summary: proposal.summary,
      turnId: ctx.turnId,
      expiresAt: new Date(Date.now() + s.agent.pendingActionTtlMin * 60_000),
    },
  });
  return {
    ok: true,
    code: "AWAITING_CUSTOMER_CONFIRMATION",
    message: "Repeat this summary to the customer in their language and ask them to reply 'yes' to confirm. Do not call confirm_action until they do.",
    data: { pending_action_id: pa.id, summary: proposal.summary, eligible: true },
  };
}

async function execute(type: ActionType, orderNumber: string, params: Record<string, unknown>) {
  const p = params as Record<string, string | undefined>;
  switch (type) {
    case "cancel_order":
      return cancelOrder(orderNumber, p.reason ?? "Customer request", "ai");
    case "create_return":
      return createReturn(orderNumber, { sku: p.sku, reason: p.reason ?? "Customer request", refund_method: p.refund_method }, "ai");
    case "create_exchange":
      return createExchange(orderNumber, { sku: p.sku, new_size: p.new_size!, reason: p.reason ?? "Size change" }, "ai");
    case "change_address": {
      const r = await changeAddress(orderNumber, { address_line1: p.address_line1!, address_line2: p.address_line2, landmark: p.landmark, pincode: p.pincode! }, "ai");
      // COD "Edit address" flow: the new address + the customer's yes also confirms the COD order.
      const cod = await prisma.codConfirmation.findFirst({ where: { order: { orderNumber }, status: "ADDRESS_EDIT_REQUESTED" } });
      if (cod) {
        const c = await respondToCod(orderNumber, "CONFIRM", "ai");
        return { ...r, cod_status: c.status };
      }
      return r;
    }
    case "ndr_reschedule":
      return rescheduleDelivery(orderNumber, p.date!, "ai");
    case "ndr_update_address":
      return updateNdrAddress(orderNumber, { address_line1: p.address_line1!, landmark: p.landmark, pincode: p.pincode }, "ai");
    case "ndr_alternate_phone":
      return addAlternatePhone(orderNumber, p.phone!, "ai");
    case "ndr_cancel_rto":
      return requestRto(orderNumber, p.reason ?? "Customer declined", "ai");
  }
}

export async function confirmPendingAction(ctx: ToolContext, input: { pending_action_id: string }): Promise<ToolResult> {
  const pa = await prisma.pendingAction.findFirst({ where: { id: input.pending_action_id, conversationId: ctx.conversationId }, include: { order: true } });
  if (!pa) return { ok: false, code: "PENDING_ACTION_NOT_FOUND", message: "No such proposed action in this chat. Propose it first." };
  if (pa.status !== "PENDING") return { ok: false, code: `ACTION_${pa.status}`, message: `This action is already ${pa.status.toLowerCase()}.` };
  if (pa.turnId === ctx.turnId) {
    return { ok: false, code: "CONFIRMATION_REQUIRED", message: "You just proposed this. Show the summary to the customer and wait for their reply before confirming." };
  }
  if (pa.expiresAt < new Date()) {
    await prisma.pendingAction.update({ where: { id: pa.id }, data: { status: "EXPIRED" } });
    return { ok: false, code: "ACTION_EXPIRED", message: "The confirmation window expired. Re-check and propose again." };
  }
  if (!isAffirmative(ctx.customerText)) {
    return { ok: false, code: "NO_CLEAR_YES", message: "The customer's latest message is not a clear yes. Ask them to confirm explicitly (yes / no)." };
  }
  if (!ctx.conversation.verifiedOrderNumbers.includes(pa.order.orderNumber)) return { ok: false, code: "NOT_VERIFIED", message: "Order is not verified in this chat." };

  // claim first: a concurrent second confirm can't execute twice
  const claimed = await prisma.pendingAction.updateMany({ where: { id: pa.id, status: "PENDING" }, data: { status: "EXECUTED" } });
  if (claimed.count !== 1) return { ok: false, code: "ACTION_ALREADY_HANDLED", message: "This action was already handled." };
  try {
    const result = await execute(pa.type as ActionType, pa.order.orderNumber, pa.params as Record<string, unknown>);
    await prisma.pendingAction.update({ where: { id: pa.id }, data: { result: result as unknown as Prisma.InputJsonValue } });
    await audit(prisma, { actor: "ai", entityType: "order", entityId: pa.order.orderNumber, action: `CONFIRMED_${pa.type.toUpperCase()}`, newValue: { summary: pa.summary }, meta: { pendingActionId: pa.id, conversationId: ctx.conversationId } });
    return { ok: true, code: "DONE", message: "Action completed. Tell the customer exactly what the result says.", data: result };
  } catch (e) {
    const code = e instanceof AppError ? e.code : /courier/i.test(String(e)) ? "COURIER_UNAVAILABLE" : "INTERNAL_ERROR";
    const message =
      e instanceof AppError
        ? e.message
        : code === "COURIER_UNAVAILABLE"
          ? "The courier system isn't responding right now, so the update couldn't be sent. Nothing was changed."
          : "The action could not be completed due to a system error. Nothing was changed.";
    await prisma.pendingAction.update({ where: { id: pa.id }, data: { status: "FAILED", result: { code, message } } });
    return { ok: false, code, message };
  }
}

export async function cancelPendingAction(ctx: ToolContext, input: { pending_action_id: string }): Promise<ToolResult> {
  const r = await prisma.pendingAction.updateMany({ where: { id: input.pending_action_id, conversationId: ctx.conversationId, status: "PENDING" }, data: { status: "CANCELLED" } });
  return r.count ? { ok: true, code: "DISCARDED", message: "Proposed action discarded; nothing was changed." } : { ok: false, code: "PENDING_ACTION_NOT_FOUND", message: "Nothing to discard." };
}
