import { prisma } from "../../lib/prisma.js";

/** All numbers are computed from live database rows (seeded + whatever happened in the demo). */
export async function getAnalytics() {
  const [convs, tickets, cods, shipmentsSaved, intents, aiMsgs, byDay] = await Promise.all([
    prisma.conversation.findMany({
      where: { messages: { some: { role: "CUSTOMER" } } },
      select: { id: true, status: true, firstResponseMs: true, _count: { select: { tickets: true } } },
    }),
    prisma.supportTicket.groupBy({ by: ["reason"], _count: { _all: true } }),
    prisma.codConfirmation.findMany({ select: { status: true, riskBand: true, sentAt: true } }),
    prisma.shipment.count({ where: { ndrRespondedAt: { not: null }, status: { not: "RTO_INITIATED" } } }),
    prisma.message.groupBy({ by: ["intent"], where: { role: "CUSTOMER", intent: { not: null } }, _count: { _all: true } }),
    prisma.message.findMany({ where: { role: "AI", engine: { in: ["claude", "mock"] } }, select: { conversationId: true, costUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, latencyMs: true, engine: true } }),
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM "Message" WHERE role = 'CUSTOMER' AND "createdAt" > now() - interval '14 days'
      GROUP BY 1 ORDER BY 1`,
  ]);

  const total = convs.length;
  const withoutHuman = convs.filter((c) => c._count.tickets === 0 && c.status !== "HUMAN_HANDLING" && c.status !== "NEEDS_HUMAN").length;
  const frt = convs.map((c) => c.firstResponseMs).filter((x): x is number => x !== null);

  const codSent = cods.filter((c) => c.sentAt);
  const codBy = (s: string) => cods.filter((c) => c.status === s).length;
  const confirmed = codBy("CONFIRMED") + codBy("CONVERTED_PREPAID");
  const responded = confirmed + codBy("CANCELLED");
  const savedCod = codBy("CONVERTED_PREPAID") + cods.filter((c) => c.status === "CONFIRMED" && c.riskBand !== "LOW").length;

  const costConvs = new Set(aiMsgs.filter((m) => m.engine === "claude").map((m) => m.conversationId));
  const totalCost = aiMsgs.reduce((s, m) => s + (m.costUsd ?? 0), 0);
  const lat = aiMsgs.map((m) => m.latencyMs).filter((x): x is number => x !== null);

  return {
    generatedAt: new Date().toISOString(),
    conversations: {
      total,
      resolvedWithoutHuman: withoutHuman,
      resolvedWithoutHumanPct: total ? Math.round((withoutHuman / total) * 1000) / 10 : 0,
      byStatus: Object.fromEntries(["AI_HANDLING", "NEEDS_HUMAN", "HUMAN_HANDLING", "RESOLVED"].map((s) => [s, convs.filter((c) => c.status === s).length])),
    },
    handoversByReason: tickets.map((t) => ({ reason: t.reason, count: t._count._all })).sort((a, b) => b.count - a.count),
    cod: {
      total: cods.length,
      sent: codSent.length,
      confirmed,
      cancelled: codBy("CANCELLED"),
      convertedToPrepaid: codBy("CONVERTED_PREPAID"),
      onHold: codBy("ON_HOLD"),
      awaiting: codBy("AWAITING") + codBy("ADDRESS_EDIT_REQUESTED"),
      confirmationRatePct: responded ? Math.round((confirmed / responded) * 1000) / 10 : 0,
      byRiskBand: ["LOW", "MEDIUM", "HIGH"].map((b) => ({ band: b, count: cods.filter((c) => c.riskBand === b).length })),
    },
    savedFromRto: {
      total: savedCod + shipmentsSaved,
      codConvertedOrRiskyConfirmed: savedCod,
      ndrRecovered: shipmentsSaved,
      definition: "COD orders switched to prepaid or medium/high-risk COD orders confirmed by the customer, plus failed deliveries where the customer gave a new date/address/phone (not RTO).",
    },
    firstResponse: {
      avgMs: frt.length ? Math.round(frt.reduce((a, b) => a + b, 0) / frt.length) : null,
      medianMs: frt.length ? [...frt].sort((a, b) => a - b)[Math.floor(frt.length / 2)]! : null,
      samples: frt.length,
    },
    aiLatency: { avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, samples: lat.length },
    commonRequests: intents.map((i) => ({ intent: i.intent ?? "unknown", count: i._count._all })).sort((a, b) => b.count - a.count).slice(0, 10),
    llm: {
      totalCostUsd: Math.round(totalCost * 1e6) / 1e6,
      claudeConversations: costConvs.size,
      avgCostPerChatUsd: costConvs.size ? Math.round((totalCost / costConvs.size) * 1e6) / 1e6 : 0,
      inputTokens: aiMsgs.reduce((s, m) => s + (m.inputTokens ?? 0), 0),
      outputTokens: aiMsgs.reduce((s, m) => s + (m.outputTokens ?? 0), 0),
      cacheReadTokens: aiMsgs.reduce((s, m) => s + (m.cacheReadTokens ?? 0), 0),
      repliesByEngine: { claude: aiMsgs.filter((m) => m.engine === "claude").length, mock: aiMsgs.filter((m) => m.engine === "mock").length },
    },
    volume: byDay.map((d) => ({ day: d.day.toISOString().slice(0, 10), messages: Number(d.count) })),
  };
}
