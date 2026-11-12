/**
 * Agent tools. Each tool = Zod schema (validated server-side before running, whatever the
 * model sends) + JSON schema for Claude + handler. Handlers enforce authorization:
 * order data is only returned for order numbers verified IN THIS CONVERSATION.
 * Read tools and mutation tools are separate: mutations only happen through
 * propose_action → (customer says yes in a later turn) → confirm_action.
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { fmtDate, fmtInr, normalizeOrderNumber } from "../../lib/format.js";
import { checkCancellation, checkCodEligibility, deliveryEstimate, POLICY_DOCUMENT, refundMethodPolicy } from "../../policies/index.js";
import { evaluateExchange, evaluateReturn, getOrderByNumber, getPincode, orderView, verifyOrderPhone } from "../../modules/orders/service.js";
import { CATALOG } from "../../modules/catalog/data.js";
import { getSettings } from "../../modules/settings/settings.js";
import { respondToCod } from "../../modules/cod/service.js";
import { AppError } from "../../lib/errors.js";
import { audit } from "../../modules/audit/audit.js";
import { HANDOVER_REASONS } from "../../modules/tickets/service.js";
import type { ToolContext, ToolResult } from "./context.js";
import { cancelPendingAction, confirmPendingAction, proposeAction, ProposeSchema } from "./actions.js";

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  handler: (ctx: ToolContext, input: z.infer<S>) => Promise<ToolResult>;
}

const define = <S extends z.ZodType>(t: ToolDef<S>) => t;

const OrderNo = z.string().min(3).max(20).describe("Order number, e.g. WL10234");

/** Authorization gate for every order-specific tool. */
export function requireVerified(ctx: ToolContext, orderInput: string): { orderNumber: string } | ToolResult {
  const orderNumber = normalizeOrderNumber(orderInput);
  if (!orderNumber) return { ok: false, code: "INVALID_ORDER_NUMBER", message: "That doesn't look like a valid order number (format WL12345)." };
  if (!ctx.conversation.verifiedOrderNumbers.includes(orderNumber)) {
    return {
      ok: false,
      code: "NOT_VERIFIED",
      message: "This order is not verified in this chat. Ask the customer for the order number AND the phone number used on that order, then call verify_customer. Share nothing about the order until then.",
    };
  }
  return { orderNumber };
}
const isResult = (x: unknown): x is ToolResult => typeof x === "object" && x !== null && "ok" in x;

async function loadVerifiedOrder(ctx: ToolContext, orderInput: string) {
  const gate = requireVerified(ctx, orderInput);
  if (isResult(gate)) return gate;
  const o = await getOrderByNumber(prisma, gate.orderNumber);
  if (!o) return { ok: false, code: "ORDER_NOT_FOUND", message: "Order not found." } satisfies ToolResult;
  return o;
}

