/** Internal dashboard API. Protected by ADMIN_API_KEY when it is set. */
import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { env, llmEngine } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { AppError, notFound } from "../lib/errors.js";
import { fmtInr, normalizePhone } from "../lib/format.js";
import { maskPhone, maskEmail, maskDeep } from "../lib/mask.js";
import { signBody } from "../lib/hmac.js";
import { transitionOwnership, humanReply } from "../modules/conversations/service.js";
import { respondToCod, COD_CHOICES, riskReasons } from "../modules/cod/service.js";
import { emitCourierEvent, COURIER_EVENT_TYPES } from "../courier/mockCourier.js";
import { getAnalytics } from "../modules/analytics/service.js";
import { getSettings, saveSettings, SettingsSchema, DEMO_TIMINGS, DEFAULT_SETTINGS } from "../modules/settings/settings.js";
import { audit } from "../modules/audit/audit.js";
import { jobsQueue } from "../jobs/queues.js";
import { nextOrderNumber, quoteOrder } from "../modules/orders/ingest.js";

const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (env.ADMIN_API_KEY && req.header("x-admin-key") !== env.ADMIN_API_KEY) return next(new AppError(401, "UNAUTHORIZED", "Admin key required"));
  next();
}

const agentName = (req: Request) => (req.header("x-agent-name") || "Support Agent").slice(0, 40);

