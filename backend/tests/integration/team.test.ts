/**
 * "Ask the team" workflow: the assistant consults the team, the team answers (optionally with an
 * approved quote) on the Team page, the reply is relayed to the customer, and the quote can be
 * booked exactly once. Asserts database state and what the customer can / cannot see.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../../src/lib/prisma.js";
import { closeRedis } from "../../src/lib/redis.js";
import { closeQueue, jobsQueue } from "../../src/jobs/queues.js";
import { processJob } from "../../src/jobs/processor.js";
import { executeTool } from "../../src/agent/tools/execute.js";
import type { ToolContext } from "../../src/agent/tools/context.js";
import { searchKnowledge } from "../../src/modules/catalog/knowledge.js";
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

const ctxFor = async (conversationId: string, customerText: string): Promise<ToolContext> => ({
  conversationId,
  turnId: `t-${Math.random()}`,
  conversation: await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
  customerText,
  language: "en",
  trace: [],
  systemFailures: 0,
});

async function askTeam(conversationId: string) {
  return executeTool(await ctxFor(conversationId, "250 kurtas, best price?"), "ask_team", {
    kind: "BULK_QUOTE",
    question: "Customer wants 250 cotton printed kurtas, S/M/L/XL equally. Best price per piece?",
    customer_summary: "Telegram customer planning a corporate order.",
  });
}

const QUOTE = { items: [{ sku: "WL-KUR-01", size: "M", quantity: 125, unitPrice: 1000_00 }, { sku: "WL-KUR-01", size: "L", quantity: 125, unitPrice: 1000_00 }], validDays: 7 };
const ORDER_FIELDS = { payment_method: "PREPAID" as const, customer_name: "Corporate Buyer", phone: "9000077777", address_line1: "Office 4, Civil Lines", pincode: "226001" };

describe("ask the team", () => {
  it("creates one pending request per chat (follow-ups update it) and the AI keeps the chat", async () => {
    const c = await prisma.conversation.create({ data: { token: "team-1" } });
    expect((await askTeam(c.id)).code).toBe("TEAM_REQUEST_SENT");
    expect((await askTeam(c.id)).code).toBe("TEAM_REQUEST_UPDATED");
    expect(await prisma.teamRequest.count({ where: { conversationId: c.id, status: "PENDING" } })).toBe(1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("AI_HANDLING");
  });

  it("team reply → relayed to the customer; the internal note is never shown to the customer", async () => {
    const c = await prisma.conversation.create({ data: { token: "team-2", channel: "telegram", externalChatId: "4242" } });
    const id = ((await askTeam(c.id)).data as { team_request_id: string }).team_request_id;
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "We can do ₹1,000 per piece for 250 pieces, ready in 12 days.", quote: QUOTE }).expect(200);
    expect((await prisma.teamRequest.findUniqueOrThrow({ where: { id } })).status).toBe("ANSWERED");

    expect(await processJob({ name: "team-reply-relay", teamRequestId: id })).toBe("relayed");
    expect(await processJob({ name: "team-reply-relay", teamRequestId: id })).toBe("skipped"); // exactly once

    const msgs = await prisma.message.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: "asc" } });
    const note = msgs.find((m) => m.role === "SYSTEM")!;
    const relay = msgs.find((m) => m.role === "AI" && m.intent === "team_update")!;
    expect(relay.content).toContain("₹1,000 per piece");
    const sent: string[] = [];
    const fake: TelegramTransport = { sendMessage: async (_c, t) => void sent.push(t), sendChatAction: async () => {}, answerCallbackQuery: async () => {} };
    expect(await dispatchToTelegram(note.id, fake)).toBe(false); // internal → not sent
    expect(await dispatchToTelegram(relay.id, fake)).toBe(true);
    const pub = (await request(app).get(`/api/chat/session?token=team-2`).expect(200)).body as { messages: { role: string }[] };
    expect(pub.messages.some((m) => m.role === "SYSTEM")).toBe(false);
  });

  it("if a human owns the chat, the team reply is noted but the AI does not message the customer", async () => {
    const c = await prisma.conversation.create({ data: { token: "team-3" } });
    const id = ((await askTeam(c.id)).data as { team_request_id: string }).team_request_id;
    await prisma.conversation.update({ where: { id: c.id }, data: { status: "HUMAN_HANDLING" } });
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "₹1,000 per piece" }).expect(200);
    expect(await processJob({ name: "team-reply-relay", teamRequestId: id })).toBe("human_owns_chat");
    expect(await prisma.message.count({ where: { conversationId: c.id, role: "AI" } })).toBe(0);
  });

  it("a team-approved quote can be booked once, at the quoted price, without the bulk limit", async () => {
    const c = await prisma.conversation.create({ data: { token: "team-4" } });
    const id = ((await askTeam(c.id)).data as { team_request_id: string }).team_request_id;
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "Approved", quote: QUOTE }).expect(200);
    const stockBefore = (await prisma.productVariant.findFirstOrThrow({ where: { product: { sku: "WL-KUR-01" }, size: "M" } })).stock;

    // COD isn't possible for ₹2.5L (policy max ₹4,999)
    expect((await executeTool(await ctxFor(c.id, "x"), "propose_new_order", { ...ORDER_FIELDS, payment_method: "COD", quote_id: id })).code).toBe("COD_AMOUNT_OUT_OF_RANGE");

    const p = await executeTool(await ctxFor(c.id, "book it"), "propose_new_order", { ...ORDER_FIELDS, quote_id: id });
    expect((p.data as { total: string }).total).toBe("₹2,50,000");
    const done = await executeTool(await ctxFor(c.id, "yes"), "confirm_action", { pending_action_id: (p.data as { pending_action_id: string }).pending_action_id });
    expect(done.code).toBe("DONE");
    const o = await prisma.order.findUniqueOrThrow({ where: { orderNumber: (done.data as { order_number: string }).order_number }, include: { items: true } });
    expect(o.items.every((i) => i.unitPrice === 1000_00)).toBe(true);
    expect(o.items.reduce((s, i) => s + i.quantity, 0)).toBe(250);
    expect(o.discount).toBe(0);
    expect((await prisma.productVariant.findFirstOrThrow({ where: { product: { sku: "WL-KUR-01" }, size: "M" } })).stock).toBe(stockBefore); // made to order
    const tr = await prisma.teamRequest.findUniqueOrThrow({ where: { id } });
    expect(tr).toMatchObject({ status: "CLOSED", orderId: o.id });

    // second booking of the same quote is refused
    expect((await executeTool(await ctxFor(c.id, "x"), "propose_new_order", { ...ORDER_FIELDS, quote_id: id })).code).toBe("QUOTE_NOT_AVAILABLE");
  });

  it("a quote from another chat cannot be used", async () => {
    const a = await prisma.conversation.create({ data: { token: "team-5a" } });
    const b = await prisma.conversation.create({ data: { token: "team-5b" } });
    const id = ((await askTeam(a.id)).data as { team_request_id: string }).team_request_id;
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "ok", quote: QUOTE }).expect(200);
    expect((await executeTool(await ctxFor(b.id, "x"), "propose_new_order", { ...ORDER_FIELDS, quote_id: id })).code).toBe("QUOTE_NOT_AVAILABLE");
  });

  it("answering twice is refused; invalid quote items are rejected", async () => {
    const c = await prisma.conversation.create({ data: { token: "team-6" } });
    const id = ((await askTeam(c.id)).data as { team_request_id: string }).team_request_id;
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "x", quote: { items: [{ sku: "WL-NOPE", size: "M", quantity: 5, unitPrice: 100 }] } }).expect(400);
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "fine" }).expect(200);
    await request(app).post(`/api/team-requests/${id}/reply`).set(ADMIN).send({ reply: "again" }).expect(409);
  });
});

describe("knowledge base", () => {
  it("finds the right entries", () => {
    expect(searchKnowledge("can I get a bulk quotation for my company")[0]?.id).toBe("bulk");
    expect(searchKnowledge("what payment methods, upi?")[0]?.id).toBe("payments");
    expect(searchKnowledge("xyzzy")).toEqual([]);
  });
  it("product details are seeded and returned by get_product_info", async () => {
    const c = await prisma.conversation.create({ data: { token: "kb-1" } });
    const r = await executeTool(await ctxFor(c.id, "x"), "get_product_info", { query: "kurta" });
    const kurta = (r.data as { sku: string; details: { fabric: string } }[]).find((p) => p.sku === "WL-KUR-01")!;
    expect(kurta.details.fabric).toMatch(/cotton/i);
  });
});
