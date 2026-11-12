import { createServer } from "node:http";
import { Server } from "socket.io";
import { env, llmEngine } from "./config/env.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { subscribe } from "./lib/events.js";

const app = createApp();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()) } });

// Rooms: "admin" (dashboard, needs admin key) and "conv:<id>" (customer widget, needs the chat token).
io.on("connection", (socket) => {
  socket.on("join:admin", (key: string, ack?: (ok: boolean) => void) => {
    const ok = !env.ADMIN_API_KEY || key === env.ADMIN_API_KEY;
    if (ok) void socket.join("admin");
    ack?.(ok);
  });
  socket.on("join:conversation", async (p: { conversationId: string; token: string }, ack?: (ok: boolean) => void) => {
    const c = await prisma.conversation.findUnique({ where: { id: String(p?.conversationId ?? "") }, select: { token: true } });
    const ok = !!c && c.token === p.token;
    if (ok) void socket.join(`conv:${p.conversationId}`);
    ack?.(ok);
  });
});

const unsubscribe = subscribe((e) => {
  io.to("admin").emit(e.type, e);
  if ("conversationId" in e) {
    // customers only get message/status events for their own conversation (no tool traces)
    if (e.type === "message:new") io.to(`conv:${e.conversationId}`).emit("message:new", e);
    if (e.type === "conversation:updated") io.to(`conv:${e.conversationId}`).emit("conversation:updated", { conversationId: e.conversationId, status: e.status });
  }
});

httpServer.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (LLM engine: ${llmEngine()}${llmEngine() === "claude" ? `, model ${env.ANTHROPIC_MODEL}` : " — MOCK MODE, no API key"})`));

async function shutdown() {
  await unsubscribe();
  io.close();
  httpServer.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
