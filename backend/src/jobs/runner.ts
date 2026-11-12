/**
 * Background services: the BullMQ worker and the Telegram channel. They run in the separate
 * worker process locally / in Docker, or inside the API process when RUN_WORKER=true
 * (single free web service on Render).
 */
import { Worker } from "bullmq";
import { createRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { QUEUE_NAME, type JobData } from "./queues.js";
import { processJob } from "./processor.js";
import { startTelegram } from "../channels/telegram.js";

export function startBackgroundServices(): () => Promise<void> {
  const worker = new Worker<JobData>(QUEUE_NAME, async (job) => processJob(job.data), { connection: createRedis(), concurrency: 8 });
  worker.on("completed", (job, result) => logger.info({ job: job.name, id: job.id, result: typeof result === "string" ? result : "ok" }, "job completed"));
  worker.on("failed", (job, err) => logger.error({ job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"));
  logger.info("worker started");

  const stopTelegram = env.TELEGRAM_BOT_TOKEN ? startTelegram() : null;
  if (!stopTelegram) logger.info("Telegram channel disabled (TELEGRAM_BOT_TOKEN not set)");

  return async () => {
    await stopTelegram?.();
    await worker.close();
  };
}
