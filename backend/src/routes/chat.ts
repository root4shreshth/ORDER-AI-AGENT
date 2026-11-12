/** Customer-facing chat API (web widget). Every conversation call needs its secret token. */
import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Conversation } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, notFound } from "../lib/errors.js";
import { fmtDate } from "../lib/format.js";
import { llmEngine } from "../config/env.js";
import { startConversation } from "../modules/conversations/service.js";
import { handleCustomerMessage } from "../agent/orchestrator.js";
import { handleQuickReply } from "../modules/conversations/quickReplies.js";

const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

async function authConversation(req: Request): Promise<Conversation> {
  const token = req.header("x-chat-token") ?? "";
  const conv = await prisma.conversation.findUnique({ where: { id: String(req.params.id) } });
  if (!conv || !token || conv.token !== token) throw new AppError(403, "FORBIDDEN", "Invalid conversation token");
  return conv;
}

function publicMessages(messages: { id: string; role: string; content: string; createdAt: Date; engine: string | null; meta: unknown }[]) {
  return messages.filter((m) => !(m.meta as { internal?: boolean } | null)?.internal).map((m) => {
    const meta = (m.meta ?? {}) as { quickReplies?: unknown; orderNumber?: string; paymentLink?: string; kind?: string };
    return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, engine: m.engine, quickReplies: meta.quickReplies ?? null, orderNumber: meta.orderNumber ?? null, paymentLink: meta.paymentLink ?? null, kind: meta.kind ?? null };
  });
}

export function chatRouter(): Router {
  const r = Router();
  r.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

  r.post("/start", h(async (_req, res) => {
    const c = await startConversation("web");
    res.status(201).json({ conversationId: c.id, token: c.token, engine: llmEngine() });
  }));

  r.get("/session", h(async (req, res) => {
    const token = String(req.query.token ?? "");
    const c = token ? await prisma.conversation.findUnique({ where: { token }, include: { messages: { orderBy: { createdAt: "asc" } } } }) : null;
    if (!c) throw notFound("Conversation");
    res.json({ conversationId: c.id, token: c.token, status: c.status, engine: llmEngine(), messages: publicMessages(c.messages) });
  }));

  r.get("/:id/messages", h(async (req, res) => {
    const conv = await authConversation(req);
    const messages = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    res.json({ status: conv.status, messages: publicMessages(messages) });
  }));

  r.post("/:id/messages", h(async (req, res) => {
    const conv = await authConversation(req);
    const { text, inputMode } = z.object({ text: z.string().trim().min(1).max(2000), inputMode: z.enum(["text", "voice"]).optional() }).parse(req.body);
    const turn = await handleCustomerMessage(conv.id, text, { inputMode });
    res.json({
      status: turn.status,
      engine: turn.engine,
      reply: turn.reply ? publicMessages([turn.reply])[0] : null,
      handedOver: !!turn.ticket,
    });
  }));

  r.post("/:id/quick-reply", h(async (req, res) => {
    const conv = await authConversation(req);
    const body = z.object({ choice: z.string().max(40), orderNumber: z.string().max(20).nullish() }).parse(req.body);
    const r2 = await handleQuickReply(conv.id, body.choice, body.orderNumber);
    res.json({ reply: r2.reply ? publicMessages([r2.reply])[0] : null, status: r2.status });
  }));

  return r;
}

/** Public tracking page data — status only, no personal data. */
export function publicRouter(): Router {
  const r = Router();
  r.get("/track/:awb", h(async (req, res) => {
    const s = await prisma.shipment.findUnique({ where: { awb: String(req.params.awb) }, include: { events: { orderBy: { occurredAt: "asc" } }, order: { select: { orderNumber: true, city: true } } } });
    if (!s) throw notFound("Shipment");
    res.json({ awb: s.awb, courier: s.courier, status: s.status, orderNumber: s.order.orderNumber, city: s.order.city, expectedDelivery: fmtDate(s.rescheduledFor ?? s.expectedDeliveryAt), timeline: s.events.map((e) => ({ status: e.type, reason: e.reason, location: e.location, at: e.occurredAt })) });
  }));
  r.get("/pay/:orderNumber", h(async (req, res) => {
    const o = await prisma.order.findUnique({ where: { orderNumber: String(req.params.orderNumber) }, include: { codConfirmation: true } });
    if (!o) throw notFound("Order");
    res.json({ orderNumber: o.orderNumber, total: o.total, discount: o.discount, paymentMethod: o.paymentMethod, demo: true });
  }));
  return r;
}
