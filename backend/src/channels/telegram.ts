/**
 * Telegram channel — a second channel on the SAME agent (stands in for WhatsApp Cloud API).
 *
 *  inbound : long polling (getUpdates) — no public URL / tunnel needed. Each update is
 *            de-duplicated by update_id, mapped to a conversation by chat id, and text goes
 *            through the exact same orchestrator as the web chat.
 *  outbound: every AI / human / system message saved on a telegram conversation is published
 *            on the event bus; the dispatcher sends it once (Redis SET NX per message id).
 *            Quick replies become inline buttons.
 *  linking : the customer can share their phone ("Share my phone number" button). Telegram
 *            only lets a user share THEIR OWN contact, so the chat gets linked to that customer
 *            and COD confirmations / failed-delivery follow-ups for their orders arrive here.
 *            Order details still require the normal order-number + phone verification in chat.
 *
 * Runs inside the worker process (single instance), enabled when TELEGRAM_BOT_TOKEN is set.
 */
import type { Conversation, Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { normalizePhone } from "../lib/format.js";
import { maskPhone } from "../lib/mask.js";
import { subscribe } from "../lib/events.js";
import { newToken, addMessage, emitMessage } from "../modules/conversations/service.js";
import { handleCustomerMessage } from "../agent/orchestrator.js";
import { handleQuickReply } from "../modules/conversations/quickReplies.js";
import { audit } from "../modules/audit/audit.js";
import { publish } from "../lib/events.js";

// ---------------------------------------------------------------- Telegram types (subset)
export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  contact?: { phone_number: string; user_id?: number; first_name?: string };
  voice?: unknown;
  audio?: unknown;
  photo?: unknown;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: { chat: { id: number } } };
}

type ReplyMarkup =
  | { inline_keyboard: { text: string; callback_data: string }[][] }
  | { keyboard: { text: string; request_contact?: boolean }[][]; resize_keyboard: boolean; one_time_keyboard: boolean }
  | { remove_keyboard: true };

/** Thin Telegram Bot API client — swappable in tests. */
export interface TelegramTransport {
  sendMessage(chatId: string, text: string, markup?: ReplyMarkup): Promise<void>;
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
}

export class TelegramApi implements TelegramTransport {
  constructor(private readonly token: string) {}
  async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as { ok: boolean; result: T; description?: string } | null;
    if (!json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description ?? res.status}`);
    return json.result;
  }
  async sendMessage(chatId: string, text: string, markup?: ReplyMarkup) {
    await this.call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), reply_markup: markup, link_preview_options: { is_disabled: true } });
  }
  async sendChatAction(chatId: string, action: "typing") {
    await this.call("sendChatAction", { chat_id: chatId, action }).catch(() => undefined);
  }
  async answerCallbackQuery(id: string, text?: string) {
    await this.call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- conversation mapping
const CONTACT_KEYBOARD: ReplyMarkup = { keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

export async function findOrCreateTelegramConversation(chatId: string): Promise<Conversation> {
  const existing = await prisma.conversation.findFirst({ where: { channel: "telegram", externalChatId: chatId, status: { not: "RESOLVED" } }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;
  const customer = await prisma.customer.findUnique({ where: { telegramChatId: chatId } });
  const c = await prisma.conversation.create({ data: { token: newToken(), channel: "telegram", externalChatId: chatId, customerId: customer?.id } });
  await publish({ type: "conversation:updated", conversationId: c.id, status: c.status });
  return c;
}

async function botSays(conversationId: string, content: string, meta?: Prisma.InputJsonValue) {
  const m = await addMessage(prisma, { conversationId, role: "AI", content, engine: "template", meta });
  await emitMessage(m);
  return m;
}

/** Process one Telegram update. Idempotent on update_id. */
export async function handleTelegramUpdate(u: TgUpdate, transport: TelegramTransport): Promise<void> {
  const fresh = await redis().set(`tg:update:${u.update_id}`, "1", "EX", 86_400, "NX");
  if (fresh !== "OK") return; // duplicate delivery

  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = String(cq.message?.chat.id ?? cq.from.id);
    await transport.answerCallbackQuery(cq.id);
    const [kind, choice, orderNumber] = (cq.data ?? "").split(":");
    if (kind !== "qr" || !choice) return;
    const conv = await findOrCreateTelegramConversation(chatId);
    await transport.sendChatAction(chatId, "typing");
    try {
      await handleQuickReply(conv.id, choice, orderNumber || null);
    } catch (e) {
      await botSays(conv.id, (e as Error).message);
    }
    return;
  }

  const msg = u.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const text = msg.text?.trim() ?? "";

  if (text === "/start" || text.startsWith("/start ")) {
    const conv = await findOrCreateTelegramConversation(chatId);
    await botSays(
      conv.id,
      `Namaste${msg.from?.first_name ? ` ${msg.from.first_name}` : ""}! I'm the Wishluck support assistant. Ask me about your order status, returns, exchanges, refunds, COD or sizes — in English, Hindi or Hinglish.\n\nTip: tap "Share my phone number" to get COD confirmations and delivery updates for your orders here.`,
      { telegram: { requestContact: true } },
    );
    return;
  }
  if (text === "/new") {
    const open = await prisma.conversation.findFirst({ where: { channel: "telegram", externalChatId: chatId, status: { not: "RESOLVED" } } });
    if (open) await prisma.conversation.update({ where: { id: open.id }, data: { status: "RESOLVED", version: { increment: 1 } } });
    const conv = await findOrCreateTelegramConversation(chatId);
    await botSays(conv.id, "Started a new conversation. How can I help?");
    return;
  }

  if (msg.contact) {
    const conv = await findOrCreateTelegramConversation(chatId);
    // Telegram's share-contact button only shares the sender's own number; reject forwarded contacts.
    if (!msg.from || msg.contact.user_id !== msg.from.id) {
      await botSays(conv.id, "Please use the \"Share my phone number\" button to share your own number.", { telegram: { requestContact: true } });
      return;
    }
    const phone = normalizePhone(msg.contact.phone_number);
    const customer = phone ? await prisma.customer.findUnique({ where: { phone } }) : null;
    if (!customer) {
      await botSays(conv.id, "Thanks! I couldn't find any Wishluck orders for that number. You can still ask me anything here.", { telegram: { removeKeyboard: true } });
      return;
    }
    await prisma.$transaction([
      prisma.customer.updateMany({ where: { telegramChatId: chatId, id: { not: customer.id } }, data: { telegramChatId: null } }),
      prisma.customer.update({ where: { id: customer.id }, data: { telegramChatId: chatId } }),
      prisma.conversation.update({ where: { id: conv.id }, data: { customerId: customer.id } }),
    ]);
    await audit(prisma, { actor: "customer", entityType: "conversation", entityId: conv.id, action: "TELEGRAM_LINKED", meta: { phone: maskPhone(phone) } });
    await botSays(conv.id, `Thanks ${customer.name.split(" ")[0]}! Your number is linked — COD confirmations and delivery updates for your orders will come here. For order details, just send your order number.`, { telegram: { removeKeyboard: true } });
    return;
  }

  if (msg.voice || msg.audio) {
    const conv = await findOrCreateTelegramConversation(chatId);
    const m = await addMessage(prisma, { conversationId: conv.id, role: "CUSTOMER", content: "[voice note]", meta: { inputMode: "voice", unsupported: true } });
    await emitMessage(m);
    await botSays(conv.id, "Sorry, I can't listen to voice notes on Telegram yet. Please type your message — or use our website chat, where you can speak using the 🎤 button.");
    return;
  }

  if (!text) return;
  const conv = await findOrCreateTelegramConversation(chatId);
  await transport.sendChatAction(chatId, "typing");
  await handleCustomerMessage(conv.id, text);
}

