/**
 * Telegram channel tests with a fake transport (no real bot / network). They verify that
 * Telegram uses the same agent, de-duplicates updates and outbound sends, links customers
 * only on their own shared contact, and delivers proactive COD messages with buttons.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { closeRedis } from "../../src/lib/redis.js";
import { closeQueue, jobsQueue } from "../../src/jobs/queues.js";
import { processJob } from "../../src/jobs/processor.js";
import { dispatchToTelegram, handleTelegramUpdate, type TelegramTransport, type TgUpdate } from "../../src/channels/telegram.js";
import { handleCustomerMessage } from "../../src/agent/orchestrator.js";
import { resetDb, startServer, stopServer } from "./helpers.js";

const sent: { chatId: string; text: string; markup?: unknown }[] = [];
const fake: TelegramTransport = {
  async sendMessage(chatId, text, markup) {
    sent.push({ chatId, text, markup });
  },
  async sendChatAction() {},
  async answerCallbackQuery() {},
};
let updateId = Math.floor(Date.now() / 1000) * 1000;
const CHAT = 555001;
const msg = (m: Partial<NonNullable<TgUpdate["message"]>>): TgUpdate => ({ update_id: ++updateId, message: { message_id: updateId, chat: { id: CHAT }, from: { id: CHAT, first_name: "Aarav" }, ...m } });

/** Push every not-yet-sent bot message of the chat through the dispatcher (what the event bus does). */
async function flush() {
  const msgs = await prisma.message.findMany({ where: { conversation: { channel: "telegram", externalChatId: String(CHAT) } }, orderBy: { createdAt: "asc" } });
  for (const m of msgs) await dispatchToTelegram(m.id, fake);
}

beforeAll(startServer);
afterAll(async () => {
  await jobsQueue().obliterate({ force: true }).catch(() => undefined);
  await closeQueue();
  await stopServer();
  await closeRedis();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

describe("Telegram channel", () => {
  it("/start creates a telegram conversation and offers the share-contact button", async () => {
    await handleTelegramUpdate(msg({ text: "/start" }), fake);
    await flush();
    const conv = await prisma.conversation.findFirstOrThrow({ where: { channel: "telegram", externalChatId: String(CHAT) } });
    expect(conv.status).toBe("AI_HANDLING");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.markup)).toContain("request_contact");
  });

  it("text goes through the same agent (verification + tools) and the reply is sent once", async () => {
    await handleTelegramUpdate(msg({ text: "Where is my order WL10234? phone 9876543210" }), fake);
    await flush();
    await flush(); // second dispatch of the same messages must not resend
    const conv = await prisma.conversation.findFirstOrThrow({ where: { channel: "telegram" } });
    expect(conv.verifiedOrderNumbers).toEqual(["WL10234"]);
    expect((await prisma.toolCall.findMany({ where: { conversationId: conv.id } })).map((t) => t.toolName)).toContain("get_shipment_status");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/WS\d+/);
  });

  it("duplicate update_id is processed only once", async () => {
    const u = msg({ text: "hi" });
    await handleTelegramUpdate(u, fake);
    await handleTelegramUpdate(u, fake);
    expect(await prisma.message.count({ where: { role: "CUSTOMER", conversation: { channel: "telegram" } } })).toBe(1);
  });

  it("links the customer only for their OWN shared contact", async () => {
    await handleTelegramUpdate(msg({ contact: { phone_number: "+91 98765 43210", user_id: 999 } }), fake); // someone else's contact
    expect(await prisma.customer.count({ where: { telegramChatId: String(CHAT) } })).toBe(0);
    await handleTelegramUpdate(msg({ contact: { phone_number: "+91 98765 43210", user_id: CHAT } }), fake);
    const c = await prisma.customer.findUniqueOrThrow({ where: { phone: "9876543210" } });
    expect(c.telegramChatId).toBe(String(CHAT));
    // linking does NOT reveal order data by itself
    expect((await prisma.conversation.findFirstOrThrow({ where: { channel: "telegram" } })).verifiedOrderNumbers).toEqual([]);
  });

  it("COD confirmation for a linked customer arrives on Telegram with buttons; tapping Confirm confirms", async () => {
    await handleTelegramUpdate(msg({ contact: { phone_number: "8877665544", user_id: CHAT } }), fake); // Pooja (WL10249)
    const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: "WL10249" } });
    await prisma.codConfirmation.update({ where: { orderId: order.id }, data: { sentAt: null } });
    expect(await processJob({ name: "cod-confirm", orderId: order.id })).toBe("sent");
    await flush();
    const codMsg = sent.find((s) => s.text.includes("WL10249"))!;
    expect(JSON.stringify(codMsg.markup)).toContain("qr:CONFIRM:WL10249");

    await handleTelegramUpdate({ update_id: ++updateId, callback_query: { id: "cb1", from: { id: CHAT }, data: "qr:CONFIRM:WL10249", message: { chat: { id: CHAT } } } }, fake);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderNumber: "WL10249" } })).status).toBe("CONFIRMED");
  });

  it("voice notes get an honest 'not supported' reply, no agent call", async () => {
    await handleTelegramUpdate(msg({ voice: { file_id: "x" } }), fake);
    await flush();
    expect(sent[0]!.text).toMatch(/can't listen to voice notes/);
    expect(await prisma.toolCall.count()).toBe(0);
  });

  it("human replies from the dashboard are delivered to Telegram", async () => {
    await handleTelegramUpdate(msg({ text: "hi" }), fake);
    const conv = await prisma.conversation.findFirstOrThrow({ where: { channel: "telegram" } });
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: "HUMAN_HANDLING" } });
    const m = await prisma.message.create({ data: { conversationId: conv.id, role: "HUMAN", content: "Hi, Anita here", engine: "human" } });
    sent.length = 0;
    await dispatchToTelegram(m.id, fake);
    expect(sent[0]!.text).toBe("👤 Wishluck team: Hi, Anita here");
  });

  it("web voice input is recorded on the message", async () => {
    const conv = await prisma.conversation.create({ data: { token: "t-voice-1" } });
    await handleCustomerMessage(conv.id, "where is my order", { inputMode: "voice" });
    const m = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, role: "CUSTOMER" } });
    expect((m.meta as { inputMode?: string }).inputMode).toBe("voice");
  });
});
