/**
 * BullMQ queue. Jobs use deterministic ids (e.g. `cod-reminder-<orderId>`) so the same
 * job can never be scheduled twice — duplicate webhooks or retries are no-ops.
 * Every handler re-reads current state before acting, so stale jobs do nothing.
 */
import { Queue, type JobsOptions } from "bullmq";
import { createRedis } from "../lib/redis.js";
import { env } from "../config/env.js";

export const QUEUE_NAME = env.QUEUE_NAME;

export type JobData =
  | { name: "order-webhook"; webhookEventId: string }
  | { name: "courier-webhook"; webhookEventId: string }
  | { name: "courier-dispatch"; payload: Record<string, unknown> }
  | { name: "cod-confirm"; orderId: string }
  | { name: "cod-reminder"; orderId: string }
  | { name: "cod-hold"; orderId: string }
  | { name: "ndr-outreach"; shipmentId: string; eventId: string }
  | { name: "ndr-no-response"; shipmentId: string; attempt: number }
  | { name: "order-welcome"; orderId: string }
  | { name: "team-new-order"; orderId: string };

let queue: Queue | undefined;
export function jobsQueue(): Queue {
  queue ??= new Queue(QUEUE_NAME, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 7 * 86400, count: 5000 },
      removeOnFail: { age: 14 * 86400 },
    },
  });
  return queue;
}

export async function enqueue(data: JobData, jobId: string, opts: JobsOptions = {}): Promise<void> {
  await jobsQueue().add(data.name, data, { jobId, ...opts });
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
