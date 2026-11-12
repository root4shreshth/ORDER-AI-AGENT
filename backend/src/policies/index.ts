/**
 * Deterministic store policy (Appendix A). Pure functions — the LLM never decides
 * eligibility; it only explains the decision these functions return.
 */
import type { OrderStatus, PaymentMethod, ReturnClass, Zone } from "@prisma/client";
import { DAY_MS, fmtInr, isoDateIST } from "../lib/format.js";

export interface Decision<T = Record<string, unknown>> {
  allowed: boolean;
  code: string;
  reason: string;
  requiresManualReview?: boolean;
  data?: T;
}

// ---------------------------------------------------------------- constants
export const POLICY = {
  RETURN_WINDOW_DAYS: 7,
  EXCHANGE_WINDOW_DAYS: 7,
  MAX_EXCHANGES_PER_ITEM: 1,
  POST_SHIP_REFUSAL_DEDUCTION: 99_00,
  COD_MIN: 299_00,
  COD_MAX: 4_999_00,
  COD_FEE: 49_00,
  PREPAID_DISCOUNT_PCT: 5,
  FREE_SHIPPING_ABOVE: 999_00,
  SHIPPING_FEE: 79_00,
  MANUAL_REVIEW_REFUND_ABOVE: 1_500_00,
  MANUAL_REVIEW_RETURNS_IN_60_DAYS: 3,
} as const;

/** Orders above this many units are bulk/wholesale enquiries → handled by a person. */
export const BULK_ORDER_UNITS = 10;

export function checkOrderQuantity(items: { quantity: number }[]): Decision {
  const units = items.reduce((s, i) => s + i.quantity, 0);
  if (units > BULK_ORDER_UNITS) {
    return { allowed: false, code: "BULK_ORDER", reason: `Orders of more than ${BULK_ORDER_UNITS} pieces are handled by our team as bulk orders.`, requiresManualReview: true };
  }
  return { allowed: true, code: "QUANTITY_OK", reason: "Quantity is fine." };
}

export const ETA_DAYS: Record<Zone, [number, number]> = {
  METRO: [2, 4],
  REST: [4, 7],
  NE_JK: [6, 9],
};

const PRE_DISPATCH: OrderStatus[] = ["PENDING_CONFIRMATION", "ON_HOLD", "CONFIRMED"];
export const isPreDispatch = (s: OrderStatus): boolean => PRE_DISPATCH.includes(s);

// ---------------------------------------------------------------- shipping
export function shippingFee(itemsTotal: number): number {
  return itemsTotal > POLICY.FREE_SHIPPING_ABOVE ? 0 : POLICY.SHIPPING_FEE;
}

export function deliveryEstimate(zone: Zone): { minDays: number; maxDays: number; text: string } {
  const [minDays, maxDays] = ETA_DAYS[zone];
  const label = zone === "METRO" ? "metro cities" : zone === "NE_JK" ? "North East and J&K" : "rest of India";
  return { minDays, maxDays, text: `${minDays}–${maxDays} days for ${label}` };
}

// ---------------------------------------------------------------- COD
export interface PincodeInfo {
  pincode: string;
  serviceable: boolean;
  codAvailable: boolean;
  zone: Zone;
  city: string;
}

export function checkCodEligibility(orderTotal: number, pin: PincodeInfo | null): Decision {
  if (!pin || !pin.serviceable) {
    return { allowed: false, code: "PINCODE_NOT_SERVICEABLE", reason: "We don't deliver to this pincode yet." };
  }
  if (!pin.codAvailable) {
    return {
      allowed: false,
      code: "COD_NOT_AVAILABLE_PINCODE",
      reason: `Cash on Delivery is not available for pincode ${pin.pincode} (${pin.city}). Prepaid delivery is available (${deliveryEstimate(pin.zone).text}).`,
      data: { prepaidAvailable: true },
    };
  }
  if (orderTotal < POLICY.COD_MIN || orderTotal > POLICY.COD_MAX) {
    return {
      allowed: false,
      code: "COD_AMOUNT_OUT_OF_RANGE",
      reason: `COD is available only for orders between ${fmtInr(POLICY.COD_MIN)} and ${fmtInr(POLICY.COD_MAX)}.`,
    };
  }
  return {
    allowed: true,
    code: "COD_ALLOWED",
    reason: `COD is available, with a ${fmtInr(POLICY.COD_FEE)} COD fee.`,
    data: { codFee: POLICY.COD_FEE },
  };
}

