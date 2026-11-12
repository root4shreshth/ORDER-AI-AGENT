import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import type { JobData } from "./queues.js";
import { ingestOrder, OrderWebhookSchema } from "../modules/orders/ingest.js";
import { processCourierEvent, sendNdrOutreach, checkNdrNoResponse } from "../modules/ndr/service.js";
import { holdCodOrder, sendCodConfirmation, sendCodReminder } from "../modules/cod/service.js";
import { dispatchCourierWebhook, type CourierWebhookPayload } from "../courier/mockCourier.js";
import { notifyTeamNewOrder, sendOrderWelcome } from "../modules/orders/notifications.js";

async function markWebhook(id: string, status: "PROCESSED" | "FAILED", error?: string) {
  await prisma.webhookEvent.update({ where: { id }, data: { status, processedAt: new Date(), error } });
}

/** Single entry point for all background jobs. Every handler re-reads state, so retries are safe. */
export async function processJob(data: JobData): Promise<unknown> {
  switch (data.name) {
    case "order-webhook": {
      const ev = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: data.webhookEventId } });
      if (ev.status === "PROCESSED") return "already-processed";
      try {
        const r = await ingestOrder(OrderWebhookSchema.parse(ev.payload));
        await markWebhook(ev.id, "PROCESSED");
        return r;
      } catch (e) {
        if (e instanceof AppError) {
          // business rejection — don't retry
          await markWebhook(ev.id, "FAILED", `${e.code}: ${e.message}`);
          return `rejected: ${e.code}`;
        }
        throw e;
      }
    }
    case "courier-webhook": {
      const ev = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: data.webhookEventId } });
      if (ev.status === "PROCESSED") return "already-processed";
      try {
        const r = await processCourierEvent(ev.payload as unknown as CourierWebhookPayload);
        await markWebhook(ev.id, "PROCESSED");
        return r;
      } catch (e) {
        if (e instanceof AppError) {
          await markWebhook(ev.id, "FAILED", `${e.code}: ${e.message}`);
          return `rejected: ${e.code}`;
        }
        throw e;
      }
    }
    case "courier-dispatch":
      await dispatchCourierWebhook(data.payload);
      return "delivered";
    case "cod-confirm":
      return sendCodConfirmation(data.orderId);
    case "cod-reminder":
      return sendCodReminder(data.orderId);
    case "cod-hold":
      return holdCodOrder(data.orderId);
    case "ndr-outreach":
      return sendNdrOutreach(data.shipmentId, data.eventId);
    case "ndr-no-response":
      return checkNdrNoResponse(data.shipmentId, data.attempt);
    case "order-welcome":
      return sendOrderWelcome(data.orderId);
    case "team-new-order":
      return notifyTeamNewOrder(data.orderId);
    default:
      logger.warn({ data }, "unknown job");
      return "unknown";
  }
}
