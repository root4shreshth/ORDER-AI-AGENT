import { prisma } from "../../lib/prisma.js";

/** Phone proven by the channel itself: a Telegram chat linked through the share-own-contact button. */
export async function channelVerifiedPhone(conv: { channel: string; externalChatId: string | null }): Promise<string | null> {
  if (conv.channel !== "telegram" || !conv.externalChatId) return null;
  const c = await prisma.customer.findUnique({ where: { telegramChatId: conv.externalChatId } });
  return c?.phone ?? null;
}