/** Totals when a COD order switches to prepaid: COD fee removed, 5% off the item value. */
export function prepaidConversion(
  order: { itemsTotal: number; shippingFee: number },
  discountPct: number = POLICY.PREPAID_DISCOUNT_PCT,
): { discount: number; newTotal: number } {
  const discount = Math.round((order.itemsTotal * discountPct) / 100);
  return { discount, newTotal: order.itemsTotal + order.shippingFee - discount };
}

// ---------------------------------------------------------------- cancellation
export function checkCancellation(order: { status: OrderStatus; paymentMethod: PaymentMethod; total: number }): Decision {
  if (order.status === "CANCELLED") return { allowed: false, code: "ALREADY_CANCELLED", reason: "This order is already cancelled." };
  if (isPreDispatch(order.status)) {
    return {
      allowed: true,
      code: "CANCEL_FREE",
      reason:
        order.paymentMethod === "PREPAID"
          ? `The order hasn't shipped, so it can be cancelled free. The full ${fmtInr(order.total)} goes back to the original payment method.`
          : "The order hasn't shipped, so it can be cancelled free of charge.",
      data: { refundAmount: order.paymentMethod === "PREPAID" ? order.total : 0 },
    };
  }
  if (order.status === "SHIPPED") {
    const refundOnRefusal = order.paymentMethod === "PREPAID" ? order.total - POLICY.POST_SHIP_REFUSAL_DEDUCTION : 0;
    return {
      allowed: false,
      code: "ALREADY_SHIPPED",
      reason:
        order.paymentMethod === "PREPAID"
          ? `The order has already shipped, so it can't be cancelled. You can refuse the delivery (refund of ${fmtInr(refundOnRefusal)} — the amount minus ${fmtInr(POLICY.POST_SHIP_REFUSAL_DEDUCTION)} shipping) or return it after delivery as per the return policy.`
          : "The order has already shipped, so it can't be cancelled. You can simply refuse it at the door, or return it after delivery as per the return policy.",
      data: { options: ["REFUSE_DELIVERY", "RETURN_AFTER_DELIVERY"], refundOnRefusal },
    };
  }
  if (order.status === "DELIVERED") {
    return {
      allowed: false,
      code: "ALREADY_DELIVERED",
      reason: "The order is already delivered, so it can't be cancelled. You can request a return within 7 days of delivery if the item is eligible.",
      data: { options: ["RETURN_AFTER_DELIVERY"] },
    };
  }
  return { allowed: false, code: "NOT_CANCELLABLE", reason: "This order is already on its way back to us (RTO), so it can't be cancelled." };
}

// ---------------------------------------------------------------- returns / exchanges
export interface ItemContext {
  returnClass: ReturnClass;
  deliveredAt: Date | null;
  returned: boolean;
  exchangeCount: number;
  hasOpenRequest: boolean;
}

function daysSince(d: Date, now: Date): number {
  return Math.floor((now.getTime() - d.getTime()) / DAY_MS);
}

export function checkReturn(
  item: ItemContext,
  opts: { now: Date; unusedWithTags: boolean },
): Decision {
  if (item.returnClass === "INNERWEAR") {
    return { allowed: false, code: "INNERWEAR_NOT_RETURNABLE", reason: "Innerwear can't be returned as per our policy (hygiene)." };
  }
  if (item.returnClass === "SALE") {
    return {
      allowed: false,
      code: "SALE_EXCHANGE_ONLY",
      reason: "Sale items can't be returned or refunded — they can only be exchanged for another size (within 7 days, if in stock).",
      data: { alternative: "SIZE_EXCHANGE" },
    };
  }
  if (!item.deliveredAt) return { allowed: false, code: "NOT_DELIVERED", reason: "Returns can be requested only after the order is delivered." };
  if (item.returned) return { allowed: false, code: "ALREADY_RETURNED", reason: "This item has already been returned." };
  if (item.hasOpenRequest) return { allowed: false, code: "REQUEST_ALREADY_OPEN", reason: "There is already an open return/exchange request for this item." };
  const days = daysSince(item.deliveredAt, opts.now);
  if (days > POLICY.RETURN_WINDOW_DAYS) {
    return {
      allowed: false,
      code: "RETURN_WINDOW_EXPIRED",
      reason: `Returns are accepted within 7 days of delivery. This item was delivered ${days} days ago.`,
      data: { daysSinceDelivery: days },
    };
  }
  if (!opts.unusedWithTags) {
    return { allowed: false, code: "ITEM_USED_OR_TAGS_REMOVED", reason: "Returns are accepted only for unused items with the original tags." };
  }
  return { allowed: true, code: "RETURN_ELIGIBLE", reason: `Eligible for return (delivered ${days} day(s) ago, within the 7-day window).`, data: { daysSinceDelivery: days } };
}

