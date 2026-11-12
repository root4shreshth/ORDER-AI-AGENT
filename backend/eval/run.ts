/**
 * Evaluation runner: drives every scenario through the REAL HTTP API of a running backend +
 * worker (so webhooks, queues and the LLM are all exercised), then checks tool traces and the
 * database. Re-seeds before each scenario for isolation.
 *
 *   npm run dev & npm run worker:dev     (backend + worker running)
 *   npm run eval [-- S01 R01 …]          (optional scenario ids)
 *
 * WARNING: re-seeds the database configured in backend/.env.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { seed } from "../prisma/seed.js";
import { DEMO_TIMINGS, DEFAULT_SETTINGS } from "../src/modules/settings/settings.js";
import { SCENARIOS, languageOk, type Ctx, type Scenario } from "./scenarios.js";

const API = process.env.EVAL_API_URL ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "change-me-admin-key";
const db = new PrismaClient();
const H = { "content-type": "application/json", "x-admin-key": ADMIN_KEY, "x-agent-name": "Eval" };

async function http<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = H): Promise<{ status: number; body: T; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  return { status: res.status, body: (await res.json().catch(() => null)) as T, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- grounding check
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const POLICY_AMOUNTS = new Set(["299", "4999", "49", "99", "1500", "79", "999", "5000"]);
const normMoney = (s: string) => s.replace(/[₹,\s]/g, "").replace(/\.0+$/, "");

function extractFacts(text: string) {
  const facts: { kind: string; value: string }[] = [];
  for (const m of text.matchAll(/\bWL\d{4,8}\b/g)) facts.push({ kind: "order", value: m[0] });
  for (const m of text.matchAll(/\bWS\d{5,}\b/g)) facts.push({ kind: "awb", value: m[0] });
  for (const m of text.matchAll(/₹\s?\d[\d,]*(\.\d+)?/g)) facts.push({ kind: "amount", value: normMoney(m[0]) });
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+(\d{4}))?/gi)) {
    facts.push({ kind: "date", value: `${Number(m[1])} ${m[2]!.slice(0, 3).toLowerCase()}` });
  }
  return facts;
}

function sourceCorpus(conv: ConvDetail): string {
  const parts: string[] = [];
  for (const t of conv.toolCalls) parts.push(JSON.stringify(t.input), JSON.stringify(t.output));
  for (const m of conv.messages) if (m.role === "CUSTOMER" || m.engine === "template" || m.role === "HUMAN") parts.push(m.content);
  for (const p of conv.pendingActions) parts.push(p.summary);
  const today = Date.now() + 5.5 * 3600e3;
  for (let i = 0; i <= 4; i++) {
    const d = new Date(today + i * 86400e3);
    parts.push(`${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`);
  }
  return parts.join("\n");
}

function ungroundedFacts(conv: ConvDetail): string[] {
  const corpus = sourceCorpus(conv);
  const corpusLower = corpus.toLowerCase();
  const corpusMoney = new Set([...corpus.matchAll(/₹\s?\d[\d,]*(\.\d+)?/g)].map((m) => normMoney(m[0])));
  for (const m of corpus.matchAll(/"(?:amount|total|refund_amount|price|items_total)":\s*"?₹?([\d,.]+)/g)) corpusMoney.add(normMoney(m[1]!));
  const dateForms = (v: string) => {
    const [d = "", mon = ""] = v.split(" ");
    return [`${d} ${mon}`, `${d.padStart(2, "0")} ${mon}`];
  };
  const out: string[] = [];
  for (const m of conv.messages) {
    if (m.role !== "AI" || (m.engine !== "claude" && m.engine !== "mock")) continue;
    for (const f of extractFacts(m.content)) {
      if (f.kind === "amount") {
        if (!POLICY_AMOUNTS.has(f.value) && !corpusMoney.has(f.value)) out.push(`₹${f.value}`);
      } else if (f.kind === "date") {
        if (!dateForms(f.value).some((x) => corpusLower.includes(x))) out.push(f.value);
      } else if (!corpus.includes(f.value)) out.push(f.value);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- types
interface ConvDetail {
  id: string;
  status: string;
  customerToken: string;
  messages: { id: string; role: string; content: string; engine: string | null; costUsd: number | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null }[];
  toolCalls: { toolName: string; input: unknown; output: { ok: boolean; code?: string }; createdAt: string }[];
  tickets: { reason: string; summary: string }[];
  pendingActions: { summary: string }[];
}

interface Result {
  id: string;
  appendixB?: number;
  category: string;
  title: string;
  wanted: string;
  expectedOutcome: string;
  pass: boolean;
  failures: string[];
  toolsCalled: string[];
  finalStatus: string;
  lastReply: string;
  ungrounded: string[];
  turnLatencies: number[];
  costUsd: number;
  tokens: { input: number; output: number };
  understood: boolean;
  correctTools: boolean;
  correctDecision: boolean;
  safety?: string;
  error?: string;
}

async function applyDemoTimings() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.cod, DEMO_TIMINGS.cod, { reminderDelaySec: 600, holdDelaySec: 1200 });
  Object.assign(settings.ndr, DEMO_TIMINGS.ndr, { noResponseDelaySec: 8 });
  const r = await http("PUT", "/api/settings", settings);
  if (r.status !== 200) throw new Error(`settings update failed: ${r.status}`);
}

async function runScenario(s: Scenario): Promise<Result> {
  await seed();
  await applyDemoTimings();
  await new Promise((r) => setTimeout(r, 2100)); // server settings cache TTL

  let chat: { id: string; token: string } | null = null;
  const ctx: Ctx = { db, conversationId: "", replies: [], tools: [], status: "" };
  const latencies: number[] = [];
  const failures: string[] = [];

  const ensureChat = async () => {
    if (!chat) {
      const r = await http<{ conversationId: string; token: string }>("POST", "/api/chat/start", {});
      chat = { id: r.body.conversationId, token: r.body.token };
    }
    return chat;
  };

  for (const step of s.steps) {
    if ("say" in step) {
      const c = await ensureChat();
      const r = await http<{ reply: { content: string } | null; status: string }>("POST", `/api/chat/${c.id}/messages`, { text: step.say }, { "content-type": "application/json", "x-chat-token": c.token });
      if (r.status !== 200) throw new Error(`chat HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      latencies.push(r.ms);
      if (r.body.reply) ctx.replies.push(r.body.reply.content);
    } else if ("quick" in step) {
      const c = await ensureChat();
      await http("POST", `/api/chat/${c.id}/quick-reply`, { choice: step.quick }, { "content-type": "application/json", "x-chat-token": c.token });
    } else if ("wait" in step) {
      await new Promise((r) => setTimeout(r, step.wait));
    } else if ("createTestOrder" in step) {
      const r = await http<{ orderNumber: string }>("POST", "/api/orders/test", { preset: step.createTestOrder });
      if (r.status !== 202) throw new Error(`test order failed ${r.status}`);
      ctx.createdOrder = r.body.orderNumber;
    } else if ("courier" in step) {
      const r = await http("POST", `/api/orders/${step.courier.order}/courier-events`, { type: step.courier.type, reason: step.courier.reason });
      if (r.status !== 202) throw new Error(`courier event failed ${r.status}`);
    } else if ("useOrderConversation" in step) {
      const no = step.useOrderConversation === "$created" ? ctx.createdOrder! : step.useOrderConversation;
      const r = await http<{ conversations: { id: string; customerToken: string }[] }>("GET", `/api/orders/${no}`);
      const conv = r.body.conversations[0];
      if (!conv) throw new Error(`no proactive conversation for ${no} (worker running?)`);
      chat = { id: conv.id, token: conv.customerToken };
    }
  }

  const c = await ensureChat();
  ctx.conversationId = c.id;
  const conv = (await http<ConvDetail>("GET", `/api/conversations/${c.id}`)).body;
  ctx.status = conv.status;
  ctx.tools = conv.toolCalls.map((t) => ({ name: t.toolName, input: t.input, output: t.output }));
  const names = ctx.tools.map((t) => t.name);
  const lastReply = ctx.replies[ctx.replies.length - 1] ?? conv.messages.filter((m) => m.role === "AI").at(-1)?.content ?? "";

  let correctTools = true;
  let understood = true;
  let correctDecision = true;
  for (const t of s.mustCall ?? []) if (!names.includes(t)) (failures.push(`expected tool ${t} not called`), (correctTools = false));
  for (const t of s.mustNotCall ?? []) if (names.includes(t)) (failures.push(`forbidden tool ${t} was called`), (correctTools = false));
  if (s.noTools && names.length) (failures.push(`expected no tools, got ${names.join(", ")}`), (correctTools = false));
  if (s.expectStatus && conv.status !== s.expectStatus) (failures.push(`status ${conv.status}, expected ${s.expectStatus}`), (correctDecision = false));
  for (const re of s.replyMatches ?? []) if (!ctx.replies.some((r) => re.test(r)) && !re.test(lastReply)) (failures.push(`no reply matched ${re}`), (understood = false));
  for (const re of s.replyNotMatches ?? []) if (ctx.replies.some((r) => re.test(r))) (failures.push(`reply matched forbidden ${re}`), (correctDecision = false));
  if (s.replyLanguage && !languageOk(lastReply, s.replyLanguage)) (failures.push(`reply not in expected language (${s.replyLanguage})`), (understood = false));
  if (s.db) {
    const r = await s.db(ctx);
    if (r !== true) (failures.push(`DB check: ${r}`), (correctDecision = false));
  }
  const ungrounded = ungroundedFacts(conv);
  if (ungrounded.length) failures.push(`ungrounded facts in reply: ${ungrounded.join(", ")}`);

  const ai = conv.messages.filter((m) => m.role === "AI");
  return {
    id: s.id,
    appendixB: s.appendixB,
    category: s.category,
    title: s.title,
    wanted: s.wanted,
    expectedOutcome: s.expectedOutcome,
    pass: failures.length === 0,
    failures,
    toolsCalled: ctx.tools.map((t) => `${t.name}${t.output?.code ? `→${t.output.code}` : ""}`),
    finalStatus: conv.status,
    lastReply,
    ungrounded,
    turnLatencies: latencies,
    costUsd: ai.reduce((a, m) => a + (m.costUsd ?? 0), 0),
    tokens: { input: ai.reduce((a, m) => a + (m.inputTokens ?? 0), 0), output: ai.reduce((a, m) => a + (m.outputTokens ?? 0), 0) },
    understood,
    correctTools,
    correctDecision,
    safety: s.safety,
  };
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function main() {
  const only = process.argv.slice(2).filter((a) => /^[A-Z]\d{2}$/.test(a));
  const list = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  const sys = (await http<{ engine: string; model: string }>("GET", "/api/system")).body;
  console.log(`Running ${list.length} scenarios against ${API} — engine: ${sys.engine} (${sys.model})\n`);

  const results: Result[] = [];
  for (const s of list) {
    try {
      const r = await runScenario(s);
      results.push(r);
      console.log(`${r.pass ? "PASS" : "FAIL"}  ${s.id}${s.appendixB ? ` (B#${s.appendixB})` : ""}  ${s.title}${r.pass ? "" : `\n      ${r.failures.join("\n      ")}`}`);
    } catch (e) {
      results.push({ id: s.id, appendixB: s.appendixB, category: s.category, title: s.title, wanted: s.wanted, expectedOutcome: s.expectedOutcome, pass: false, failures: [`runner error: ${(e as Error).message}`], toolsCalled: [], finalStatus: "?", lastReply: "", ungrounded: [], turnLatencies: [], costUsd: 0, tokens: { input: 0, output: 0 }, understood: false, correctTools: false, correctDecision: false, error: (e as Error).message });
      console.log(`ERROR ${s.id} ${s.title}: ${(e as Error).message}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const lat = results.flatMap((r) => r.turnLatencies);
  const avgLat = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  const p95 = lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.95)]! : 0;
  const chatsWithCost = results.filter((r) => r.costUsd > 0);
  const avgCost = chatsWithCost.length ? chatsWithCost.reduce((a, r) => a + r.costUsd, 0) / chatsWithCost.length : 0;
  const appB = results.filter((r) => r.appendixB);
  const safety = results.filter((r) => r.safety);
  const ungroundedCases = results.filter((r) => r.ungrounded.length);

  const md: string[] = [];
  md.push(`# Evaluation results`, "");
  md.push(`- **Run at:** ${new Date().toISOString()}`);
  md.push(`- **Engine:** ${sys.engine === "claude" ? `Claude (\`${sys.model}\`)` : "MOCK (rule-based, NOT an LLM — no API key was configured)"}`);
  md.push(`- **Scenarios:** ${results.length} (${appB.length} from Appendix B)`);
  md.push("");
  md.push(`| Metric | Result |`, `|---|---|`);
  md.push(`| Passed (all checks) | **${passed}/${results.length}** (${pct(passed, results.length)}) |`);
  md.push(`| Appendix B passed | ${appB.filter((r) => r.pass).length}/${appB.length} |`);
  md.push(`| Understood the request | ${pct(results.filter((r) => r.understood).length, results.length)} |`);
  md.push(`| Called the right tools | ${pct(results.filter((r) => r.correctTools).length, results.length)} |`);
  md.push(`| Right policy decision / DB state | ${pct(results.filter((r) => r.correctDecision).length, results.length)} |`);
  md.push(`| Replies with an order detail not from a tool | ${ungroundedCases.length} case(s)${ungroundedCases.length ? ` — ${ungroundedCases.map((r) => r.id).join(", ")}` : ""} |`);
  md.push(`| Prompt-injection & data-leak cases passed | ${safety.filter((r) => r.pass).length}/${safety.length} |`);
  md.push(`| Avg response time per turn | ${avgLat} ms (p95 ${p95} ms) |`);
  md.push(`| Avg LLM cost per chat | ${sys.engine === "claude" ? `$${avgCost.toFixed(5)} (over ${chatsWithCost.length} chats that called the LLM)` : "$0 (mock)"} |`);
  md.push("");
  md.push(`## All scenarios`, "");
  md.push(`| # | B# | Category | Customer wanted | Expected | Tools called | Result |`, `|---|---|---|---|---|---|---|`);
  for (const r of results) {
    md.push(`| ${r.id} | ${r.appendixB ?? ""} | ${r.category} | ${esc(r.wanted)} | ${esc(r.expectedOutcome)} | ${esc(r.toolsCalled.join(", ") || "—")} | ${r.pass ? "✅ pass" : "❌ fail"} |`);
  }
  const failed = results.filter((r) => !r.pass);
  md.push("", `## Failures (${failed.length})`, "");
  if (!failed.length) md.push("None.");
  for (const r of failed) {
    md.push(`### ${r.id} — ${r.title}`, "");
    for (const f of r.failures) md.push(`- ${f}`);
    md.push(`- Final status: \`${r.finalStatus}\``);
    md.push(`- Last reply: > ${esc(r.lastReply).slice(0, 400)}`, "");
  }
  md.push("", "_Generated by `npm run eval` (backend/eval/run.ts). Each scenario re-seeds the database, drives the real HTTP API (chat, webhooks, courier events) with the worker running, then checks tool traces and database state._");

  mkdirSync("eval/output", { recursive: true });
  writeFileSync("eval/output/results.json", JSON.stringify({ engine: sys, results }, null, 2));
  mkdirSync("../docs", { recursive: true });
  writeFileSync("../docs/TEST_RESULTS.md", md.join("\n"));
  console.log(`\n${passed}/${results.length} passed · avg ${avgLat} ms/turn · avg cost/chat $${avgCost.toFixed(5)} · written to ${list.length === SCENARIOS.length ? "docs/TEST_RESULTS.md" : "eval/output/subset-results.md"}`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
