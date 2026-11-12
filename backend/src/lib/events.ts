/**
 * Cross-process event bus. The API server and the BullMQ worker both publish to Redis;
 * the API server relays events to Socket.IO rooms (admin inbox + per-conversation).
 */
import { createRedis, redis } from "./redis.js";
import { logger } from "./logger.js";

export type AppEvent =
  | { type: "message:new"; conversationId: string; message: unknown }
  | { type: "conversation:updated"; conversationId: string; status?: string }
  | { type: "order:updated"; orderId: string; orderNumber: string }
  | { type: "order:new"; orderId: string; orderNumber: string; source: string; total: number }
  | { type: "ticket:new"; conversationId: string; ticketId: string };

const CHANNEL = "wishluck:events";

export async function publish(event: AppEvent): Promise<void> {
  try {
    await redis().publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err: String(err) }, "event publish failed");
  }
}

export function subscribe(handler: (e: AppEvent) => void): () => Promise<void> {
  const sub = createRedis();
  void sub.subscribe(CHANNEL);
  sub.on("message", (_ch: string, msg: string) => {
    try {
      handler(JSON.parse(msg) as AppEvent);
    } catch (err) {
      logger.warn({ err: String(err) }, "bad event");
    }
  });
  return async () => {
    await sub.quit();
  };
}