export function adminRouter(): Router {
  const r = Router();
  r.use(requireAdmin);

  // ---------------------------------------------------------------- system
  r.get("/system", h(async (_req, res) => {
    const counts = await jobsQueue().getJobCounts("waiting", "delayed", "active", "failed", "completed");
    res.json({ engine: llmEngine(), model: llmEngine() === "claude" ? env.ANTHROPIC_MODEL : "mock (no API key)", queue: counts });
  }));

  // ---------------------------------------------------------------- conversations
  r.get("/conversations", h(async (req, res) => {
    const status = z.enum(["AI_HANDLING", "NEEDS_HUMAN", "HUMAN_HANDLING", "RESOLVED"]).optional().parse(req.query.status || undefined);
    const rows = await prisma.conversation.findMany({
      where: { ...(status ? { status } : {}), messages: { some: {} } },
      orderBy: { lastMessageAt: "desc" },
      take: 200,
      include: {
        customer: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        tickets: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
    });
    res.json(
      rows.map((c) => ({
        id: c.id,
        status: c.status,
        customerName: c.customer?.name ?? "Unverified visitor",
        customerPhone: maskPhone(c.customer?.phone),
        language: c.language,
        channel: c.channel,
        lastMessage: c.messages[0] ? { role: c.messages[0].role, content: c.messages[0].content.slice(0, 140), at: c.messages[0].createdAt, voice: (c.messages[0].meta as { inputMode?: string } | null)?.inputMode === "voice" } : null,
        messageCount: c._count.messages,
        handoverReason: c.handoverReason,
        ticket: c.tickets[0] ? { id: c.tickets[0].id, reason: c.tickets[0].reason, mood: c.tickets[0].mood, status: c.tickets[0].status } : null,
        assignedTo: c.assignedTo,
        flow: (c.context as { flow?: string } | null)?.flow ?? null,
        orderNumber: (c.context as { orderNumber?: string } | null)?.orderNumber ?? c.verifiedOrderNumbers[0] ?? null,
        lastMessageAt: c.lastMessageAt,
        createdAt: c.createdAt,
      })),
    );
  }));

  r.get("/conversations/:id", h(async (req, res) => {
    const c = await prisma.conversation.findUnique({
      where: { id: String(req.params.id) },
      include: {
        customer: true,
        messages: { orderBy: { createdAt: "asc" } },
        toolCalls: { orderBy: { createdAt: "asc" } },
        tickets: { orderBy: { createdAt: "desc" } },
        pendingActions: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (!c) throw notFound("Conversation");
    res.json({
      ...c,
      token: undefined,
      customerToken: c.token,
      customer: c.customer ? { name: c.customer.name, phone: maskPhone(c.customer.phone), email: maskEmail(c.customer.email) } : null,
      pendingActions: c.pendingActions.map((p) => ({ id: p.id, type: p.type, summary: maskDeep(p.summary), status: p.status, createdAt: p.createdAt })),
    });
  }));

  for (const action of ["takeover", "release", "resolve", "reopen"] as const) {
    r.post(`/conversations/:id/${action}`, h(async (req, res) => res.json(await transitionOwnership(String(req.params.id), action, agentName(req)))));
  }
  r.post("/conversations/:id/reply", h(async (req, res) => {
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(req.body);
    res.json(await humanReply(String(req.params.id), agentName(req), content));
  }));

  // ---------------------------------------------------------------- orders
  r.get("/orders", h(async (req, res) => {
    const filter = String(req.query.filter ?? "all");
    const q = String(req.query.q ?? "").trim().toUpperCase();
    const where: Prisma.OrderWhereInput = {
      ...(q ? { OR: [{ orderNumber: { contains: q } }, { customer: { name: { contains: q, mode: "insensitive" } } }] } : {}),
      ...(filter === "cod_pending" ? { codConfirmation: { status: { in: ["AWAITING", "ADDRESS_EDIT_REQUESTED"] } } } : {}),
      ...(filter === "high_risk" ? { codConfirmation: { riskBand: "HIGH" } } : {}),
      ...(filter === "on_hold" ? { status: "ON_HOLD" } : {}),
      ...(filter === "failed_delivery" ? { shipment: { status: "DELIVERY_FAILED" } } : {}),
      ...(filter === "cod" ? { codConfirmation: { isNot: null } } : {}),
      ...(filter === "rto" ? { status: { in: ["RTO_INITIATED", "RTO_DELIVERED"] } } : {}),
    };
    const rows = await prisma.order.findMany({ where, orderBy: { placedAt: "desc" }, take: 300, include: { customer: true, codConfirmation: true, shipment: true, items: true } });
    res.json(
      rows.map((o) => ({
        orderNumber: o.orderNumber,
        customerName: o.customer.name,
        customerPhone: maskPhone(o.customer.phone),
        paymentMethod: o.paymentMethod,
        status: o.status,
        total: o.total,
        totalText: fmtInr(o.total),
        itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
        city: o.city,
        pincode: o.pincode,
        placedAt: o.placedAt,
        cod: o.codConfirmation ? { score: o.codConfirmation.riskScore, band: o.codConfirmation.riskBand, status: o.codConfirmation.status } : null,
        shipment: o.shipment ? { awb: o.shipment.awb, status: o.shipment.status, attempts: o.shipment.attemptCount, ndrOpen: o.shipment.ndrOpen } : null,
      })),
    );
  }));

  r.get("/orders/:orderNumber", h(async (req, res) => {
    const orderNumber = String(req.params.orderNumber);
    const o = await prisma.order.findUnique({
      where: { orderNumber },
      include: {
        customer: true,
        items: { include: { product: true } },
        shipment: { include: { events: { orderBy: { occurredAt: "asc" } } } },
        codConfirmation: true,
        refunds: { orderBy: { createdAt: "desc" } },
        returnRequests: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!o) throw notFound("Order");
    const [auditRows, conversations] = await Promise.all([
      prisma.auditLog.findMany({ where: { OR: [{ entityId: orderNumber }, { entityId: o.shipment?.awb ?? "__none__" }, { meta: { path: ["order"], equals: orderNumber } }] }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.conversation.findMany({ where: { verifiedOrderNumbers: { has: orderNumber } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, token: true, createdAt: true, context: true } }),
    ]);
    res.json({
      ...o,
      addressLine1: o.addressLine1,
      customer: { name: o.customer.name, phone: maskPhone(o.customer.phone), email: maskEmail(o.customer.email) },
      codConfirmation: o.codConfirmation ? { ...o.codConfirmation, reasons: riskReasons(o.codConfirmation) } : null,
      shipment: o.shipment ? { ...o.shipment, alternatePhone: maskPhone(o.shipment.alternatePhone) } : null,
      audit: auditRows,
      conversations: conversations.map((c) => ({ id: c.id, status: c.status, customerToken: c.token, createdAt: c.createdAt, flow: (c.context as { flow?: string }).flow ?? null })),
    });
  }));

  r.post("/orders/:orderNumber/cod-response", h(async (req, res) => {
    const { choice } = z.object({ choice: z.enum(COD_CHOICES) }).parse(req.body);
    res.json(await respondToCod(String(req.params.orderNumber), choice, `human:${agentName(req)}`));
  }));

  r.post("/orders/:orderNumber/courier-events", h(async (req, res) => {
    const body = z.object({ type: z.enum(COURIER_EVENT_TYPES), reason: z.string().max(200).optional(), event_id: z.string().min(6).max(80).optional() }).parse(req.body);
    const o = await prisma.order.findUnique({ where: { orderNumber: String(req.params.orderNumber) }, include: { shipment: true } });
    if (!o) throw notFound("Order");
    let shipment = o.shipment;
    if (!shipment) {
      if (!["CONFIRMED"].includes(o.status)) throw new AppError(409, "NOT_READY_TO_SHIP", `Order is ${o.status}; only confirmed orders can be handed to the courier.`);
      shipment = await prisma.shipment.create({ data: { orderId: o.id, awb: `WS${Date.now().toString().slice(-8)}`, status: "CREATED", expectedDeliveryAt: new Date(Date.now() + 4 * 86_400_000) } });
    }
    const payload = await emitCourierEvent(shipment.awb, body.type, body.reason, body.event_id);
    await audit(prisma, { actor: `human:${agentName(req)}`, entityType: "courier", entityId: shipment.awb, action: "TEST_EVENT_TRIGGERED", newValue: { type: body.type, reason: body.reason }, meta: { order: o.orderNumber, eventId: payload.event_id } });
    res.status(202).json({ queued: true, event: payload });
  }));

  // ---------------------------------------------------------------- real order entry (dashboard)
  r.get("/customers", h(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const rows = await prisma.customer.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { endsWith: q.replace(/\D/g, "") || "__none__" } }] } : {},
      orderBy: [{ telegramChatId: { sort: "asc", nulls: "last" } }, { name: "asc" }],
      take: 100,
      include: { _count: { select: { orders: true } } },
    });
    res.json(rows.map((c) => ({ id: c.id, name: c.name, phone: maskPhone(c.phone), telegramLinked: !!c.telegramChatId, telegramUsername: c.telegramUsername, orders: c._count.orders })));
  }));

  r.get("/catalog", h(async (_req, res) => {
    const products = await prisma.product.findMany({ orderBy: { sku: "asc" }, include: { variants: true } });
    res.json(products.map((p) => ({ sku: p.sku, name: p.name, price: p.priceInr, priceText: fmtInr(p.priceInr), returnRule: p.notes, sizes: p.variants.map((v) => ({ size: v.size, stock: v.stock })) })));
  }));

  r.post("/orders", h(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().optional(),
        name: z.string().min(2).max(80).optional(),
        phone: z.string().max(16).optional(),
        items: z.array(z.object({ sku: z.string(), size: z.string(), quantity: z.number().int().min(1).max(10) })).min(1).max(10),
        addressLine1: z.string().min(5).max(200),
        addressLine2: z.string().max(200).optional(),
        landmark: z.string().max(120).optional(),
        pincode: z.string().regex(/^\d{6}$/),
        paymentMethod: z.enum(["COD", "PREPAID"]),
      })
      .parse(req.body);
    let customer: { name: string; phone: string };
    if (body.customerId) {
      const c = await prisma.customer.findUnique({ where: { id: body.customerId } });
      if (!c) throw notFound("Customer");
      customer = { name: c.name, phone: c.phone };
    } else {
      const phone = body.phone ? normalizePhone(body.phone) : null;
      if (!body.name || !phone) throw new AppError(400, "CUSTOMER_REQUIRED", "Pick a customer or enter a name and a valid 10-digit mobile number.");
      customer = { name: body.name, phone };
    }
    // Validate price/stock/COD rules up front so the operator gets an immediate, clear error.
    await quoteOrder({ items: body.items, pincode: body.pincode, paymentMethod: body.paymentMethod });
    const orderNumber = await nextOrderNumber();
    const payload = {
      event_id: `evt_${randomUUID()}`,
      type: "order.created",
      order: {
        order_number: orderNumber,
        source: "dashboard",
        customer,
        payment_method: body.paymentMethod,
        items: body.items,
        address: { line1: body.addressLine1, line2: body.addressLine2, landmark: body.landmark, pincode: body.pincode },
      },
    };
    const raw = JSON.stringify(payload);
    const resp = await fetch(`${env.PUBLIC_API_URL}/webhooks/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wishluck-signature": `sha256=${signBody(raw, env.ORDER_WEBHOOK_SECRET)}` },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status !== 202) throw new AppError(502, "WEBHOOK_FAILED", `Order webhook returned HTTP ${resp.status}`);
    await audit(prisma, { actor: `human:${agentName(req)}`, entityType: "order", entityId: orderNumber, action: "ORDER_ENTERED_IN_DASHBOARD", meta: { eventId: payload.event_id } });
    res.status(202).json({ orderNumber, eventId: payload.event_id });
  }));

  r.post("/orders/test", h(async (req, res) => {
    const body = z
      .object({
        preset: z.enum(["high_risk_first_time", "low_risk_repeat", "medium_risk", "prepaid", "custom"]).default("high_risk_first_time"),
        paymentMethod: z.enum(["COD", "PREPAID"]).optional(),
        name: z.string().max(80).optional(),
        phone: z.string().max(16).optional(),
        addressLine1: z.string().max(200).optional(),
        pincode: z.string().regex(/^\d{6}$/).optional(),
        items: z.array(z.object({ sku: z.string(), size: z.string(), quantity: z.number().int().min(1).max(5) })).optional(),
      })
      .parse(req.body ?? {});
    const randomPhone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    const presets = {
      high_risk_first_time: { name: "Ravi Kumar", phone: randomPhone, line1: "near Shiv mandir", pincode: "800001", pay: "COD", items: [{ sku: "WL-JNS-03", size: "32", quantity: 2 }, { sku: "WL-BAG-05", size: "ONE", quantity: 1 }] },
      low_risk_repeat: { name: "Aarav Sharma", phone: "9876543210", line1: "Flat 402, Tower B, Green Park Apartments, Sector 12", pincode: "110017", pay: "COD", items: [{ sku: "WL-TEE-02", size: "M", quantity: 1 }] },
      medium_risk: { name: "Simran Kaur", phone: randomPhone, line1: "House 21, Model Town", pincode: "302001", pay: "COD", items: [{ sku: "WL-KUR-01", size: "M", quantity: 1 }, { sku: "WL-JNS-03", size: "30", quantity: 1 }] },
      prepaid: { name: "Kabir Rao", phone: randomPhone, line1: "12, Residency Road", pincode: "560001", pay: "PREPAID", items: [{ sku: "WL-KUR-01", size: "L", quantity: 1 }] },
      custom: { name: "Test Customer", phone: randomPhone, line1: "1, Test Street", pincode: "110001", pay: "COD", items: [{ sku: "WL-TEE-02", size: "M", quantity: 1 }] },
    } as const;
    const p = presets[body.preset];
    const orderNumber = await nextOrderNumber();
    const eventId = `evt_${randomUUID()}`;
    const payload = {
      event_id: eventId,
      type: "order.created",
      order: {
        order_number: orderNumber,
        customer: { name: body.name ?? p.name, phone: body.phone ?? p.phone },
        payment_method: body.paymentMethod ?? p.pay,
        items: body.items ?? p.items,
        address: { line1: body.addressLine1 ?? p.line1, pincode: body.pincode ?? p.pincode },
      },
    };
    // Go through the real, signed webhook path (exactly what a store platform would call).
    const raw = JSON.stringify(payload);
    const resp = await fetch(`${env.PUBLIC_API_URL}/webhooks/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wishluck-signature": `sha256=${signBody(raw, env.ORDER_WEBHOOK_SECRET)}` },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    res.status(resp.status === 202 ? 202 : 502).json({ orderNumber, eventId, webhookStatus: resp.status, webhookResponse: await resp.json().catch(() => null), payload: maskDeep(payload) });
  }));

  // ---------------------------------------------------------------- tickets / analytics / settings / audit
  r.get("/tickets", h(async (req, res) => {
    const status = z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).optional().parse(req.query.status || undefined);
    res.json(await prisma.supportTicket.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 200 }));
  }));

  r.get("/analytics", h(async (_req, res) => res.json(await getAnalytics())));

  r.get("/settings", h(async (_req, res) => res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS, demoTimings: DEMO_TIMINGS })));
  r.put("/settings", h(async (req, res) => {
    const before = await getSettings();
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "INVALID_SETTINGS", "Invalid settings", parsed.error.issues);
    let saved;
    try {
      saved = await saveSettings(parsed.data);
    } catch (e) {
      throw new AppError(400, "INVALID_SETTINGS", (e as Error).message);
    }
    await audit(prisma, { actor: `human:${agentName(req)}`, entityType: "settings", entityId: "app", action: "SETTINGS_UPDATED", oldValue: before, newValue: saved });
    res.json(saved);
  }));

  r.get("/audit-logs", h(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const entityType = String(req.query.entityType ?? "").trim();
    const page = Math.max(1, Number(req.query.page ?? 1));
    const where: Prisma.AuditLogWhereInput = {
      ...(entityType ? { entityType } : {}),
      ...(q ? { OR: [{ entityId: { contains: q, mode: "insensitive" } }, { action: { contains: q, mode: "insensitive" } }, { actor: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * 50, take: 50 }), prisma.auditLog.count({ where })]);
    res.json({ rows, total, page, pageSize: 50 });
  }));

  r.get("/webhook-events", h(async (_req, res) => {
    res.json(await prisma.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 100, select: { id: true, source: true, eventId: true, eventType: true, status: true, error: true, receivedAt: true, processedAt: true } }));
  }));

  return r;
}
