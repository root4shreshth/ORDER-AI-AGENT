/** Quick-reply buttons (web chat and Telegram inline buttons) share one code path. */
import type { Message } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { COD_CHOICES, respondFromChat, type CodChoice } from "../cod/service.js";
import { NDR_QUICK_REPLIES } from "../ndr/service.js";
import { handleCustomerMessage } from "../../agent/orchestrator.js";

const NDR_TEXT: Record<string, string> = {
  NDR_RESCHEDULE: "I want the delivery on another day",
  NDR_ADDRESS: "I want to correct my address / add a landmark",
  NDR_PHONE: "I want to give another phone number",
  NDR_CANCEL: "I don't want the order any more",
};

/** General menu buttons (Telegram /start menu, order welcome message) — sent to the agent as text. */
const MENU_TEXT: Record<string, (orderNumber?: string | null) => string> = {
  SHOP: () => "I want to shop — show me your products",
  MY_ORDERS: () => "Show my orders",
  HELP: () => "I need help with an order",
  TRACK: (o) => (o ? `Where is my order ${o}?` : "Where is my order?"),
};
export const MENU_QUICK_REPLIES = [
  { id: "SHOP", label: "🛍 Shop" },
  { id: "MY_ORDERS", label: "📦 My orders" },
  { id: "HELP", label: "💬 Help" },
];

export async function handleQuickReply(conversationId: string, choice: string, orderNumber?: string | null): Promise<{ reply: Message | null; status?: string }> {
  const menu = MENU_TEXT[choice];
  if (menu) {
    const turn = await handleCustomerMessage(conversationId, menu(orderNumber));
    return { reply: turn.reply, status: turn.status };
  }
  if ((COD_CHOICES as readonly string[]).includes(choice)) {
    if (!orderNumber) throw new AppError(400, "ORDER_REQUIRED", "orderNumber required");
    const r = await respondFromChat(conversationId, orderNumber, choice as CodChoice);
    return { reply: r.reply };
  }
  if (!NDR_QUICK_REPLIES.some((q) => q.id === choice)) throw new AppError(400, "UNKNOWN_CHOICE", "Unknown quick reply");
  const turn = await handleCustomerMessage(conversationId, NDR_TEXT[choice]!);
  return { reply: turn.reply, status: turn.status };
}
