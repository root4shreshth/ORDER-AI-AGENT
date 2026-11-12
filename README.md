# Wishluck — AI Order Ops & Customer Support Agent

An AI agent for an Indian D2C fashion store that:

- chats with customers in **English, Hindi and Hinglish**;
- looks up live orders and shipments;
- applies the store's **return / exchange / cancellation / COD policy in plain code**;
- confirms risky **COD** orders before they ship;
- follows up on **failed deliveries (NDR)**;
- hands difficult conversations to a **human** through a live dashboard.

**Design rule: Claude understands, the backend decides.** Claude (Anthropic API, native tool use) works out what the customer wants and calls narrowly scoped tools. Verification, policy decisions, risk scoring and every state change are deterministic TypeScript, validated with Zod, wrapped in transactions and audit-logged.

| | |
|---|---|
| Backend | Node.js 22 · Express 5 · TypeScript · Prisma 6 / PostgreSQL 16 · BullMQ / Redis 7 · Socket.IO · Zod |
| AI | Anthropic SDK, manual tool-use loop, default model `claude-haiku-5-5` (configurable) |
| Frontend | React 19 · Vite · Tailwind CSS v4 · TanStack Query · Recharts |
| Tests | Vitest + Supertest (115 tests) · 42-conversation evaluation harness |
| Infra | Docker Compose (Postgres, Redis, API, worker, web) |

---

## 1. Quick start

### Option A — Docker (one command)

```bash
cp .env.example .env          # optional: set ANTHROPIC_API_KEY=... in it
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:8080 | Support dashboard (inbox, orders, analytics, settings, audit log) |
| http://localhost:8080/chat | Customer chat widget |
| http://localhost:4000/health | API |

The backend runs the migrations and seeds the Appendix A data on first boot.

### Option B — local development

Requires Node 22+ and Docker (for Postgres and Redis only).

```bash
npm install
docker compose up -d postgres redis
cp .env.example backend/.env           # add ANTHROPIC_API_KEY here
cp frontend/.env.example frontend/.env
npm run db:migrate                     # prisma migrate dev
npm run seed
```

Then run these in three terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:worker
```

```bash
npm run dev:frontend
```

The dashboard runs at http://localhost:5173 and the customer chat at http://localhost:5173/chat.

### Claude credentials and MOCK mode

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) in `backend/.env`, or in the root `.env` for Docker.

**Without a key, the agent runs in MOCK mode.** This is a deterministic keyword router, **not AI**. It calls the *same* tools through the *same* executor, so verification, policy, confirmations and database effects stay real. Its replies are labelled `engine: mock`, the chat shows a yellow "Demo mode" banner, and the dashboard shows "MOCK MODE — no API key". Evaluation results always state which engine produced them.

### Demo tips

- **Settings → Demo timings**: COD reminder, hold and NDR follow-up fire in seconds instead of hours.
- **Orders → Create test order**: sends a *signed* `order.created` webhook. The worker then scores the order and messages the customer.
- **Order page → Simulate a courier webhook**: triggers `picked_up`, `in_transit`, `out_for_delivery`, `delivery_failed`, `delivered` or `rto_initiated`.
- **Customer view** buttons open the chat exactly as that customer sees it.

Seeded test identities (all made up):

