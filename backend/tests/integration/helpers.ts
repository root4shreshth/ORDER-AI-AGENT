import type { Server } from "node:http";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seed } from "../../prisma/seed.js";
import { signBody } from "../../src/lib/hmac.js";
import { saveSettings, DEFAULT_SETTINGS, invalidateSettingsCache } from "../../src/modules/settings/settings.js";

export const app = createApp();
export const ADMIN = { "x-admin-key": "test-admin-key", "x-agent-name": "Tester" };
let server: Server | undefined;

/** The courier client calls PUBLIC_API_URL (port 4555) — serve the same app there. */
export async function startServer(): Promise<void> {
  if (server) return;
  await new Promise<void>((resolve) => {
    server = app.listen(4555, "127.0.0.1", () => resolve());
  });
}
export async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
}

export async function resetDb(): Promise<void> {
  await seed();
  invalidateSettingsCache();
  await saveSettings(DEFAULT_SETTINGS);
}

export async function startChat(): Promise<{ id: string; token: string }> {
  const r = await request(app).post("/api/chat/start").expect(201);
  return { id: r.body.conversationId, token: r.body.token };
}

export async function say(chat: { id: string; token: string }, text: string) {
  const r = await request(app).post(`/api/chat/${chat.id}/messages`).set("x-chat-token", chat.token).send({ text });
  if (r.status !== 200) throw new Error(`chat failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { status: string; reply: { content: string } | null; handedOver: boolean; engine: string };
}

export function signedPost(path: "/webhooks/orders" | "/webhooks/courier", payload: unknown, secret: string) {
  const raw = JSON.stringify(payload);
  const header = path === "/webhooks/orders" ? "x-wishluck-signature" : "x-courier-signature";
  return request(app).post(path).set("content-type", "application/json").set(header, `sha256=${signBody(raw, secret)}`).send(raw);
}

export const toolNames = async (conversationId: string) => (await prisma.toolCall.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } })).map((t) => t.toolName);
