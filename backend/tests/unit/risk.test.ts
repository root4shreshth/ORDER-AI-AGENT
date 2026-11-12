import { describe, expect, it } from "vitest";
import { analyseAddress, scoreCodRisk, type RiskInput } from "../../src/risk/codRisk.js";
import { DEFAULT_SETTINGS } from "../../src/modules/settings/settings.js";

const base: RiskInput = {
  orderTotal: 1_000_00,
  addressLine1: "Flat 402, Tower B, Green Park Apartments",
  priorOrders: 3,
  deliveredOrders: 3,
  previousCodRefusals: 0,
  recentCodOrders: 0,
};
const score = (over: Partial<RiskInput>) => scoreCodRisk({ ...base, ...over }, DEFAULT_SETTINGS.risk);
const signals = (r: ReturnType<typeof score>) => r.reasons.map((x) => x.signal);

describe("COD risk score", () => {
  it("Appendix B #7: ₹4,600, 'near Shiv mandir', first-time → HIGH with reasons", () => {
    const r = score({ orderTotal: 4_600_00, addressLine1: "near Shiv mandir", priorOrders: 0, deliveredOrders: 0 });
    expect(r.band).toBe("HIGH");
    expect(r.score).toBe(65);
    expect(signals(r)).toEqual(expect.arrayContaining(["FIRST_TIME_CUSTOMER", "HIGH_ORDER_VALUE", "INCOMPLETE_ADDRESS", "LANDMARK_ONLY_ADDRESS"]));
    for (const reason of r.reasons) expect(reason.explanation.length).toBeGreaterThan(10);
  });
  it("trusted repeat customer with full address → LOW (clamped at 0)", () => {
    const r = score({});
    expect(r.band).toBe("LOW");
    expect(r.score).toBe(0);
    expect(signals(r)).toEqual(["REPEAT_CUSTOMER", "SUCCESSFUL_DELIVERIES"]);
  });
  it("previous COD refusal adds 25 points", () => {
    const withRefusal = score({ previousCodRefusals: 1, priorOrders: 1, deliveredOrders: 0 });
    expect(signals(withRefusal)).toContain("PREVIOUS_COD_REFUSAL");
    expect(withRefusal.score).toBe(25);
    expect(withRefusal.band).toBe("LOW");
  });
  it("multiple recent COD orders are flagged", () => {
    expect(signals(score({ recentCodOrders: 2 }))).toContain("MULTIPLE_RECENT_COD");
  });
  it("clamps to 100", () => {
    const r = scoreCodRisk(
      { ...base, orderTotal: 4_900_00, addressLine1: "near temple", priorOrders: 0, deliveredOrders: 0, previousCodRefusals: 2, recentCodOrders: 3 },
      { ...DEFAULT_SETTINGS.risk, weights: { ...DEFAULT_SETTINGS.risk.weights, previousCodRefusal: 60 } },
    );
    expect(r.score).toBe(100);
  });
  it("bands follow configurable thresholds", () => {
    const custom = { ...DEFAULT_SETTINGS.risk, lowMax: 10, mediumMax: 20 };
    expect(scoreCodRisk({ ...base, priorOrders: 0, deliveredOrders: 0 }, custom).band).toBe("MEDIUM"); // 15
  });
  it("no signals → explicit 'no risk signals' reason", () => {
    const r = score({ priorOrders: 2, deliveredOrders: 0 });
    expect(r.reasons[0]?.signal).toBe("NO_RISK_SIGNALS");
  });
});

describe("address analysis", () => {
  it("flags landmark-only addresses", () => {
    expect(analyseAddress("near Hanuman mandir")).toMatchObject({ incomplete: true, landmarkOnly: true });
    expect(analyseAddress("Mandir ke paas, gali")).toMatchObject({ landmarkOnly: true });
  });
  it("accepts addresses with a house number", () => {
    expect(analyseAddress("House 88, Vaishali Nagar", "Near Amrapali Circle")).toMatchObject({ incomplete: false, landmarkOnly: false });
  });
});
