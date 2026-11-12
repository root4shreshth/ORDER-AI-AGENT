/**
 * "Ask the team" — the assistant keeps the customer conversation and consults a team member for
 * decisions it must not make itself (bulk quotations, special requests). The team answers on the
 * dashboard Team page, optionally approving a structured quote; the assistant then relays the
 * answer to the customer and can book an order at the approved quote.
 */
import type { Prisma, TeamRequest } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { fmtDate, fmtInr, addDays } from "../../lib/format.js";
import { publish } from "../../lib/events.js";
import { enqueue } from "../../jobs/queues.js";
import { audit } from "../audit/audit.js";

export const TEAM_REQUEST_KINDS = ["BULK_QUOTE", "PRICE_REQUEST", "SPECIAL_REQUEST", "OTHER"] as const;

export const QuoteSchema = z.object({
  items: z.array(z.object({ sku: z.string(), size: z.string(), quantity: z.number().int().min(1).max(5000), unitPrice: z.number().int().min(1) })).min(1).max(20), // unitPrice in paise
  validDays: z.number().int().min(1).max(60).default(7),
  notes: z.string().max(500).optional(),
});
export type QuoteInput = z.infer<typeof QuoteSchema>;
export interface ApprovedQuote {
  items: { sku: string; size: string; quantity: number; unitPrice: number }[];
  validUntil: string;
  notes?: string;
}

async function notifyTeamChat(text: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TEAM_TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TEAM_TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "team chat notification failed");
  }
}

export async function createTeamRequest(conversationId: string, input: { kind: string; question: string; customerSummary: string }): Promise<{ request: TeamRequest; existing: boolean }> {
  const open = await prisma.teamRequest.findFirst({ where: { conversationId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
  if (open) {
    // one open question per chat — append new details instead of spamming the team
    const request = await prisma.teamRequest.update({ where: { id: open.id }, data: { question: `${open.question}\n\nUpdate: ${input.question}`.slice(0, 2000), customerSummary: input.customerSummary.slice(0, 1000) } });
    await publish({ type: "team:request", teamRequestId: request.id, conversationId, status: request.status });
    return { request, existing: true };
  }
  const request = await prisma.teamRequest.create({ data: { conversationId, kind: input.kind, question: input.question.slice(0, 2000), customerSummary: input.customerSummary.slice(0, 1000) } });
  await audit(prisma, { actor: "ai", entityType: "conversation", entityId: conversationId, action: "TEAM_INPUT_REQUESTED", newValue: { kind: input.kind, teamRequestId: request.id } });
  await publish({ type: "team:request", teamRequestId: request.id, conversationId, status: request.status });
  await notifyTeamChat(`🤝 The assistant needs a decision (${input.kind.replace(/_/g, " ").toLowerCase()}):\n${input.question}\n\nReply on the Team page: ${env.WEB_URL}/team`);
  return { request, existing: false };
}

export async function answerTeamRequest(id: string, input: { reply: string; quote?: QuoteInput; agentName: string }) {
  const req = await prisma.teamRequest.findUnique({ where: { id } });
  if (!req) throw notFound("Team request");
  if (req.status !== "PENDING") throw conflict("This request was already answered.");
  let quote: ApprovedQuote | undefined;
  if (input.quote) {
    const q = QuoteSchema.parse(input.quote);
    const products = await prisma.product.findMany({ where: { sku: { in: q.items.map((i) => i.sku) } }, include: { variants: true } });
    for (const it of q.items) {
      const p = products.find((x) => x.sku === it.sku);
      if (!p || !p.variants.some((v) => v.size === it.size)) throw new AppError(400, "INVALID_QUOTE_ITEM", `Unknown product/size ${it.sku} ${it.size}`);
    }
    quote = { items: q.items, validUntil: addDays(new Date(), q.validDays).toISOString(), notes: q.notes };
  }
  const updated = await prisma.teamRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "ANSWERED", reply: input.reply.slice(0, 2000), answeredBy: input.agentName, answeredAt: new Date(), quote: quote as unknown as Prisma.InputJsonValue },
  });
  if (updated.count !== 1) throw conflict("This request was already answered.");
  await audit(prisma, { actor: `human:${input.agentName}`, entityType: "conversation", entityId: req.conversationId, action: "TEAM_REPLIED", newValue: { teamRequestId: id, quote: quote ? describeQuote(quote) : null } });
  await enqueue({ name: "team-reply-relay", teamRequestId: id }, `team-reply-relay-${id}`);
  await publish({ type: "team:request", teamRequestId: id, conversationId: req.conversationId, status: "ANSWERED" });
  return prisma.teamRequest.findUniqueOrThrow({ where: { id } });
}

export function describeQuote(q: ApprovedQuote): string {
  const qty = q.items.reduce((s, i) => s + i.quantity, 0);
  const total = q.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const lines = q.items.map((i) => `${i.sku} ${i.size}×${i.quantity} @ ${fmtInr(i.unitPrice)}`).join(", ");
  return `${qty} pieces (${lines}) = ${fmtInr(total)} before shipping, valid until ${fmtDate(new Date(q.validUntil))}${q.notes ? `. Notes: ${q.notes}` : ""}`;
}

/** A team-approved, unexpired, unused quote that belongs to this conversation. */
export async function getUsableQuote(conversationId: string, teamRequestId: string): Promise<{ request: TeamRequest; quote: ApprovedQuote } | null> {
  const r = await prisma.teamRequest.findFirst({ where: { id: teamRequestId, conversationId } });
  if (!r?.quote || r.quoteUsedAt) return null;
  const quote = r.quote as unknown as ApprovedQuote;
  if (new Date(quote.validUntil) < new Date()) return null;
  return { request: r, quote };
}
