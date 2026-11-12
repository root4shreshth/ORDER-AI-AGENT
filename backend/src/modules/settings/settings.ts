import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

export const SettingsSchema = z.object({
  cod: z.object({
    /** Delay before the first confirmation message (target: within a minute). */
    confirmationDelaySec: z.number().int().min(0).max(3600),
    reminderDelaySec: z.number().int().min(5).max(7 * 86400),
    holdDelaySec: z.number().int().min(10).max(14 * 86400),
    prepaidDiscountPct: z.number().min(0).max(50),
  }),
  risk: z.object({
    lowMax: z.number().int().min(0).max(100),
    mediumMax: z.number().int().min(0).max(100),
    highValueThresholdInr: z.number().int().min(0),
    weights: z.object({
      firstTimeCustomer: z.number().int(),
      highOrderValue: z.number().int(),
      incompleteAddress: z.number().int(),
      landmarkOnlyAddress: z.number().int(),
      previousCodRefusal: z.number().int(),
      multipleRecentCodOrders: z.number().int(),
      repeatCustomer: z.number().int(),
      successfulDeliveries: z.number().int(),
    }),
  }),
  ndr: z.object({
    outreachDelaySec: z.number().int().min(0).max(3600),
    noResponseDelaySec: z.number().int().min(5).max(7 * 86400),
    attemptsBeforeHandover: z.number().int().min(1).max(5),
    rescheduleWindowDays: z.number().int().min(1).max(7),
  }),
  handover: z.object({
    onHumanRequest: z.boolean(),
    onLegalThreat: z.boolean(),
    onPublicComplaintThreat: z.boolean(),
    onAnger: z.boolean(),
    onBulkOrder: z.boolean(),
    refundReviewThresholdInr: z.number().int().min(0),
    maxFailedVerifications: z.number().int().min(1).max(10),
    maxFailedTurns: z.number().int().min(1).max(10),
  }),
  agent: z.object({
    maxToolIterations: z.number().int().min(1).max(12),
    pendingActionTtlMin: z.number().int().min(1).max(1440),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  cod: { confirmationDelaySec: 5, reminderDelaySec: 2 * 3600, holdDelaySec: 24 * 3600, prepaidDiscountPct: 5 },
  risk: {
    lowMax: 29,
    mediumMax: 59,
    highValueThresholdInr: 3000,
    weights: {
      firstTimeCustomer: 15,
      highOrderValue: 15,
      incompleteAddress: 20,
      landmarkOnlyAddress: 15,
      previousCodRefusal: 25,
      multipleRecentCodOrders: 15,
      repeatCustomer: -15,
      successfulDeliveries: -10,
    },
  },
  ndr: { outreachDelaySec: 5, noResponseDelaySec: 3600, attemptsBeforeHandover: 2, rescheduleWindowDays: 3 },
  handover: {
    onHumanRequest: true,
    onLegalThreat: true,
    onPublicComplaintThreat: true,
    onAnger: true,
    onBulkOrder: false, // bulk orders are quoted via ask_team (the assistant keeps the chat)
    refundReviewThresholdInr: 1500,
    maxFailedVerifications: 3,
    maxFailedTurns: 2,
  },
  agent: { maxToolIterations: 6, pendingActionTtlMin: 30 },
};

/** Short timings for demos and tests ("seconds instead of hours"). */
export const DEMO_TIMINGS = {
  cod: { confirmationDelaySec: 2, reminderDelaySec: 30, holdDelaySec: 90 },
  ndr: { outreachDelaySec: 3, noResponseDelaySec: 45 },
} as const;

const KEY = "app";
let cache: { value: Settings; at: number } | undefined;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 2000) return cache.value;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const parsed = SettingsSchema.safeParse(row?.value);
  const value = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(next: Settings): Promise<Settings> {
  const value = SettingsSchema.parse(next);
  if (value.risk.lowMax >= value.risk.mediumMax) throw new Error("risk.lowMax must be below risk.mediumMax");
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  cache = { value, at: Date.now() };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = undefined;
}
