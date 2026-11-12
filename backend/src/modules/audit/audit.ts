import type { Prisma } from "@prisma/client";
import type { Db } from "../../lib/prisma.js";
import { maskDeep } from "../../lib/mask.js";

export type Actor = "ai" | "system" | "customer" | "courier" | `human:${string}`;

export interface AuditEntry {
  actor: Actor;
  entityType: "order" | "shipment" | "cod" | "conversation" | "ticket" | "return" | "refund" | "settings" | "webhook" | "courier";
  entityId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  meta?: unknown;
}

const json = (v: unknown): Prisma.InputJsonValue | undefined =>
  v === undefined ? undefined : (JSON.parse(JSON.stringify(maskDeep(v))) as Prisma.InputJsonValue);

/** Every change the agent/system makes is recorded with masked before/after values. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actor: e.actor,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      oldValue: json(e.oldValue),
      newValue: json(e.newValue),
      meta: json(e.meta),
    },
  });
}
