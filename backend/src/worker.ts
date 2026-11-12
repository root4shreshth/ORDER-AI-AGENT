import { Worker } from "bullmq";
import { createRedis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { QUEUE_NAME, type JobData } from "./jobs/queues.js";
import { processJob } from "./jobs/processor.js";
import { env } from "./config/env.js";
import { startTelegram } from "./channels/telegram.js";

const worker = new Worker<JobData>(QUEUE_NAME, async (job) => processJob(job.data), { connection: createRedis(), concurrency: 8 });

worker.on("completed", (job, result) => logger.info({ job: job.name, id: job.id, result: typeof result === "string" ? result : "ok" }, "job completed"));
worker.on("failed", (job, err) => logger.error({ job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"));
logger.info("worker started");

const stopTelegram = env.TELEGRAM_BOT_TOKEN ? startTelegram() : null;
if (!stopTelegram) logger.info("Telegram channel disabled (TELEGRAM_BOT_TOKEN not set)");

async function shutdown() {
  await stopTelegram?.();
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