export const TOOLS = [
  define({
    name: "verify_customer",
    description:
      "Verify the customer for ONE order using the order number and the phone number used on that order. Required before ANY order-specific information is shared or any order action is taken. Never guess or reuse numbers from other messages that the customer didn't give for this purpose.",
    schema: z.object({ order_number: OrderNo, phone: z.string().min(6).max(20).describe("10-digit mobile number given by the customer") }),
    handler: async (ctx, input) => {
      const s = await getSettings();
      const conv = ctx.conversation;
      if (conv.failedVerifyCount >= s.handover.maxFailedVerifications) {
        return { ok: false, code: "VERIFICATION_LOCKED", message: "Too many failed verification attempts. Hand the chat over to a human (reason VERIFICATION_FAILED)." };
      }
      const orderNumber = normalizeOrderNumber(input.order_number);
      const res = orderNumber ? await verifyOrderPhone(orderNumber, input.phone) : { ok: false };
      if (!res.ok || !orderNumber) {
        const updated = await prisma.conversation.update({ where: { id: conv.id }, data: { failedVerifyCount: { increment: 1 } } });
        ctx.conversation = updated;
        await audit(prisma, { actor: "ai", entityType: "conversation", entityId: conv.id, action: "VERIFY_FAILED", meta: { attempts: updated.failedVerifyCount } });
        const locked = updated.failedVerifyCount >= s.handover.maxFailedVerifications;
        return {
          ok: false,
          code: locked ? "VERIFICATION_LOCKED" : "VERIFICATION_FAILED",
          message: locked
            ? "Verification failed too many times. Do not share any order details; hand over to a human (reason VERIFICATION_FAILED)."
            : "The order number and phone number don't match our records. Share NOTHING about any order; ask the customer to re-check both and try again.",
          data: { attempts_left: Math.max(0, s.handover.maxFailedVerifications - updated.failedVerifyCount) },
        };
      }
      const verified = Array.from(new Set([...conv.verifiedOrderNumbers, orderNumber]));
      ctx.conversation = await prisma.conversation.update({
        where: { id: conv.id },
        data: { verifiedOrderNumbers: verified, customerId: res.customerId, verifiedAt: new Date(), failedVerifyCount: 0, context: { ...(conv.context as object), orderNumber } },
      });
      return { ok: true, code: "VERIFIED", message: `Customer verified for order ${orderNumber}.`, data: { order_number: orderNumber } };
    },
  }),

  define({
    name: "get_order_details",
    description: "Get items, amounts, payment method and status of a VERIFIED order.",
    schema: z.object({ order_number: OrderNo }),
    handler: async (ctx, input) => {
      const o = await loadVerifiedOrder(ctx, input.order_number);
      if (isResult(o)) return o;
      return { ok: true, data: orderView(o) };
    },
  }),

  define({
    name: "get_shipment_status",
    description: "Live courier status, tracking link, delivery estimate and recent timeline of a VERIFIED order.",
    schema: z.object({ order_number: OrderNo }),
    handler: async (ctx, input) => {
      const o = await loadVerifiedOrder(ctx, input.order_number);
      if (isResult(o)) return o;
      const shipment = await prisma.shipment.findUnique({ where: { orderId: o.id }, include: { events: { orderBy: { occurredAt: "desc" }, take: 6 } } });
      const pin = await getPincode(prisma, o.pincode);
      if (!shipment) {
        return {
          ok: true,
          data: {
            order_number: o.orderNumber,
            order_status: o.status,
            shipped: false,
            note: o.status === "PENDING_CONFIRMATION" ? "Awaiting COD confirmation before dispatch." : o.status === "ON_HOLD" ? "On hold — COD not confirmed." : o.status === "CANCELLED" ? "Order cancelled." : "Not shipped yet.",
            delivery_estimate_after_dispatch: pin ? deliveryEstimate(pin.zone).text : null,
          },
        };
      }
      return {
        ok: true,
        data: {
          order_number: o.orderNumber,
          order_status: o.status,
          courier: shipment.courier,
          awb: shipment.awb,
          tracking_link: `${env.WEB_URL}/track/${shipment.awb}`,
          courier_status: shipment.status,
          expected_delivery: fmtDate(shipment.rescheduledFor ?? shipment.expectedDeliveryAt),
          delivered_on: fmtDate(o.deliveredAt),
          failed_attempts: shipment.attemptCount,
          last_failure_reason: shipment.lastFailureReason,
          timeline: shipment.events.map((e) => ({ status: e.type, at: fmtDate(e.occurredAt), reason: e.reason, location: e.location })),
        },
      };
    },
  }),

  define({
    name: "get_refund_status",
    description: "Read the refund record(s) of a VERIFIED order. Only state dates that this tool returns.",
    schema: z.object({ order_number: OrderNo }),
    handler: async (ctx, input) => {
      const o = await loadVerifiedOrder(ctx, input.order_number);
      if (isResult(o)) return o;
      const refunds = await prisma.refund.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "desc" } });
      const returns = await prisma.returnRequest.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "desc" } });
      return {
        ok: true,
        data: {
          order_number: o.orderNumber,
          refunds: refunds.map((r) => ({ amount: fmtInr(r.amount), method: r.method, status: r.status, quality_check_passed_on: fmtDate(r.qcPassedAt), expected_by: fmtDate(r.expectedBy), completed_on: fmtDate(r.completedAt) })),
          return_requests: returns.map((r) => ({ type: r.type, status: r.status, requested_on: fmtDate(r.createdAt), new_size: r.newSize })),
          refund_policy: refundMethodPolicy(o.paymentMethod).text,
          note: refunds.length === 0 ? "No refund record exists for this order." : undefined,
        },
      };
    },
  }),

  define({
    name: "check_return_eligibility",
    description:
      "Run the store's return policy for an item of a VERIFIED order. Ask the customer whether the item is unused with tags before calling. The result is final — never override it.",
    schema: z.object({
      order_number: OrderNo,
      sku: z.string().max(20).optional().describe("SKU of the item, e.g. WL-KUR-01"),
      item_no: z.number().int().min(1).max(20).optional().describe("1-based item position from get_order_details"),
      unused_with_tags: z.boolean().describe("Customer confirmed the item is unused and has its tags"),
    }),
    handler: async (ctx, input) => {
      const o = await loadVerifiedOrder(ctx, input.order_number);
      if (isResult(o)) return o;
      const { decision, item } = await evaluateReturn(prisma, o, input);
      return { ok: true, code: decision.code, message: decision.reason, data: { eligible: decision.allowed, requires_manual_review: !!decision.requiresManualReview, item: item ? `${item.product.name} (${item.size})` : null, ...((decision.data as object) ?? {}) } };
    },
  }),

  define({
    name: "check_exchange_eligibility",
    description: "Run the size-exchange policy (window, one exchange per item, live stock of the new size) for an item of a VERIFIED order.",
    schema: z.object({
      order_number: OrderNo,
      sku: z.string().max(20).optional(),
      item_no: z.number().int().min(1).max(20).optional(),
      new_size: z.string().min(1).max(5).describe("Requested size, e.g. L or 32"),
    }),
    handler: async (ctx, input) => {
      const o = await loadVerifiedOrder(ctx, input.order_number);
      if (isResult(o)) return o;
      const { decision, item } = await evaluateExchange(prisma, o, input);
      return { ok: true, code: decision.code, message: decision.reason, data: { eligible: decision.allowed, item: item ? `${item.product.name} (${item.size})` : null, ...((decision.data as object) ?? {}) } };
    },
  }),

  define({
    name: "check_cancellation_eligibility",
    description: "Check whether a VERIFIED order can be cancelled (free before shipping) and what the options are otherwise.",
    schema: z.object({ order_number: OrderNo }),
    handler: async (ctx, input) => {
      const o = await loadVerifiedOrder(ctx, input.order_number);
      if (isResult(o)) return o;
      const d = checkCancellation(o);
      return { ok: true, code: d.code, message: d.reason, data: { cancellable: d.allowed, order_status: o.status, ...((d.data as object) ?? {}) } };
    },
  }),

  define({
    name: "check_pincode",
    description: "Check delivery serviceability, COD availability and delivery time for a 6-digit pincode (public info, no verification needed).",
    schema: z.object({ pincode: z.string().regex(/^\d{6}$/), order_value_inr: z.number().min(0).max(1_000_000).optional() }),
    handler: async (_ctx, input) => {
      const pin = await getPincode(prisma, input.pincode);
      if (!pin) return { ok: true, code: "PINCODE_UNKNOWN", message: `Pincode ${input.pincode} is not in our delivery network yet, so we can't deliver there.`, data: { serviceable: false, cod_available: false } };
      const cod = checkCodEligibility(Math.round((input.order_value_inr ?? 1000) * 100), pin);
      return {
        ok: true,
        code: cod.code,
        message: cod.reason,
        data: { pincode: pin.pincode, city: pin.city, serviceable: pin.serviceable, cod_available: pin.serviceable && pin.codAvailable, delivery_estimate: pin.serviceable ? deliveryEstimate(pin.zone).text : null, prepaid_available: pin.serviceable },
      };
    },
  }),

  define({
    name: "get_product_info",
    description: "Catalogue lookup: products, prices, return rules and size charts. Use for size help — answer ONLY from the size chart returned.",
    schema: z.object({ query: z.string().max(80).optional().describe("Product name or SKU; omit for the whole catalogue") }),
    handler: async (_ctx, input) => {
      const q = input.query?.toLowerCase().trim();
      const match = q ? CATALOG.filter((p) => p.sku.toLowerCase() === q || p.name.toLowerCase().includes(q) || q.includes(p.category) || p.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && q.includes(w))) : CATALOG;
      const list = match.length ? match : CATALOG;
      const products = await prisma.product.findMany({ where: { sku: { in: list.map((p) => p.sku) } }, include: { variants: true } });
      return {
        ok: true,
        data: products.map((p) => ({
          sku: p.sku,
          name: p.name,
          price: fmtInr(p.priceInr),
          return_rule: p.notes,
          sizes: p.variants.map((v) => ({ size: v.size, in_stock: v.stock > 0 })),
          size_chart: p.sizeChart,
        })),
      };
    },
  }),

  define({
    name: "check_stock",
    description: "Live stock for a product size (public info).",
    schema: z.object({ sku: z.string().min(3).max(20), size: z.string().min(1).max(5) }),
    handler: async (_ctx, input) => {
      const v = await prisma.productVariant.findFirst({ where: { product: { sku: input.sku.toUpperCase() }, size: input.size.toUpperCase() } });
      if (!v) return { ok: true, code: "SIZE_NOT_OFFERED", message: `Size ${input.size} isn't offered for ${input.sku}.`, data: { in_stock: false } };
      return { ok: true, code: v.stock > 0 ? "IN_STOCK" : "OUT_OF_STOCK", data: { sku: input.sku.toUpperCase(), size: v.size, in_stock: v.stock > 0, low_stock: v.stock > 0 && v.stock <= 3 } };
    },
  }),

  define({
    name: "get_policy_info",
    description: "Official store policy text. Answer policy questions only from this.",
    schema: z.object({ topic: z.enum(["returns", "exchange", "cancellation", "refunds", "cod", "shipping", "manual_review", "all"]) }),
    handler: async (_ctx, input) => ({ ok: true, data: input.topic === "all" ? POLICY_DOCUMENT : { [input.topic]: POLICY_DOCUMENT[input.topic] } }),
  }),

  define({
    name: "respond_cod_confirmation",
    description:
      "Record the customer's answer to a COD confirmation request for a VERIFIED order: CONFIRM (ship it), PAY_ONLINE (switch to prepaid with 5% off), or EDIT_ADDRESS (customer wants to change address — then collect it and use propose_action change_address). For cancelling use propose_action cancel_order.",
    schema: z.object({ order_number: OrderNo, choice: z.enum(["CONFIRM", "PAY_ONLINE", "EDIT_ADDRESS"]) }),
    handler: async (ctx, input) => {
      const gate = requireVerified(ctx, input.order_number);
      if (isResult(gate)) return gate;
      try {
        const r = await respondToCod(gate.orderNumber, input.choice, "ai");
        return { ok: true, code: `COD_${r.status}`, message: r.message, data: { status: r.status, payment_link: r.paymentLink } };
      } catch (e) {
        if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    },
  }),

  define({
    name: "propose_action",
    description:
      "Prepare a change that needs the customer's explicit yes: cancel_order, create_return, create_exchange, change_address (before dispatch / COD address edit), ndr_reschedule (new delivery date within 3 days, YYYY-MM-DD), ndr_update_address, ndr_alternate_phone, ndr_cancel_rto (customer no longer wants a failed-delivery order). The backend re-checks policy and returns a summary; repeat that summary to the customer and ask them to confirm. Nothing changes until confirm_action is called in a LATER turn after the customer says yes.",
    schema: ProposeSchema,
    handler: proposeAction,
  }),

  define({
    name: "confirm_action",
    description: "Execute a previously proposed action, ONLY after the customer clearly said yes to its summary in their latest message.",
    schema: z.object({ pending_action_id: z.string().min(5).max(40) }),
    handler: confirmPendingAction,
  }),

  define({
    name: "cancel_action",
    description: "Discard a proposed action when the customer says no or changes their mind.",
    schema: z.object({ pending_action_id: z.string().min(5).max(40) }),
    handler: cancelPendingAction,
  }),

  define({
    name: "handover_to_human",
    description:
      "Hand the chat to the human support team. Use when: the customer asks for a person, is clearly upset, mentions consumer court/legal action/posting online; a refund or goodwill request is above ₹1,500 or a tool says manual review is required; damage claim without a photo; the same issue failed twice or tools keep failing; you are unsure what the customer wants; bulk orders. After calling it, stop — the customer is told someone will join.",
    schema: z.object({
      reason: z.enum(HANDOVER_REASONS),
      mood: z.enum(["calm", "neutral", "confused", "frustrated", "angry", "anxious"]),
      summary: z.string().min(10).max(500).describe("2–3 line summary for the support agent: what the customer wants, what was checked, what's blocking"),
      suggested_reply: z.string().min(10).max(800).describe("A reply the support agent can edit and send, in the customer's language"),
      order_number: z.string().max(20).optional(),
    }),
    handler: async (ctx, input) => {
      const orderNumber = input.order_number ? normalizeOrderNumber(input.order_number) : null;
      ctx.handover = {
        reason: input.reason,
        mood: input.mood,
        summary: input.summary,
        suggestedReply: input.suggested_reply,
        orderNumber: orderNumber && ctx.conversation.verifiedOrderNumbers.includes(orderNumber) ? orderNumber : null,
      };
      return { ok: true, code: "HANDOVER_SCHEDULED", message: "Handover will be created; stop replying." };
    },
  }),
];

export type ToolName = (typeof TOOLS)[number]["name"];
export const TOOL_MAP = new Map<string, ToolDef<z.ZodType>>(TOOLS.map((t) => [t.name, t as unknown as ToolDef<z.ZodType>]));

/** JSON schemas for the Claude API (generated from the Zod schemas — single source of truth). */
export function claudeToolDefinitions(): Anthropic.Tool[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Tool.InputSchema };
  });
}