export function checkExchange(
  item: ItemContext & { currentSize: string },
  opts: { now: Date; newSize: string; stockForNewSize: number | null },
): Decision {
  if (item.returnClass === "INNERWEAR") {
    return { allowed: false, code: "INNERWEAR_NOT_RETURNABLE", reason: "Innerwear can't be returned or exchanged through self-service (hygiene policy)." };
  }
  if (item.returnClass === "RETURN_ONLY") {
    return { allowed: false, code: "NO_SIZE_VARIANTS", reason: "This product comes in one size, so a size exchange isn't possible. It can be returned within 7 days." };
  }
  if (!item.deliveredAt) return { allowed: false, code: "NOT_DELIVERED", reason: "Exchanges can be requested only after delivery." };
  if (item.returned) return { allowed: false, code: "ALREADY_RETURNED", reason: "This item has already been returned." };
  if (item.hasOpenRequest) return { allowed: false, code: "REQUEST_ALREADY_OPEN", reason: "There is already an open return/exchange request for this item." };
  const days = daysSince(item.deliveredAt, opts.now);
  if (days > POLICY.EXCHANGE_WINDOW_DAYS) {
    return { allowed: false, code: "EXCHANGE_WINDOW_EXPIRED", reason: `Size exchanges are allowed within 7 days of delivery. This item was delivered ${days} days ago.` };
  }
  if (item.exchangeCount >= POLICY.MAX_EXCHANGES_PER_ITEM) {
    return { allowed: false, code: "EXCHANGE_LIMIT_REACHED", reason: "This item has already been exchanged once. Only one exchange is allowed per item." };
  }
  if (opts.newSize.toUpperCase() === item.currentSize.toUpperCase()) {
    return { allowed: false, code: "SAME_SIZE", reason: `You already have size ${item.currentSize}.` };
  }
  if (opts.stockForNewSize === null) {
    return { allowed: false, code: "SIZE_NOT_OFFERED", reason: `Size ${opts.newSize} isn't available for this product.` };
  }
  if (opts.stockForNewSize <= 0) {
    return { allowed: false, code: "OUT_OF_STOCK", reason: `Size ${opts.newSize} is currently out of stock, so the exchange can't be created right now.` };
  }
  return {
    allowed: true,
    code: "EXCHANGE_ELIGIBLE",
    reason: `Eligible: size ${opts.newSize} is in stock and the item was delivered ${days} day(s) ago (within 7 days).`,
    data: { daysSinceDelivery: days, newSize: opts.newSize },
  };
}

// ---------------------------------------------------------------- manual review
export function checkManualReview(input: {
  refundAmount?: number;
  isDamageClaim?: boolean;
  hasPhoto?: boolean;
  returnsLast60Days?: number;
  thresholdPaise?: number;
}): Decision {
  const threshold = input.thresholdPaise ?? POLICY.MANUAL_REVIEW_REFUND_ABOVE;
  const reasons: string[] = [];
  if ((input.refundAmount ?? 0) > threshold) reasons.push(`refund/goodwill amount above ${fmtInr(threshold)}`);
  if (input.isDamageClaim && !input.hasPhoto) reasons.push("damage claim without a photo");
  if ((input.returnsLast60Days ?? 0) >= POLICY.MANUAL_REVIEW_RETURNS_IN_60_DAYS) reasons.push("3 or more returns in the last 60 days");
  if (reasons.length === 0) return { allowed: true, code: "NO_REVIEW_NEEDED", reason: "No manual review needed." };
  return {
    allowed: false,
    requiresManualReview: true,
    code: "MANUAL_REVIEW_REQUIRED",
    reason: `This needs a manual review by our team: ${reasons.join("; ")}.`,
    data: { reasons },
  };
}