| Order | Phone | Scenario |
|---|---|---|
| WL10234 | 9876543210 | In transit (Appendix B #1/#2) |
| WL10235 | 9812345678 | Kurta delivered 3 days ago → L exchange (#3) |
| WL10236 | 9123456780 | Briefs, innerwear (#4) |
| WL10237 | 9988776655 | Sale tee delivered 2 days ago (#5) |
| WL10238 | 9090909090 | Shipped, so cancel is refused (#6) |
| WL10239 / WL10240 | 9765432109 / 9654321098 | Delivery failed once / twice |
| WL10248 | 8899001122 | Unshipped prepaid (cancel / address change) |
| WL10250 | 8765432190 | Unshipped high-risk COD |
| WL10253 | 8432197650 | ₹1,799 jeans → manual review |
| WL10247 | 9210987654 | Customer with 3 returns in 60 days |

`backend/prisma/seed.ts` has all 31 orders. They cover every Appendix A case: RTO, refund pending/done, out for delivery, delivered 10 days ago, already exchanged, out-of-stock size, previous COD refusal, the non-COD pincode 795001, a COD order on hold, and more.

---

## 2. Architecture

```
 Customer web chat ─┐                                   ┌─ Tools (Zod-validated, authorized per conversation)
 Store order webhook ┼─▶ Express API ──▶ Orchestrator ──┤    verify · orders · shipment · refunds · stock
 Courier webhook ────┘   (HMAC, Zod,     guards → Claude │    policy checks · pincode/COD · catalogue
                          idempotency)   tool loop       │    propose/confirm action · handover
        │                     │              │           └─▶ Domain services (transactions, audit log)
        ▼                     ▼              ▼                 └─▶ Mock courier API (timeouts + retries)
   webhook_events        PostgreSQL ◀───────┘
   (unique event id)          ▲
        │                     │
        └──▶ BullMQ (Redis) ──┴─ worker: order ingest · COD confirm/reminder/hold ·
                                         NDR outreach / no-response escalation · courier dispatch
   Redis pub/sub ──▶ Socket.IO ──▶ React dashboard (live inbox) + customer widget
```

- **Modular monolith** with two processes: the API and a BullMQ worker.
- **Customer chat runs inline** in the API request, under a per-conversation Redis lock. Customers wait for one reply, so queueing it would only add latency.
- **Everything time-based or external goes through the queue**: webhook processing, COD messages/reminders/holds, NDR follow-ups and courier webhooks. Job ids are deterministic (`cod-reminder-<orderId>`, `ndr-outreach-<eventId>`, …), so a job can never be scheduled twice. Every handler re-reads current state first, so stale or retried jobs do nothing.
- Code map:
  - `backend/src/policies` — the deterministic store policy
  - `backend/src/risk` — the COD risk scorer
  - `backend/src/agent` — the orchestrator, tools, prompts and guards
  - `backend/src/modules` — orders, COD, NDR, conversations, tickets, analytics, settings, audit
  - `backend/src/webhooks` and `backend/src/jobs`
  - `frontend/src/pages` — the dashboard screens and the chat widget

### Why these choices

| Choice | Why |
|---|---|
| PostgreSQL + Prisma | Relational integrity across orders, items, shipments, tickets and audit. Unique constraints do the idempotency work. Typed client. |
| BullMQ | Delayed jobs (2h reminder, 24h hold), retries with backoff, and deduplication by job id. |
| Express + Socket.IO | Small, well understood, and the live inbox is required. A Redis pub/sub relay lets the worker push events too. |
| Manual Claude tool loop (not the beta tool runner) | Gates are needed *between* iterations: stop on handover, iteration cap, failure counting, a trace per call. |
| Haiku 5.5 by default | Cheapest per chat (the brief asks for cost per chat). Switch with `ANTHROPIC_MODEL=claude-sonnet-5-5` / `claude-opus-5-5`. |

---

## 3. How the agent works

One customer turn goes through `backend/src/agent/orchestrator.ts`:

1. **Lock and save.** Lock the conversation and save the customer message.
2. **Muted if a human owns the chat.** In `NEEDS_HUMAN` or `HUMAN_HANDLING` the message is stored and **no AI reply** is produced.
3. **Deterministic escalation guard** (EN / HI / Hinglish lexicon). Legal threat or consumer court, public complaint, request for a person, clear anger or bulk orders lead to an immediate handover. Claude writes the ticket note through structured output, with a template fallback.
4. **Claude tool loop** (`agent/llm/claude.ts`).
   - The system prompt is frozen and cacheable.
   - Per-turn facts travel in a `<context>` block: today's date, verified orders, active COD/NDR flow, pending action, and guard flags.
   - The loop runs with adaptive thinking at effort `low`, a 20s timeout and 2 retries, up to 6 iterations.
5. **Post-guards.**
   - Handover requested by a tool leads to a ticket.
   - A verification lockout leads to a handover.
   - An LLM failure (refusal, timeout) or 2 system tool failures produce a safe "couldn't fetch the details, callback?" reply. A second consecutive failure hands the chat to a person.
6. **Ownership re-check inside a transaction** right before saving the reply. If a human took over mid-generation, the AI reply is dropped and audited.

### Tools (`agent/tools/registry.ts`)

| Tool | Notes |
|---|---|
| `verify_customer` | Order number + the phone on that order. 3 failures → handover. |
| `get_order_details`, `get_shipment_status`, `get_refund_status` | Verified orders only |
| `check_return_eligibility`, `check_exchange_eligibility`, `check_cancellation_eligibility` | Wrap the policy functions |
| `check_pincode`, `get_product_info`, `check_stock`, `get_policy_info` | Public information |
| `respond_cod_confirmation` | CONFIRM / PAY_ONLINE / EDIT_ADDRESS |
| `propose_action` → `confirm_action` / `cancel_action` | All mutations |
| `handover_to_human` | reason, mood, 2–3 line summary, suggested reply |

**There is no refund-issuing tool.** The model cannot move money.

### Safety model

- **Identity is never model-controlled.** Tools take no customer id. Every order tool checks `order_number ∈ conversation.verifiedOrderNumbers`. A conversation verified for WL10234 gets `NOT_VERIFIED` for WL10235. There is no lookup by phone, so data leakage across customers is not reachable.
- **Every tool input is re-validated with Zod** before running. Unknown tools and bad arguments return structured errors.
- **Confirmation protocol.** `propose_action` re-runs the policy and stores a `PendingAction` bound to the order, item and parameters, with a 30-minute expiry. `confirm_action` only executes when all of these hold:
  - the action was proposed in an **earlier turn**;
  - the customer's latest message is a clear **yes** (deterministic detector covering yes / haan / theek hai / हाँ …);
  - the action has not expired;
  - the service's own transaction passes the policy and state re-check.

  The action is claimed atomically, so it can never run twice.
- **Prompt injection.** Customer text is untrusted data. Injection and data-probe patterns are flagged in the context and in the audit log. The backend enforces everything regardless of what the model says.
- **Grounding.** Order, shipment, refund and stock facts must come from a tool result in that turn. The evaluation harness checks this automatically (see §8).

---

## 4. Policy logic (`backend/src/policies/index.ts`)

These are pure functions with unit tests. They implement Appendix A exactly:

| Area | Rule |
|---|---|
| Returns | Within 7 days of delivery, unused with tags. Innerwear never. Sale items: size exchange only, no refund. |
| Exchange | Within 7 days, live stock for the new size (reserved atomically), one exchange per item. |
| Cancellation | Free before shipping. After shipping: refuse delivery (prepaid refund minus ₹99) or return after delivery. |
| Refunds | Prepaid → original method, 5–7 working days after QC. COD → bank transfer or store credit (customer picks). |
| COD | ₹299–₹4,999, ₹49 fee, not on non-COD pincodes. 5% off the item value when switching to prepaid. |
| Shipping | Free above ₹999, else ₹79. Metro 2–4 days, rest of India 4–7, North East and J&K 6–9. |
| Manual review | Refund/goodwill above ₹1,500 (configurable), damage claim without a photo, 3+ returns in 60 days. These go to a human, never an auto-decision. |
| Address change | Only before dispatch. The new pincode must be serviceable, and COD-capable if the order is COD. |
| NDR date | Tomorrow to +3 days (IST calendar days). |

Risk is not eligibility: a high-risk COD order is still allowed and simply gets a stronger confirmation plus a prepaid offer.

## 5. COD risk score (`backend/src/risk/codRisk.ts`)

A rules-based score from 0 to 100. Every signal stores a plain-language reason, shown on the order page. Weights and bands are editable in **Settings**.

| Signal | Points |
|---|---|
| First order from this phone | +15 |
| Order value above ₹3,000 | +15 |
| Incomplete address (no house/flat number, very short) | +20 |
| Landmark-only address ("near Shiv mandir", "mandir ke paas") | +15 |
| Previous COD refusal / RTO on this phone | +25 |
| Other COD orders from this phone in the last 24h | +15 |
| Repeat customer with a successful delivery | −15 |
| 2+ successful deliveries | −10 |

Bands: **0–29 low**, **30–59 medium**, **60–100 high**. Appendix B #7 (₹4,546, "near Shiv mandir", first-time buyer) scores **65 → HIGH**.

**COD lifecycle:**

1. Signed webhook arrives; the worker scores the order.
2. The confirmation is sent within seconds. It shows the order summary, the amount to pay, and four buttons: Confirm / Cancel / Edit address / Pay online & get 5% off (demo payment link).
3. One reminder after 2h, then **ON_HOLD** after 24h (both configurable).

Free-text replies go to the agent. Responses are conditional updates on `status + version`: concurrent Confirm and Cancel produce one winner and a 409 for the other. A late "Confirm" releases a held order explicitly.

## 6. Failed deliveries (NDR)

The mock courier (`backend/src/courier/mockCourier.ts`) keeps a timeline per AWB and sends **HMAC-signed webhooks**. When a `delivery_failed` event arrives:

1. It is deduplicated by event id, the attempt count goes up, and the timeline and order note are updated.
2. Within seconds or minutes, the customer gets a message with the courier's reason and the available options.
3. The agent captures one of:
   - a **new date within 3 days**;
   - a **corrected address or landmark** (pincode re-checked);
   - an **alternate phone**;
   - **"don't want it"** — the reason is recorded and the order is marked RTO.
4. After the customer says yes, the update goes to the courier REST API (4s timeout, 3 retries with backoff). The courier reference is noted on the order and audited.
5. If **2 attempts failed and the customer hasn't responded**, a handover ticket is created.

You can inject failures or latency with `POST /mock-courier/config` (`{ "failNext": 5 }`). The agent then answers safely, and the pending action is marked `FAILED` with nothing changed.

## 7. Handover rules

| Trigger | Where |
|---|---|
| Asks for a person, legal / consumer-court threat, threat to post online, clear anger (lexicon, shouting, "!!!"), bulk orders | Deterministic guard, before the LLM |
| Refund/goodwill above ₹1,500, manual-review policy, damage claim without photo, unclear after one clarifying question | Claude via `handover_to_human` (plus the policy tool result) |
| 3 failed verifications | Tool lockout, then forced handover |
| Same issue failed twice / tool keeps failing / LLM down twice | Orchestrator failure counter |
| 2 failed delivery attempts with no response | NDR worker job |

Every rule can be toggled in Settings.

A handover does the following:

- moves the chat to `NEEDS_HUMAN`;
- tells the customer, in their language, that someone will join;
- creates a ticket with a 2–3 line summary, order context, mood, tools called, and an editable suggested reply.

The AI stays silent until a human explicitly hands the chat back ("Return to AI").

## 8. Duplicate webhooks and idempotency

1. **HMAC-SHA256 over the raw body**, compared in constant time. A bad signature gets 401.
2. **Zod schema** validation.
3. **`INSERT webhook_events` with UNIQUE(source, event_id).** A replay returns `200 {"status":"duplicate"}` and enqueues nothing.
4. A job is enqueued with `jobId = event id`, and the webhook is ACKed with 202.
5. **Domain-level idempotency** as a second line of defence:
   - unique `ShipmentEvent.externalEventId`;
   - one `CodConfirmation` per order;
   - an `NDR_OUTREACH_SENT` marker per event;
   - "sent" timestamps claimed with conditional updates;
   - deterministic BullMQ job ids.

Integration tests cover all of this: the same order and courier webhook replayed and the jobs re-run produce exactly one order, one COD record, one confirmation message, one timeline event and one NDR message.

**Audit log.** Every change by the agent, system, courier or staff stores actor, action, entity, and before/after values. Phones, addresses and emails are masked (`98XXXXXX10`, `Flat ***`), and the pino logger masks them too.

---

## 9. Testing

```bash
npm test
```

This runs 115 Vitest tests:

- **82 unit tests**: policy, risk, masking, HMAC, safety, language and yes/no detection.
- **33 integration tests**: Supertest against an isolated `wishluck_test` database and queue.

Before the first run, create the test database:

```bash
docker compose exec postgres psql -U wishluck -c "CREATE DATABASE wishluck_test"
```

```bash
DATABASE_URL=postgresql://wishluck:wishluck@localhost:5455/wishluck_test npx prisma migrate deploy --schema backend/prisma/schema.prisma
```

The integration tests assert **database state and tool execution**, not reply text. They cover:

- duplicate and forged webhooks;
- concurrent COD responses;
- a late confirm after hold;
- prepaid conversion maths;
- NDR dedupe, reschedule, the 4-day rejection, escalation, and courier outage;
- every Appendix B chat case;
- the confirmation protocol (same turn, no clear yes, expiry);
- cross-customer access, Zod rejection, manual review;
- takeover muting;
- LLM outage fallback and handover;
- masked audit values.

### Evaluation: 42 test conversations

```bash
npm run eval
```

It needs the backend and worker running, and it re-seeds the DB. Pass scenario ids to run a subset, e.g. `npm run eval -- S01 R01`.

`backend/eval/scenarios.ts` holds 42 scenarios: all 12 Appendix B cases plus 30 more across support, returns, cancellation, COD, NDR and safety.

Each scenario runs through the **real HTTP API** (chat, signed webhooks, courier events, worker) and records:

- what the customer wanted;
- the expected tools and outcome;
- the tools actually called;
- the **DB state**;
- pass/fail with reasons.

An automatic **grounding check** fails any reply that states an order number, AWB, ₹ amount or date that doesn't appear in that conversation's tool outputs (the only exceptions are policy constants such as ₹49 and ₹299).

**Latest run on real Claude (`claude-haiku-5-5`): 41/42 passed, 12/12 Appendix B, 4/4 injection and data-leak cases, ~3.1 s per reply, ~$0.0015 per chat.** The one failure, and the history of what earlier runs found and how it was fixed, are explained in the report.

Results go to [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md):

- understood, right tools, right decision;
- ungrounded-fact cases;
- injection and data-leak results;
- average and p95 latency;
- average LLM cost per chat.

---

## 10. API

| Method | Path | |
|---|---|---|
| POST | `/api/chat/start` | New customer conversation → `{conversationId, token}` |
| POST | `/api/chat/:id/messages` | Customer message (header `x-chat-token`) → agent reply |
| POST | `/api/chat/:id/quick-reply` | COD / NDR buttons |
| POST | `/webhooks/orders` | `order.created` (header `x-wishluck-signature: sha256=<hex>`) |
| POST | `/webhooks/courier` | Courier status (header `x-courier-signature`) |
| GET | `/api/conversations[?status=]` · `/api/conversations/:id` | Inbox / transcript + tool trace + ticket |
| POST | `/api/conversations/:id/{takeover,release,resolve,reopen,reply}` | Ownership |
| GET | `/api/orders[?filter=&q=]` · `/api/orders/:orderNumber` | Orders, risk, timeline, audit |
| POST | `/api/orders/test` · `/api/orders/:no/courier-events` · `/api/orders/:no/cod-response` | Test controls |
| GET | `/api/analytics` · `/api/audit-logs` · `/api/tickets` · `/api/system` | |
| GET/PUT | `/api/settings` | Timings, risk weights/thresholds, handover rules |
| * | `/mock-courier/...` | Mock courier REST API (timeline, instructions, fault injection) |

Admin endpoints require `x-admin-key` (`ADMIN_API_KEY`).

---

## 11. Known issues and limitations

- **No real authentication for dashboard staff**: a shared admin key only, and it is baked into the frontend bundle. It is fine for a take-home; production needs SSO and roles.
- **The customer chat token lives in `localStorage`**. Proactive COD/NDR conversations are reached through a token link, simulating an SMS/WhatsApp link to the phone on the order. There is no OTP.
- **The language detector is heuristic** (Devanagari plus a Hinglish word list). Claude handles language itself; the detector only drives templates and hints.
- **Mock courier and payment are simulated.** The payment link is a demo page and the order is marked prepaid at conversion time, not after payment.
- **Analytics are computed on the fly**, which is fine at this scale. Large volumes would need materialised aggregates.
- **The MOCK engine is deliberately simple**: it covers the scripted flows, not open conversation. Judge the agent's language understanding with a real key.
- **The eval re-seeds the database** configured in `backend/.env`. Don't point it at data you care about.

## 12. What I'd do next

- WhatsApp Cloud API channel on the same orchestrator, with OTP verification instead of order+phone.
- Shopify dev store webhooks in place of the seed.
- Per-intent model routing: Haiku for routine turns, a larger model for disputes.
- An LLM-based address-quality signal for the risk score.
- A dead-letter queue view with replay in the dashboard.
- Role-based staff auth.
- Larger, regression-tracked eval runs in CI.

Source documents (assignment PDF and solution blueprint) are intentionally kept out of the repository.
