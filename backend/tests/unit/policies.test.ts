import { describe, expect, it } from "vitest";
import {
  POLICY,
  checkAddressChange,
  checkCancellation,
  checkCodEligibility,
  checkExchange,
  checkManualReview,
  checkRescheduleDate,
  checkReturn,
  deliveryEstimate,
  prepaidConversion,
  refundMethodPolicy,
  shippingFee,
  type ItemContext,
  type PincodeInfo,
} from "../../src/policies/index.js";

const NOW = new Date("2026-11-12T06:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const item = (over: Partial<ItemContext> = {}): ItemContext => ({
  returnClass: "RETURNABLE",
  deliveredAt: daysAgo(3),
  returned: false,
  exchangeCount: 0,
  hasOpenRequest: false,
  ...over,
});
const pin = (over: Partial<PincodeInfo> = {}): PincodeInfo => ({ pincode: "110017", serviceable: true, codAvailable: true, zone: "METRO", city: "New Delhi", ...over });

describe("returns policy", () => {
  it("allows an unused returnable item within 7 days", () => {
    expect(checkReturn(item(), { now: NOW, unusedWithTags: true })).toMatchObject({ allowed: true, code: "RETURN_ELIGIBLE" });
  });
  it("allows on day 7 and rejects on day 8", () => {
    expect(checkReturn(item({ deliveredAt: daysAgo(7) }), { now: NOW, unusedWithTags: true }).allowed).toBe(true);
    expect(checkReturn(item({ deliveredAt: daysAgo(8) }), { now: NOW, unusedWithTags: true }).code).toBe("RETURN_WINDOW_EXPIRED");
  });
  it("rejects delivered 10 days ago", () => {
    expect(checkReturn(item({ deliveredAt: daysAgo(10) }), { now: NOW, unusedWithTags: true }).allowed).toBe(false);
  });
  it("rejects innerwear always (Appendix B #4)", () => {
    expect(checkReturn(item({ returnClass: "INNERWEAR" }), { now: NOW, unusedWithTags: true }).code).toBe("INNERWEAR_NOT_RETURNABLE");
  });
  it("rejects refund on sale items and offers size exchange (Appendix B #5)", () => {
    const d = checkReturn(item({ returnClass: "SALE", deliveredAt: daysAgo(2) }), { now: NOW, unusedWithTags: true });
    expect(d).toMatchObject({ allowed: false, code: "SALE_EXCHANGE_ONLY", data: { alternative: "SIZE_EXCHANGE" } });
  });
  it("rejects used items / tags removed", () => {
    expect(checkReturn(item(), { now: NOW, unusedWithTags: false }).code).toBe("ITEM_USED_OR_TAGS_REMOVED");
  });
  it("rejects undelivered, already-returned and open-request items", () => {
    expect(checkReturn(item({ deliveredAt: null }), { now: NOW, unusedWithTags: true }).code).toBe("NOT_DELIVERED");
    expect(checkReturn(item({ returned: true }), { now: NOW, unusedWithTags: true }).code).toBe("ALREADY_RETURNED");
    expect(checkReturn(item({ hasOpenRequest: true }), { now: NOW, unusedWithTags: true }).code).toBe("REQUEST_ALREADY_OPEN");
  });
});

describe("exchange policy", () => {
  const ex = (over: Partial<ItemContext> = {}, newSize = "L", stock: number | null = 5) =>
    checkExchange({ ...item(over), currentSize: "M" }, { now: NOW, newSize, stockForNewSize: stock });
  it("allows size exchange within 7 days when in stock (Appendix B #3)", () => {
    expect(ex()).toMatchObject({ allowed: true, code: "EXCHANGE_ELIGIBLE" });
  });
  it("allows size exchange for sale items", () => {
    expect(ex({ returnClass: "SALE" }).allowed).toBe(true);
  });
  it("rejects when out of stock", () => expect(ex({}, "XL", 0).code).toBe("OUT_OF_STOCK"));
  it("rejects unknown size", () => expect(ex({}, "XXXL", null).code).toBe("SIZE_NOT_OFFERED"));
  it("allows only one exchange per item", () => expect(ex({ exchangeCount: 1 }).code).toBe("EXCHANGE_LIMIT_REACHED"));
  it("rejects after 7 days", () => expect(ex({ deliveredAt: daysAgo(9) }).code).toBe("EXCHANGE_WINDOW_EXPIRED"));
  it("rejects same size", () => expect(ex({}, "M").code).toBe("SAME_SIZE"));
  it("rejects innerwear and one-size products", () => {
    expect(ex({ returnClass: "INNERWEAR" }).allowed).toBe(false);
    expect(ex({ returnClass: "RETURN_ONLY" }).code).toBe("NO_SIZE_VARIANTS");
  });
});

