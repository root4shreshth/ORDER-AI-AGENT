import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { AppError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { webhooksRouter } from "./webhooks/router.js";
import { adminRouter } from "./routes/admin.js";
import { chatRouter, publicRouter } from "./routes/chat.js";
import { mockCourierRouter } from "./courier/mockCourier.js";
import { telegramWebhookRouter } from "./channels/telegram.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()), allowedHeaders: ["content-type", "x-admin-key", "x-chat-token", "x-agent-name"] }));

  // Webhooks need the raw body for HMAC — mounted BEFORE the JSON parser.
  app.use("/webhooks", webhooksRouter());
  app.use("/telegram", telegramWebhookRouter());
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/chat", chatRouter());
  app.use("/api/public", publicRouter());
  app.use("/api", adminRouter());
  app.use("/mock-courier", mockCourierRouter());

  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return void res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return void res.status(400).json({ error: "VALIDATION_ERROR", message: "Invalid request", details: err.issues.slice(0, 10) });
    logger.error({ err: err instanceof Error ? err.stack : String(err), path: req.path }, "unhandled error");
    res.status(500).json({ error: "INTERNAL_ERROR", message: "Something went wrong" });
  });
  return app;
}
