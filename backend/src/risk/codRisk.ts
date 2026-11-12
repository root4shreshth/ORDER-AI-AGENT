/**
 * Explainable, rules-based COD/RTO risk score (0–100).
 * Each signal contributes fixed points (configurable in Settings) and a plain-language reason.
 * Risk is NOT eligibility: a high-risk order is still allowed — it gets a stronger
 * confirmation and a prepaid offer, never an automatic rejection.
 */
import type { Settings } from "../modules/settings/settings.js";
import { fmtInr } from "../lib/format.js";

export interface RiskInput {
  orderTotal: number; // paise
  addressLine1: string;
  addressLine2?: string | null;
  landmark?: string | null;
  priorOrders: number; // orders placed before this one
  deliveredOrders: number; // successful deliveries
  previousCodRefusals: number; // COD orders that went RTO / were refused
  recentCodOrders: number; // other COD orders by this phone in the last 24h
}

export interface RiskReason {
  signal: string;
  points: number;
  explanation: string;
}

export interface RiskResult {
  score: number;
  band: "LOW" | "MEDIUM" | "HIGH";
  reasons: RiskReason[];
}

const LANDMARK_RE = /\b(near|nr\.?|opp\.?|opposite|behind|beside|next to|in front of|ke paas|ke pass|paas|samne|ke peeche)\b/i;
const HOUSE_NO_RE = /\d/; // any house / flat / plot / street number

export function analyseAddress(line1: string, line2?: string | null): { incomplete: boolean; landmarkOnly: boolean; notes: string[] } {
  const full = `${line1} ${line2 ?? ""}`.trim();
  const notes: string[] = [];
  const hasNumber = HOUSE_NO_RE.test(full);
  const tooShort = full.replace(/\s+/g, " ").length < 15;
  const incomplete = !hasNumber || tooShort;
  if (!hasNumber) notes.push("no house/flat number");
  if (tooShort) notes.push("very short address");
  const landmarkOnly = LANDMARK_RE.test(full) && !hasNumber;
  return { incomplete, landmarkOnly, notes };
}

export function scoreCodRisk(input: RiskInput, settings: Settings["risk"]): RiskResult {
  const w = settings.weights;
  const reasons: RiskReason[] = [];
  const add = (signal: string, points: number, explanation: string) => {
    if (points !== 0) reasons.push({ signal, points, explanation });
  };

  if (input.priorOrders === 0) add("FIRST_TIME_CUSTOMER", w.firstTimeCustomer, "First order from this phone number — no delivery history yet.");

  if (input.orderTotal > settings.highValueThresholdInr * 100) {
    add("HIGH_ORDER_VALUE", w.highOrderValue, `Order value ${fmtInr(input.orderTotal)} is above ₹${settings.highValueThresholdInr.toLocaleString("en-IN")}, so a refusal costs more.`);
  }

  const addr = analyseAddress(input.addressLine1, input.addressLine2);
  if (addr.incomplete) add("INCOMPLETE_ADDRESS", w.incompleteAddress, `Address looks incomplete (${addr.notes.join(", ")}), which often causes failed deliveries.`);
  if (addr.landmarkOnly) add("LANDMARK_ONLY_ADDRESS", w.landmarkOnlyAddress, "Address is described only by a landmark (e.g. \"near temple\"), not a house/street.");

  if (input.previousCodRefusals > 0) {
    add("PREVIOUS_COD_REFUSAL", w.previousCodRefusal, `${input.previousCodRefusals} earlier COD order(s) on this number were refused / returned to origin.`);
  }
  if (input.recentCodOrders > 0) {
    add("MULTIPLE_RECENT_COD", w.multipleRecentCodOrders, `${input.recentCodOrders} other COD order(s) from this number in the last 24 hours.`);
  }
  if (input.deliveredOrders >= 1) add("REPEAT_CUSTOMER", w.repeatCustomer, `Repeat customer with ${input.deliveredOrders} successful deliver${input.deliveredOrders === 1 ? "y" : "ies"}.`);
  if (input.deliveredOrders >= 2) add("SUCCESSFUL_DELIVERIES", w.successfulDeliveries, "Has accepted multiple deliveries before.");

  const raw = reasons.reduce((s, r) => s + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  const band = score <= settings.lowMax ? "LOW" : score <= settings.mediumMax ? "MEDIUM" : "HIGH";
  if (reasons.length === 0) reasons.push({ signal: "NO_RISK_SIGNALS", points: 0, explanation: "No risk signals found." });
  return { score, band, reasons };
}
