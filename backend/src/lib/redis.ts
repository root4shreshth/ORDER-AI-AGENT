import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let shared: Redis | undefined;
export function redis(): Redis {
  shared ??= createRedis();
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}

/** Simple per-key lock (SET NX PX). Returns a release fn, or null if busy. */
export async function acquireLock(key: string, ttlMs = 60_000): Promise<null | (() => Promise<void>)> {
  const token = randomUUID();
  const ok = await redis().set(`lock:${key}`, token, "PX", ttlMs, "NX");
  if (ok !== "OK") return null;
  return async () => {
    const cur = await redis().get(`lock:${key}`);
    if (cur === token) await redis().del(`lock:${key}`);
  };
}

/** Wait for a lock (bounded) — used to serialise messages within one conversation. */
export async function waitForLock(key: string, timeoutMs = 45_000): Promise<() => Promise<void>> {
  const start = Date.now();
  for (;;) {
    const release = await acquireLock(key);
    if (release) return release;
    if (Date.now() - start > timeoutMs) throw new Error(`lock timeout: ${key}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