// ---------------------------------------------------------------- refunds
export function refundMethodPolicy(paymentMethod: PaymentMethod): { methods: string[]; text: string } {
  return paymentMethod === "PREPAID"
    ? { methods: ["ORIGINAL_PAYMENT"], text: "Prepaid refunds go back to the original payment method in 5–7 working days after the returned item passes quality check." }
    : { methods: ["BANK_TRANSFER", "STORE_CREDIT"], text: "COD refunds are paid by bank transfer or store credit — whichever you choose — after the returned item passes quality check." };
}

// ---------------------------------------------------------------- address change
export function checkAddressChange(
  order: { status: OrderStatus; paymentMethod: PaymentMethod; total: number },
  newPin: PincodeInfo | null,
): Decision {
  if (!isPreDispatch(order.status)) {
    return { allowed: false, code: "ALREADY_DISPATCHED", reason: "The address can be changed only before the order is dispatched. This order has already shipped." };
  }
  if (!newPin || !newPin.serviceable) {
    return { allowed: false, code: "PINCODE_NOT_SERVICEABLE", reason: "We don't deliver to the new pincode yet, so the address can't be changed to it." };
  }
  if (order.paymentMethod === "COD") {
    const cod = checkCodEligibility(order.total, newPin);
    if (!cod.allowed) {
      return { allowed: false, code: "COD_NOT_AVAILABLE_NEW_PINCODE", reason: `${cod.reason} Switch to prepaid to deliver there.` };
    }
  }
  return { allowed: true, code: "ADDRESS_CHANGE_ALLOWED", reason: `Pincode ${newPin.pincode} (${newPin.city}) is serviceable.`, data: { zone: newPin.zone } };
}

// ---------------------------------------------------------------- NDR
/** New delivery date must be within the next N days (tomorrow … today+N, IST calendar days). */
export function checkRescheduleDate(requested: string, now: Date, windowDays = 3): Decision<{ date: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return { allowed: false, code: "INVALID_DATE", reason: "Please share the date as YYYY-MM-DD." };
  const today = isoDateIST(now);
  const toDay = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY_MS);
  const diff = toDay(requested) - toDay(today);
  if (Number.isNaN(diff)) return { allowed: false, code: "INVALID_DATE", reason: "That doesn't look like a valid date." };
  if (diff < 1) return { allowed: false, code: "DATE_IN_PAST", reason: "The new delivery date must be from tomorrow onwards." };
  if (diff > windowDays) {
    return { allowed: false, code: "DATE_OUT_OF_WINDOW", reason: `The courier can re-attempt only within the next ${windowDays} days.` };
  }
  return { allowed: true, code: "DATE_OK", reason: "Date is within the allowed window.", data: { date: requested } };
}

// ---------------------------------------------------------------- policy document (for get_policy_info)
export const POLICY_DOCUMENT: Record<string, string> = {
  returns:
    "Returns: within 7 days of delivery, item unused and with tags. Innerwear can't be returned. Sale items can only be exchanged for another size, no refund.",
  exchange: "Exchange: size exchange within 7 days of delivery if stock is available. One exchange per item.",
  cancellation:
    "Cancellation: free before the order ships. After that, the customer can refuse the delivery (prepaid orders get refunded minus ₹99 shipping) or return it after delivery.",
  refunds:
    "Refunds: prepaid orders go back to the original payment method in 5–7 working days after the returned item passes quality check. COD orders get a bank transfer or store credit, whichever the customer picks.",
  cod: "COD: allowed for orders between ₹299 and ₹4,999, with a ₹49 COD fee. Not available on non-COD pincodes. Customers get 5% off if they switch to prepaid.",
  shipping: "Shipping: free above ₹999, otherwise ₹79. Metro cities 2–4 days, rest of India 4–7 days, North East and J&K 6–9 days.",
  manual_review:
    "Manual review: any refund or goodwill request above ₹1,500, damage claims without a photo, and customers with 3 or more returns in the last 60 days.",
};
