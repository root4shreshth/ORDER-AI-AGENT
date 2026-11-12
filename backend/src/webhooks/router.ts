/**
 * Inbound webhooks. Order of operations (and why):
 *  1. HMAC-SHA256 over the RAW body, constant-time compare  → reject forgeries (401)
 *  2. Zod schema validation                                  → reject garbage (400)
 *  3. INSERT webhook_events (unique source+event_id)         → a replay returns 200 "duplicate"
 *     and never enqueues work again
 *  4. Enqueue a job with jobId = event id and ACK fast (202) → processing is async + retried
 * Domain processing is idempotent too (unique shipment event id, COD record per order).
 */
import express, { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { verifySignature } from "../lib/hmac.js";
import { enqueue } from "../jobs/queues.js";
import { OrderWebhookSchema } from "../modules/orders/ingest.js";
import { COURIER_EVENT_TYPES } from "../courier/mockCourier.js";
import { logger } from "../lib/logger.js";

const CourierWebhookSchema = z.object({
  event_id: z.string().min(6).max(80),
  awb: z.string().min(3).max(40),
  status: z.enum(COURIER_EVENT_TYPES),
  reason: z.string().max(300).optional(),
  location: z.string().max(120).optional(),
  occurred_at: z.string().datetime(),
});

type Source = "orders" | "courier";

async function receive(req: Request, res: Response, source: Source) {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from("");
  const sigHeader = source === "orders" ? "x-wishluck-signature" : "x-courier-signature";
  const secret = source === "orders" ? env.ORDER_WEBHOOK_SECRET : env.COURIER_WEBHOOK_SECRET;
  if (!verifySignature(raw, req.header(sigHeader), secret)) {
    logger.warn({ source }, "webhook signature rejected");
    return void res.status(401).json({ error: "invalid signature" });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return void res.status(400).json({ error: "invalid JSON" });
  }
  const parsed = source === "orders" ? OrderWebhookSchema.safeParse(json) : CourierWebhookSchema.safeParse(json);
  if (!parsed.success) return void res.status(400).json({ error: "invalid payload", issues: parsed.error.issues.slice(0, 5) });
  const data = parsed.data as { event_id: string; type?: string; status?: string };

  let eventRowId: string;
  try {
    const row = await prisma.webhookEvent.create({
      data: { source, eventId: data.event_id, eventType: data.type ?? data.status ?? "unknown", payload: json as Prisma.InputJsonValue },
    });
    eventRowId = row.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return void res.status(200).json({ status: "duplicate", event_id: data.event_id });
    }
    throw e;
  }
  await enqueue({ name: source === "orders" ? "order-webhook" : "courier-webhook", webhookEventId: eventRowId }, `${source}-webhook-${data.event_id}`);
  res.status(202).json({ status: "accepted", event_id: data.event_id });
}

export function webhooksRouter(): Router {
  const r = Router();
  r.use(express.raw({ type: "*/*", limit: "256kb" }));
  r.post("/orders", (req, res, next) => receive(req, res, "orders").catch(next));
  r.post("/courier", (req, res, next) => receive(req, res, "courier").catch(next));
  return r;
}
