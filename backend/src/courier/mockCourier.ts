/**
 * A small mock courier ("WishShip Express"). It behaves like an external service:
 *  - status changes are delivered to us as HMAC-signed webhooks (via a queued HTTP POST),
 *  - our NDR updates are sent to its REST API with timeouts + retries.
 * Failure/latency injection lets you demo how the system handles a courier outage.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { CourierStatus } from "@prisma/client";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { signBody } from "../lib/hmac.js";
import { enqueue } from "../jobs/queues.js";
import { audit } from "../modules/audit/audit.js";
import { logger } from "../lib/logger.js";
import { maskDeep } from "../lib/mask.js";

export const COURIER_EVENT_TYPES = ["picked_up", "in_transit", "out_for_delivery", "delivery_failed", "delivered", "rto_initiated"] as const;
export type CourierEventType = (typeof COURIER_EVENT_TYPES)[number];

export const toCourierStatus = (t: CourierEventType): CourierStatus => t.toUpperCase() as CourierStatus;

export interface CourierWebhookPayload {
  event_id: string;
  awb: string;
  status: CourierEventType;
  reason?: string;
  location?: string;
  occurred_at: string;
}

/** Simulate the courier emitting a status event: signed webhook POSTed asynchronously. */
export async function emitCourierEvent(awb: string, status: CourierEventType, reason?: string, eventId = randomUUID()): Promise<CourierWebhookPayload> {
  const payload: CourierWebhookPayload = {
    event_id: eventId,
    awb,
    status,
    reason: status === "delivery_failed" || status === "rto_initiated" ? reason || "Customer not available" : reason,
    location: status === "picked_up" ? "Wishluck Warehouse, Bhiwandi" : status === "in_transit" ? "Regional hub" : "Local delivery centre",
    occurred_at: new Date().toISOString(),
  };
  await enqueue({ name: "courier-dispatch", payload: payload as unknown as Record<string, unknown> }, `courier-dispatch-${eventId}`);
  return payload;
}

/** Worker side: deliver the webhook like a real courier would (signed raw body). */
export async function dispatchCourierWebhook(payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await fetch(`${env.PUBLIC_API_URL}/webhooks/courier`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-courier-signature": `sha256=${signBody(body, env.COURIER_WEBHOOK_SECRET)}` },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`courier webhook delivery failed: HTTP ${res.status}`);
}

// ---------------------------------------------------------------- courier REST API (mock)
const faults = { failNext: 0, latencyMs: 0 };

const InstructionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RESCHEDULE"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(300).optional() }),
  z.object({ type: z.literal("ADDRESS_UPDATE"), address_line1: z.string().min(3).max(200), landmark: z.string().max(120).optional(), pincode: z.string().regex(/^\d{6}$/) }),
  z.object({ type: z.literal("ALTERNATE_PHONE"), phone: z.string().regex(/^[6-9]\d{9}$/) }),
  z.object({ type: z.literal("RTO"), reason: z.string().min(2).max(300) }),
]);
export type CourierInstruction = z.infer<typeof InstructionSchema>;

export function mockCourierRouter(): Router {
  const r = Router();
  r.post("/config", (req, res) => {
    const body = z.object({ failNext: z.number().int().min(0).max(20).optional(), latencyMs: z.number().int().min(0).max(30_000).optional() }).parse(req.body);
    Object.assign(faults, body);
    res.json(faults);
  });
  r.get("/config", (_req, res) => res.json(faults));
  r.get("/shipments/:awb", async (req, res) => {
    const s = await prisma.shipment.findUnique({ where: { awb: req.params.awb }, include: { events: { orderBy: { occurredAt: "asc" } } } });
    if (!s) return void res.status(404).json({ error: "unknown AWB" });
    res.json({ awb: s.awb, status: s.status, attempts: s.attemptCount, timeline: s.events.map((e) => ({ status: e.type, reason: e.reason, location: e.location, at: e.occurredAt })) });
  });
  r.post("/shipments/:awb/instructions", async (req, res) => {
    if (faults.latencyMs) await new Promise((ok) => setTimeout(ok, faults.latencyMs));
    if (faults.failNext > 0) {
      faults.failNext--;
      return void res.status(503).json({ error: "courier temporarily unavailable" });
    }
    const parsed = InstructionSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid instruction", issues: parsed.error.issues });
    const s = await prisma.shipment.findUnique({ where: { awb: req.params.awb } });
    if (!s) return void res.status(404).json({ error: "unknown AWB" });
    const reference = `NDR-${Date.now().toString(36).toUpperCase()}`;
    await audit(prisma, { actor: "courier", entityType: "courier", entityId: s.awb, action: `INSTRUCTION_${parsed.data.type}`, newValue: parsed.data, meta: { reference } });
    res.json({ accepted: true, reference, awb: s.awb });
  });
  return r;
}

/** Client used by our backend to call the courier API — timeout + bounded retries with backoff. */
export async function sendCourierInstruction(awb: string, instruction: CourierInstruction, opts = { retries: 3, timeoutMs: 4000 }): Promise<{ reference: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(`${env.PUBLIC_API_URL}/mock-courier/shipments/${encodeURIComponent(awb)}/instructions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(instruction),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`courier rejected instruction (${res.status})`), { permanent: true });
      if (!res.ok) throw new Error(`courier HTTP ${res.status}`);
      return (await res.json()) as { reference: string };
    } catch (err) {
      lastErr = err;
      if ((err as { permanent?: boolean }).permanent) break;
      logger.warn({ awb, attempt, err: String(err), instruction: maskDeep(instruction) }, "courier instruction failed, retrying");
      await new Promise((ok) => setTimeout(ok, 300 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("courier unavailable");
}
