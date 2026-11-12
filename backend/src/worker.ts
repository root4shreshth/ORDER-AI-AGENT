import { prisma } from "./lib/prisma.js";
import { startBackgroundServices } from "./jobs/runner.js";

const stop = startBackgroundServices();

async function shutdown() {
  await stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