describe("cancellation policy", () => {
  it("is free before shipping", () => {
    for (const status of ["PENDING_CONFIRMATION", "ON_HOLD", "CONFIRMED"] as const) {
      expect(checkCancellation({ status, paymentMethod: "PREPAID", total: 100_00 }).allowed).toBe(true);
    }
  });
  it("refuses after shipping and explains refusal/return options (Appendix B #6)", () => {
    const d = checkCancellation({ status: "SHIPPED", paymentMethod: "PREPAID", total: 1878_00 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("ALREADY_SHIPPED");
    expect(d.data).toMatchObject({ refundOnRefusal: 1878_00 - 99_00 });
    expect(d.reason).toContain("₹99");
  });
  it("refuses delivered / cancelled / RTO orders", () => {
    expect(checkCancellation({ status: "DELIVERED", paymentMethod: "COD", total: 1 }).code).toBe("ALREADY_DELIVERED");
    expect(checkCancellation({ status: "CANCELLED", paymentMethod: "COD", total: 1 }).code).toBe("ALREADY_CANCELLED");
    expect(checkCancellation({ status: "RTO_INITIATED", paymentMethod: "COD", total: 1 }).code).toBe("NOT_CANCELLABLE");
  });
});

describe("COD policy", () => {
  it("allows ₹299–₹4,999 on COD pincodes", () => {
    expect(checkCodEligibility(299_00, pin()).allowed).toBe(true);
    expect(checkCodEligibility(4_999_00, pin()).allowed).toBe(true);
    expect(checkCodEligibility(298_00, pin()).code).toBe("COD_AMOUNT_OUT_OF_RANGE");
    expect(checkCodEligibility(5_000_00, pin()).code).toBe("COD_AMOUNT_OUT_OF_RANGE");
  });
  it("refuses non-COD pincodes and suggests prepaid (Appendix B #12)", () => {
    const d = checkCodEligibility(1_000_00, pin({ pincode: "795001", city: "Imphal", zone: "NE_JK", codAvailable: false }));
    expect(d).toMatchObject({ allowed: false, code: "COD_NOT_AVAILABLE_PINCODE", data: { prepaidAvailable: true } });
    expect(d.reason).toContain("6–9 days");
  });
  it("refuses unserviceable pincodes", () => {
    expect(checkCodEligibility(1_000_00, pin({ serviceable: false })).code).toBe("PINCODE_NOT_SERVICEABLE");
    expect(checkCodEligibility(1_000_00, null).code).toBe("PINCODE_NOT_SERVICEABLE");
  });
  it("prepaid conversion gives 5% off items and drops the COD fee", () => {
    expect(prepaidConversion({ itemsTotal: 4_000_00, shippingFee: 0 })).toEqual({ discount: 200_00, newTotal: 3_800_00 });
  });
});

describe("shipping, refunds, manual review", () => {
  it("free shipping above ₹999 else ₹79", () => {
    expect(shippingFee(999_00)).toBe(79_00);
    expect(shippingFee(1_000_00)).toBe(0);
  });
  it("ETA by zone", () => {
    expect(deliveryEstimate("METRO")).toMatchObject({ minDays: 2, maxDays: 4 });
    expect(deliveryEstimate("REST")).toMatchObject({ minDays: 4, maxDays: 7 });
    expect(deliveryEstimate("NE_JK")).toMatchObject({ minDays: 6, maxDays: 9 });
  });
  it("refund methods depend on payment method", () => {
    expect(refundMethodPolicy("PREPAID").methods).toEqual(["ORIGINAL_PAYMENT"]);
    expect(refundMethodPolicy("COD").methods).toEqual(["BANK_TRANSFER", "STORE_CREDIT"]);
  });
  it("manual review above ₹1,500, damage without photo, 3+ returns in 60 days", () => {
    expect(checkManualReview({ refundAmount: 1_500_00 }).requiresManualReview).toBeUndefined();
    expect(checkManualReview({ refundAmount: 2_000_00 }).requiresManualReview).toBe(true);
    expect(checkManualReview({ refundAmount: 1_000_00 }).allowed).toBe(true);
    expect(checkManualReview({ isDamageClaim: true, hasPhoto: false }).requiresManualReview).toBe(true);
    expect(checkManualReview({ isDamageClaim: true, hasPhoto: true }).allowed).toBe(true);
    expect(checkManualReview({ returnsLast60Days: 3 }).requiresManualReview).toBe(true);
    expect(checkManualReview({ returnsLast60Days: 2 }).allowed).toBe(true);
  });
  it("constants match Appendix A", () => {
    expect(POLICY).toMatchObject({ COD_FEE: 49_00, COD_MIN: 299_00, COD_MAX: 4_999_00, POST_SHIP_REFUSAL_DEDUCTION: 99_00 });
  });
});

describe("address change", () => {
  it("only before dispatch", () => {
    expect(checkAddressChange({ status: "CONFIRMED", paymentMethod: "PREPAID", total: 1_000_00 }, pin()).allowed).toBe(true);
    expect(checkAddressChange({ status: "SHIPPED", paymentMethod: "PREPAID", total: 1_000_00 }, pin()).code).toBe("ALREADY_DISPATCHED");
  });
  it("checks pincode serviceability and COD availability", () => {
    expect(checkAddressChange({ status: "CONFIRMED", paymentMethod: "PREPAID", total: 1_000_00 }, pin({ serviceable: false })).code).toBe("PINCODE_NOT_SERVICEABLE");
    expect(checkAddressChange({ status: "PENDING_CONFIRMATION", paymentMethod: "COD", total: 1_000_00 }, pin({ codAvailable: false })).code).toBe("COD_NOT_AVAILABLE_NEW_PINCODE");
    expect(checkAddressChange({ status: "PENDING_CONFIRMATION", paymentMethod: "PREPAID", total: 1_000_00 }, pin({ codAvailable: false })).allowed).toBe(true);
  });
});

describe("NDR reschedule window", () => {
  // NOW = 12 Nov 2026 11:30 IST
  it("accepts tomorrow through +3 days", () => {
    expect(checkRescheduleDate("2026-11-13", NOW).allowed).toBe(true);
    expect(checkRescheduleDate("2026-11-15", NOW).allowed).toBe(true);
  });
  it("rejects today/past and 4+ days out", () => {
    expect(checkRescheduleDate("2026-11-12", NOW).code).toBe("DATE_IN_PAST");
    expect(checkRescheduleDate("2026-11-16", NOW).code).toBe("DATE_OUT_OF_WINDOW");
  });
  it("rejects malformed dates", () => {
    expect(checkRescheduleDate("15/11/2026", NOW).code).toBe("INVALID_DATE");
  });
});
