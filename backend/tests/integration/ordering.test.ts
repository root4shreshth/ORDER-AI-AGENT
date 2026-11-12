/**
 * Ordering in chat + dashboard order entry + new-order notifications.
 * Asserts database state (orders, stock, COD records, conversations, jobs), not reply text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../../src/lib/prisma.js";
import { closeRedis } from "../../src/lib/redis.js";
import { closeQueue, jobsQueue } from "../../src/jobs/queues.js";
import { processJob } from "../../src/jobs/processor.js";
import { executeTool } from "../../src/agent/tools/execute.js";
import type { ToolContext } from "../../src/agent/tools/context.js";
import { dispatchToTelegram, type TelegramTransport } from "../../src/channels/telegram.js";
import { ADMIN, app, resetDb, startServer, stopServer } from "./helpers.js";

beforeAll(startServer);
afterAll(async () => {
  await jobsQueue().obliterate({ force: true }).catch(() => undefined);
  await closeQueue();
  await stopServer();
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(resetDb);

async function ctxFor(conversationId: string, customerText: string, turnId = `t-${Math.random()}`): Promise<ToolContext> {
  return { conversationId, turnId, conversation: await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } }), customerText, language: "en", trace: [], systemFailures: 0 };
}
const newConv = (channel = "web", externalChatId?: string) => prisma.conversation.create({ data: { token: `tok-${Math.random()}`, channel, externalChatId } });
const kurtaL = () => prisma.productVariant.findFirstOrThrow({ where: { product: { sku: "WL-KUR-01" }, size: "L" } });

const ORDER = {
  items: [{ sku: "WL-KUR-01", size: "L", quantity: 1 }, { sku: "WL-TEE-02", size: "M", quantity: 2 }],
  payment_method: "COD" as const,
  customer_name: "Neel Shah",
  phone: "9000055555",
  address_line1: "Flat 12, Lotus Apartments, MG Road",
  pincode: "411001",
};

describe("placing orders in chat", () => {
  it("propose → summary priced by the backend; nothing created before yes", async () => {
    const c = await newConv();
    const r = await executeTool(await ctxFor(c.id, "I want a kurta"), "propose_new_order", ORDER);
    expect(r.code).toBe("AWAITING_CUSTOMER_CONFIRMATION");
    // 1299 + 2×699 = 2697, free shipping, +49 COD
    expect((r.data as { total: string }).total).toBe("₹2,746");
    expect(await prisma.order.count({ where: { customer: { phone: "9000055555" } } })).toBe(0);
  });

  it("yes in a later turn creates the order: confirmed in chat, stock reserved, chat verified, team alert queued", async () => {
    const c = await newConv();
    const before = (await kurtaL()).stock;
    const p = await executeTool(await ctxFor(c.id, "order it"), "propose_new_order", ORDER);
    const id = (p.data as { pending_action_id: string }).pending_action_id;
    const done = await executeTool(await ctxFor(c.id, "yes"), "confirm_action", { pending_action_id: id });
    expect(done.code).toBe("DONE");
    const no = (done.data as { order_number: string }).order_number;
    const o = await prisma.order.findUniqueOrThrow({ where: { orderNumber: no }, include: { codConfirmation: true } });
    expect(o).toMatchObject({ status: "CONFIRMED", source: "chat_web", paymentMethod: "COD", total: 2746_00 });
    expect(o.codConfirmation).toMatchObject({ status: "CONFIRMED", response: "CONFIRMED_IN_CHAT" });
    expect((await kurtaL()).stock).toBe(before - 1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: c.id } })).verifiedOrderNumbers).toContain(no);
    expect(await jobsQueue().getJob(`team-new-order-${o.id}`)).toBeTruthy();
    expect(await processJob({ name: "team-new-order", orderId: o.id })).toBe("logged"); // no team chat configured in tests
  });

  it("prepaid gets the 5% switch discount, no COD fee, and a payment link", async () => {
    const c = await newConv();
    const p = await executeTool(await ctxFor(c.id, "x"), "propose_new_order", { ...ORDER, payment_method: "PREPAID" });
    const done = await executeTool(await ctxFor(c.id, "haan"), "confirm_action", { pending_action_id: (p.data as { pending_action_id: string }).pending_action_id });
    const d = done.data as { order_number: string; payment_link: string };
    const o = await prisma.order.findUniqueOrThrow({ where: { orderNumber: d.order_number } });
    expect(o.discount).toBe(Math.round(2697_00 * 0.05));
    expect(o.codFee).toBe(0);
    expect(d.payment_link).toContain(`/pay/${d.order_number}`);
  });

  it("refuses bulk orders, out-of-stock sizes, COD to non-COD pincodes and addresses without a house number", async () => {
    const c = await newConv();
    const ctx = await ctxFor(c.id, "x");
    expect((await executeTool(ctx, "propose_new_order", { ...ORDER, items: [{ sku: "WL-TEE-02", size: "M", quantity: 11 }] })).code).toBe("BULK_ORDER");
    expect((await executeTool(ctx, "propose_new_order", { ...ORDER, items: [{ sku: "WL-TEE-02", size: "XL", quantity: 1 }] })).code).toBe("OUT_OF_STOCK");
    expect((await executeTool(ctx, "propose_new_order", { ...ORDER, pincode: "795001" })).code).toBe("COD_NOT_AVAILABLE_PINCODE");
    expect((await executeTool(ctx, "propose_new_order", { ...ORDER, address_line1: "near the temple road" })).code).toBe("MISSING_FIELD");
    expect(await prisma.pendingAction.count({ where: { conversationId: c.id } })).toBe(0);
  });

  it("on Telegram, the linked (verified) phone is used and list_my_orders works; elsewhere it is refused", async () => {
    await prisma.customer.update({ where: { phone: "9876543210" }, data: { telegramChatId: "777" } });
    const tg = await newConv("telegram", "777");
    const p = await executeTool(await ctxFor(tg.id, "x"), "propose_new_order", { ...ORDER, phone: undefined, customer_name: undefined });
    expect((p.data as { summary: string }).summary).toContain("Aarav Sharma");
    const list = await executeTool(await ctxFor(tg.id, "x"), "list_my_orders", {});
    expect((list.data as { orders: { order_number: string }[] }).orders.map((o) => o.order_number)).toContain("WL10234");

    const web = await newConv();
    expect((await executeTool(await ctxFor(web.id, "x"), "list_my_orders", {})).code).toBe("NOT_AVAILABLE");
  });
});

describe("dashboard order entry + customer welcome", () => {
  it("POST /api/orders for a Telegram-linked customer → prepaid order → welcome message delivered to Telegram", async () => {
    const aarav = await prisma.customer.update({ where: { phone: "9876543210" }, data: { telegramChatId: "888" } });
    const r = await request(app)
      .post("/api/orders")
      .set(ADMIN)
      .send({ customerId: aarav.id, items: [{ sku: "WL-JNS-03", size: "32", quantity: 1 }], addressLine1: "Flat 402, Tower B, Green Park", pincode: "110017", paymentMethod: "PREPAID" })
      .expect(202);
    const ev = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: r.body.eventId } });
    await processJob({ name: "order-webhook", webhookEventId: ev.id });
    const o = await prisma.order.findUniqueOrThrow({ where: { orderNumber: r.body.orderNumber } });
    expect(o).toMatchObject({ source: "dashboard", status: "CONFIRMED" });

    expect(await processJob({ name: "order-welcome", orderId: o.id })).toBe("sent");
    expect(await processJob({ name: "order-welcome", orderId: o.id })).toBe("skipped"); // once only
    const msg = await prisma.message.findFirstOrThrow({ where: { conversation: { channel: "telegram", externalChatId: "888" }, meta: { path: ["kind"], equals: "ORDER_WELCOME" } } });
    expect(msg.content).toContain(r.body.orderNumber);
    const sent: string[] = [];
    const fake: TelegramTransport = { sendMessage: async (_c, t) => void sent.push(t), sendChatAction: async () => {}, answerCallbackQuery: async () => {} };
    expect(await dispatchToTelegram(msg.id, fake)).toBe(true);
    expect(sent[0]).toMatch(/Thank you for shopping/);
  });

  it("validates up front: unknown customer / out of stock give a clear 4xx", async () => {
    await request(app).post("/api/orders").set(ADMIN).send({ name: "X", phone: "123", items: [{ sku: "WL-TEE-02", size: "M", quantity: 1 }], addressLine1: "Flat 1, Road 2", pincode: "110001", paymentMethod: "COD" }).expect(400);
    const r = await request(app).post("/api/orders").set(ADMIN).send({ name: "Test Person", phone: "9000066666", items: [{ sku: "WL-TEE-02", size: "XL", quantity: 1 }], addressLine1: "Flat 1, Road 2", pincode: "110001", paymentMethod: "COD" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("OUT_OF_STOCK");
  });

  it("GET /api/customers marks Telegram-linked customers; GET /api/catalog returns live stock", async () => {
    await prisma.customer.update({ where: { phone: "9876543210" }, data: { telegramChatId: "999", telegramUsername: "aarav_s" } });
    const cs = (await request(app).get("/api/customers").set(ADMIN).expect(200)).body as { name: string; telegramLinked: boolean; telegramUsername: string; phone: string }[];
    expect(cs[0]).toMatchObject({ name: "Aarav Sharma", telegramLinked: true, telegramUsername: "aarav_s", phone: "98XXXXXX10" });
    const cat = (await request(app).get("/api/catalog").set(ADMIN).expect(200)).body as { sku: string; sizes: { size: string; stock: number }[] }[];
    expect(cat.find((p) => p.sku === "WL-TEE-02")!.sizes.find((s) => s.size === "XL")!.stock).toBe(0);
  });
});