// ---------------------------------------------------------------- outbound dispatcher
/** Send a saved message to Telegram if it belongs to a telegram conversation. Exactly once. */
export async function dispatchToTelegram(messageId: string, transport: TelegramTransport): Promise<boolean> {
  const m = await prisma.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
  if (!m || m.role === "CUSTOMER" || m.conversation.channel !== "telegram" || !m.conversation.externalChatId) return false;
  const claimed = await redis().set(`tg:out:${m.id}`, "1", "EX", 7 * 86_400, "NX");
  if (claimed !== "OK") return false;
  const meta = (m.meta ?? {}) as { quickReplies?: { id: string; label: string }[]; orderNumber?: string; telegram?: { requestContact?: boolean; removeKeyboard?: boolean } };
  let markup: ReplyMarkup | undefined;
  if (meta.quickReplies?.length) {
    markup = { inline_keyboard: meta.quickReplies.map((q) => [{ text: q.label, callback_data: `qr:${q.id}:${meta.orderNumber ?? ""}`.slice(0, 64) }]) };
  } else if (meta.telegram?.requestContact) markup = CONTACT_KEYBOARD;
  else if (meta.telegram?.removeKeyboard) markup = { remove_keyboard: true };
  const text = m.role === "HUMAN" ? `👤 Wishluck team: ${m.content}` : m.role === "SYSTEM" ? `ℹ️ ${m.content}` : m.content;
  try {
    await transport.sendMessage(m.conversation.externalChatId, text, markup);
    return true;
  } catch (err) {
    await redis().del(`tg:out:${m.id}`); // allow a retry on the next event
    logger.error({ err: String(err), messageId: m.id }, "telegram send failed");
    return false;
  }
}

// ---------------------------------------------------------------- runner
export function startTelegram(): () => Promise<void> {
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  let running = true;

  const unsubscribe = subscribe((e) => {
    if (e.type === "message:new") {
      const id = (e.message as { id?: string })?.id;
      if (id) void dispatchToTelegram(id, api);
    }
  });

  void (async () => {
    try {
      const me = await api.call<{ username: string }>("getMe");
      await api.call("deleteWebhook", { drop_pending_updates: false });
      logger.info(`Telegram channel active: @${me.username}`);
    } catch (err) {
      logger.error({ err: String(err) }, "Telegram disabled — could not reach the Bot API (check TELEGRAM_BOT_TOKEN)");
      running = false;
      return;
    }
    while (running) {
      try {
        const offset = Number((await redis().get("tg:offset")) ?? 0);
        const updates = await api.call<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000);
        for (const u of updates) {
          await redis().set("tg:offset", String(u.update_id + 1));
          void handleTelegramUpdate(u, api).catch((err) => logger.error({ err: String(err) }, "telegram update failed"));
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "telegram polling error, retrying");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  return async () => {
    running = false;
    await unsubscribe();
  };
}
