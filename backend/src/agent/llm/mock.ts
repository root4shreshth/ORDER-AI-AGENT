/**
 * MOCK engine — used only when no ANTHROPIC_API_KEY is configured (or LLM_MODE=mock).
 * It is NOT AI: a deterministic keyword/entity router that calls the SAME tools through the
 * SAME executor (so verification, policy, confirmation and DB effects are identical) and
 * renders template replies from tool results. Every reply it produces is labelled engine="mock".
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { addDays, isoDateIST, normalizeOrderNumber, normalizePhone } from "../../lib/format.js";
import { detectInjection, detectOtherCustomerProbe, isAffirmative, isNegative, type Lang } from "../safety.js";
import { executeTool } from "../tools/execute.js";
import type { ToolContext, ToolResult } from "../tools/context.js";
import { emptyUsage, type Engine, type EngineResult, type HistoryMessage } from "./types.js";

type Intent = "bulk" | "damage" | "status" | "cancel" | "return" | "exchange" | "address" | "refund" | "size" | "policy" | "pincode" | "cod_confirm" | "cod_pay" | "cod_edit" | "ndr" | "greeting" | "unknown";

interface MockState {
  intent?: Intent;
  orderNumber?: string;
  sku?: string;
  newSize?: string;
  awaiting?: "unused" | "refund_method" | "address" | "ndr_detail";
  phone?: string;
  unknownCount?: number;
}

const SKU_WORDS: [RegExp, string][] = [
  [/sale\s*tee|sale\s*t-?shirt/i, "WL-SAL-06"],
  [/kurta|कुर्ता/i, "WL-KUR-01"],
  [/jeans|denim|जींस/i, "WL-JNS-03"],
  [/brief|innerwear|underwear|chaddi/i, "WL-BRF-04"],
  [/tote|bag|बैग/i, "WL-BAG-05"],
  [/tee|t-?shirt|टी/i, "WL-TEE-02"],
];

function entities(text: string) {
  const order = text.match(/#?\s?\b(WL\s?-?\d{4,8})\b/i)?.[1] ?? text.match(/#(\d{5,8})\b/)?.[1];
  const phone = text.match(/(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{4}\s?\d{5})(?!\d)/)?.[1];
  const pincode = text.match(/(?<!\d)(\d{6})(?!\d)/)?.[1];
  const size = text.match(/\b(XXL|XL|L|M|S|28|30|32|34|36)\b(?:\s*size)?/)?.[1] ?? text.match(/size\s*(xxl|xl|l|m|s)\b/i)?.[1]?.toUpperCase();
  const sku = SKU_WORDS.find(([re]) => re.test(text))?.[1];
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  let date = iso;
  if (!date && /\b(tomorrow|kal)\b|कल/i.test(text)) date = isoDateIST(addDays(new Date(), 1));
  if (!date && /\b(day after tomorrow|parso|parson)\b|परसों/i.test(text)) date = isoDateIST(addDays(new Date(), 2));
  return {
    orderNumber: order ? normalizeOrderNumber(order) ?? undefined : undefined,
    phone: phone ? normalizePhone(phone) ?? undefined : undefined,
    pincode: pincode && !(phone && phone.includes(pincode)) ? pincode : undefined,
    size: size?.toUpperCase(),
    sku,
    date,
  };
}

function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/pay\s*online|prepaid|upi|card|5%/.test(t)) return "cod_pay";
  if (/edit\s*address|change\s*(the\s*)?address|deliver\s+(it\s+)?to\s+my|office\s+instead|address\s+(badal|change)|pata\s+badal|पता/.test(t)) return "address";
  if (/bulk|wholesale|quotation|quote|corporate|(d{2,})s*(pieces|pcs|units|kurtas|tees|jeans|bags)/.test(t)) return "bulk";
  if (/damage|damaged|torn|defect|broken|stain|phat(a|i)|kharab|tuta/.test(t)) return "damage";
  if (/refund\s*(kab|status|kidhar|when)|when.*refund|paisa\s*kab|पैसा\s*कब|रिफंड\s*कब/.test(t) || (/refund/.test(t) && /processed|received|credited|done|status|where|kab|mila|aaya/.test(t) && !/return|wapas/.test(t))) return "refund";
  if (/cancel|रद्द|nahi\s*chahiye|don'?t\s+want|dont\s+want|no\s+longer\s+want/.test(t)) return "cancel";
  if (/exchange|size\s*(mil|change|badal)|tight|loose|chhota|bada|badal|बदल|another\s+size|different\s+size|instead\s+of\s+(xs|s|m|l|xl|xxl|\d{2})\b/.test(t)) return "exchange";
  if (/return|wapas|वापस|refund\s+me|give.*refund/.test(t)) return "return";
  if (/(which|kaunsa|kaun\s*sa|what)\s*size|size\s*chart|\d\s*'\s*\d|\d+\s*kg|height/.test(t)) return "size";
  if (/\bcod\b|cash\s+on\s+delivery|deliver.*\d{6}|pincode/.test(t)) return "pincode";
  if (/policy|shipping\s+(charge|fee)|delivery\s+(time|charge)|how\s+many\s+days|return\s+window/.test(t)) return "policy";
  if (/where|kab\s*(aayega|ayega|aaega|milega)|kahan|status|track|कब|कहाँ|kidhar|not\s+(received|delivered)/.test(t)) return "status";
  if (/^(hi|hello|hey|namaste|hii+)\b/.test(t)) return "greeting";
  return "unknown";
}

const L = (lang: Lang, en: string, hinglish: string, hi?: string) => (lang === "hi" ? hi ?? hinglish : lang === "hinglish" ? hinglish : en);

export class MockEngine implements Engine {
  readonly name = "mock" as const;

  async run(ctx: ToolContext, history: HistoryMessage[]): Promise<EngineResult> {
    const text = ctx.customerText;
    const lang = ctx.language;
    const done = (t: string): EngineResult => ({ text: t, engine: "mock", usage: emptyUsage(), costUsd: 0 });
    const call = (name: string, input: Record<string, unknown>) => executeTool(ctx, name, input);
    const convContext = (ctx.conversation.context ?? {}) as { orderNumber?: string; flow?: string; mock?: MockState };
    const state: MockState = { ...(convContext.mock ?? {}) };
    const save = async () => {
      ctx.conversation = await prisma.conversation.update({ where: { id: ctx.conversationId }, data: { context: { ...convContext, mock: state } as unknown as Prisma.InputJsonValue } });
    };

    // 1. Security guards — refuse without calling any tool.
    if (detectInjection(text)) {
      await save();
      return done(
        L(lang,
          "Sorry, I can't do that. I can't change my rules or issue refunds outside our policy. I'm happy to help with your order status, returns, exchanges or refunds as per policy.",
          "Sorry, main ye nahi kar sakta. Main apne rules change nahi kar sakta aur policy ke bahar refund nahi de sakta. Order status, return, exchange ya refund mein madad kar sakta hoon.",
          "क्षमा करें, मैं ऐसा नहीं कर सकता। मैं अपने नियम नहीं बदल सकता और पॉलिसी से बाहर रिफंड नहीं दे सकता। ऑर्डर स्टेटस, रिटर्न या एक्सचेंज में मदद कर सकता हूँ।"),
      );
    }
    if (detectOtherCustomerProbe(text)) {
      return done(
        L(lang,
          "Sorry, I can't share details of other customers' orders. I can only help with an order once it's verified with its order number and the phone number used on it.",
          "Sorry, main kisi aur customer ke orders ki details share nahi kar sakta. Order number aur us order wale phone number se verify karne ke baad hi main madad kar sakta hoon.",
          "क्षमा करें, मैं किसी दूसरे ग्राहक के ऑर्डर की जानकारी नहीं दे सकता।"),
      );
    }

    const e = entities(text);
    let intent = detectIntent(text);

    // 2. Pending confirmation?
    const pending = await prisma.pendingAction.findFirst({ where: { conversationId: ctx.conversationId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
    if (pending && (isAffirmative(text) || isNegative(text))) {
      if (isNegative(text)) {
        await call("cancel_action", { pending_action_id: pending.id });
        state.intent = undefined;
        await save();
        return done(L(lang, "No problem — I haven't changed anything. Anything else I can help with?", "Koi baat nahi — maine kuch change nahi kiya. Aur kuch madad chahiye?", "कोई बात नहीं — मैंने कुछ नहीं बदला।"));
      }
      const r = await call("confirm_action", { pending_action_id: pending.id });
      state.intent = undefined;
      state.awaiting = undefined;
      await save();
      if (!r.ok) return done(this.failure(lang, r));
      return done(this.describeDone(lang, pending.type, r.data as Record<string, unknown>));
    }

    // 3. Flow-specific short answers (COD / NDR).
    const flow = convContext.flow;
    const flowOrder = convContext.orderNumber;
    if (flow === "COD" && flowOrder) {
      if (intent === "cod_pay") return done(this.codReply(lang, await call("respond_cod_confirmation", { order_number: flowOrder, choice: "PAY_ONLINE" })));
      if (isAffirmative(text) || /confirm/i.test(text)) return done(this.codReply(lang, await call("respond_cod_confirmation", { order_number: flowOrder, choice: "CONFIRM" })));
      if (intent === "address" && !e.pincode) {
        await call("respond_cod_confirmation", { order_number: flowOrder, choice: "EDIT_ADDRESS" });
        state.intent = "address";
        state.orderNumber = flowOrder;
        await save();
        return done(L(lang, "Sure — please share the full new address with house/flat number and the 6-digit pincode.", "Zaroor — naya poora address house/flat number aur 6-digit pincode ke saath bhejiye."));
      }
    }
    if (flow === "NDR" && flowOrder && ctx.conversation.verifiedOrderNumbers.includes(flowOrder)) {
      if (e.date) return done(await this.propose(ctx, lang, { action: "ndr_reschedule", order_number: flowOrder, date: e.date }));
      if (e.phone) return done(await this.propose(ctx, lang, { action: "ndr_alternate_phone", order_number: flowOrder, phone: e.phone }));
      if (/landmark|near|address|gali|opposite|behind/i.test(text)) {
        return done(await this.propose(ctx, lang, { action: "ndr_update_address", order_number: flowOrder, landmark: text.slice(0, 120), pincode: e.pincode }));
      }
      if (intent === "cancel") return done(await this.propose(ctx, lang, { action: "ndr_cancel_rto", order_number: flowOrder, reason: text.slice(0, 200) }));
    }

    // 4. Continue a multi-turn intent when this message only supplies missing details.
    if ((intent === "unknown" || intent === "greeting") && state.intent) intent = state.intent;
    if (state.awaiting === "unused" && (isAffirmative(text) || /unused|tags|haan|yes/i.test(text))) intent = "return";

    // 5. Public questions (no verification).
    if (intent === "pincode" && e.pincode) {
      const r = await call("check_pincode", { pincode: e.pincode });
      const d = (r.data ?? {}) as { cod_available?: boolean; delivery_estimate?: string; serviceable?: boolean };
      if (!d.serviceable) return done(L(lang, `Sorry, we don't deliver to ${e.pincode} yet.`, `Sorry, abhi hum ${e.pincode} par deliver nahi karte.`));
      return done(
        d.cod_available
          ? L(lang, `Yes, COD is available for ${e.pincode} (orders ₹299–₹4,999, ₹49 COD fee). Delivery takes ${d.delivery_estimate}.`, `Haan, ${e.pincode} par COD available hai (₹299–₹4,999 ke orders, ₹49 COD fee). Delivery ${d.delivery_estimate} mein hoti hai.`)
          : L(lang, `${r.message} You can pay online (prepaid) instead — and get delivery in ${d.delivery_estimate}.`, `${e.pincode} par COD available nahi hai. Aap prepaid (online payment) se order kar sakte hain — delivery ${d.delivery_estimate} mein.`),
      );
    }
    if (intent === "size") {
      const r = await call("get_product_info", { query: e.sku ?? text.slice(0, 60) });
      const p = (r.data as { name: string; size_chart: Record<string, string> }[])[0];
      if (!p) return done(this.failure(lang, r));
      const chart = Object.entries(p.size_chart).map(([s, d]) => `${s}: ${d}`).join("\n");
      return done(L(lang, `Here's the size chart for the ${p.name}:\n${chart}\nPick the size whose range matches your height and weight.`, `${p.name} ka size chart:\n${chart}\nApni height aur weight ke hisaab se size choose kijiye.`));
    }
    if (intent === "policy") {
      const topic = /cod/i.test(text) ? "cod" : /ship|deliver/i.test(text) ? "shipping" : /cancel/i.test(text) ? "cancellation" : /refund/i.test(text) ? "refunds" : /exchange/i.test(text) ? "exchange" : "returns";
      const r = await call("get_policy_info", { topic });
      return done(Object.values(r.data as Record<string, string>).join(" "));
    }
    if (intent === "greeting") {
      return done(L(lang, "Hi! I'm the Wishluck assistant. I can help with order status, cancellations, returns, exchanges, refunds and sizing. What do you need?", "Namaste! Main Wishluck assistant hoon. Order status, cancel, return, exchange, refund ya size mein madad kar sakta hoon. Bataiye?", "नमस्ते! मैं Wishluck असिस्टेंट हूँ। बताइए, मैं कैसे मदद करूँ?"));
    }
    if (intent === "unknown") {
      state.unknownCount = (state.unknownCount ?? 0) + 1;
      await save();
      if (state.unknownCount >= 2) {
        await call("handover_to_human", {
          reason: "UNCLEAR_REQUEST",
          mood: "confused",
          summary: `Customer's request could not be understood after a clarifying question. Last message: "${text.slice(0, 200)}".`,
          suggested_reply: L(lang, "Hi, I'm from the Wishluck team. Could you tell me a bit more about what you need help with?", "Hi, main Wishluck team se hoon. Aap kis cheez mein madad chahte hain, thoda detail mein bata sakte hain?"),
        });
        return done("");
      }
      return done(L(lang, "Sorry, I didn't quite get that. Is it about an order's status, a cancellation, a return/exchange, a refund, or sizing?", "Sorry, samajh nahi aaya. Order status, cancel, return/exchange, refund ya size — kis cheez mein madad chahiye?", "माफ़ कीजिए, समझ नहीं आया। ऑर्डर स्टेटस, कैंसल, रिटर्न/एक्सचेंज या रिफंड — किसमें मदद चाहिए?"));
    }

    // Bulk / quotation → ask the team, keep the conversation.
    if (intent === "bulk") {
      await call("ask_team", {
        kind: "BULK_QUOTE",
        question: `Customer is asking for a bulk order / quotation: "${text.slice(0, 300)}". Please share the best price per piece and timeline.`,
        customer_summary: `${ctx.conversation.channel === "telegram" ? "Telegram" : "Web chat"} customer asking about a bulk order.`,
      });
      return done(L(lang, "Thanks! Bulk orders get a special quote from our team — I've sent them your requirement and I'll get back to you right here shortly. Could you also share the delivery city and the size split, if you know it?", "Thanks! Bulk orders ke liye hamari team special quote deti hai — maine aapki requirement team ko bhej di hai, main yahin jaldi update karunga. Delivery city aur size split bhi bata dijiye?"));
    }

    // Damage claims: the photo requirement and refund decision need a person (manual review policy).
    if (intent === "damage") {
      await call("handover_to_human", {
        reason: "MANUAL_REVIEW_REQUIRED",
        mood: "frustrated",
        order_number: e.orderNumber,
        summary: `Customer reports a damaged item${e.orderNumber ? ` on ${e.orderNumber}` : ""} and wants a resolution. Damage claims without a photo need manual review. Message: "${text.slice(0, 200)}".`,
        suggested_reply: L(lang, "Hi, I'm from the Wishluck team — really sorry about the damaged item. Could you share a photo so we can sort this out quickly?", "Hi, main Wishluck team se hoon — damaged item ke liye sorry. Kya aap ek photo share kar sakte hain taaki hum jaldi solve kar sakein?"),
      });
      return done("");
    }

    // 6. Order-specific intents → verification first.
    state.intent = intent;
    if (e.sku) state.sku = e.sku;
    if (e.size && intent === "exchange") state.newSize = e.size;
    if (e.phone) state.phone = e.phone;
    const verified = ctx.conversation.verifiedOrderNumbers;
    const orderNumber = e.orderNumber ?? state.orderNumber ?? (verified.length === 1 ? verified[0] : undefined) ?? flowOrder;
    if (orderNumber) state.orderNumber = orderNumber;
    const phone = e.phone ?? state.phone;

    if (!orderNumber || !verified.includes(orderNumber)) {
      if (orderNumber && phone) {
        const v = await call("verify_customer", { order_number: orderNumber, phone });
        state.phone = undefined; // a phone is used for one attempt only
        if (!v.ok) {
          await save();
          if (v.code === "VERIFICATION_LOCKED") {
            await call("handover_to_human", { reason: "VERIFICATION_FAILED", mood: "frustrated", summary: "Customer failed order/phone verification repeatedly. No order details were shared.", suggested_reply: "Hi, I'm from the Wishluck team. I can help verify your order — could you share the order number and the phone number used at checkout?" });
            return done("");
          }
          return done(L(lang, "Sorry, the order number and phone number don't match our records, so I can't share any details. Please check both and try again.", "Sorry, order number aur phone number hamare records se match nahi kar rahe, isliye main koi detail share nahi kar sakta. Dono check karke dobara bhejiye.", "क्षमा करें, ऑर्डर नंबर और फ़ोन नंबर हमारे रिकॉर्ड से मेल नहीं खाते, इसलिए मैं कोई जानकारी नहीं दे सकता। कृपया दोनों जाँचकर फिर भेजें।"));
        }
      } else {
        await save();
        if (!orderNumber) return done(L(lang, "Sure, I can help. Please share your order number (it starts with WL) and the phone number used on that order.", "Zaroor! Apna order number (WL se shuru hota hai) aur us order par diya gaya phone number bhejiye.", "ज़रूर! अपना ऑर्डर नंबर (जो WL से शुरू होता है) और उस ऑर्डर का फ़ोन नंबर भेजिए।"));
        return done(L(lang, `To protect your privacy, please share the phone number used on order ${orderNumber}.`, `Aapki privacy ke liye, order ${orderNumber} par diya gaya phone number bhejiye.`, `आपकी सुरक्षा के लिए, ऑर्डर ${orderNumber} पर दिया गया फ़ोन नंबर भेजिए।`));
      }
    }
    await save();
    const on = orderNumber!;

    switch (intent) {
      case "status": {
        const r = await call("get_shipment_status", { order_number: on });
        if (!r.ok) return done(this.failure(lang, r));
        return done(this.statusReply(lang, r.data as Record<string, unknown>));
      }
      case "refund": {
        const r = await call("get_refund_status", { order_number: on });
        if (!r.ok) return done(this.failure(lang, r));
        const d = r.data as { refunds: { amount: string; status: string; expected_by: string | null; completed_on: string | null; method: string }[]; refund_policy: string };
        if (!d.refunds.length) return done(L(lang, `There's no refund on order ${on} yet. ${d.refund_policy}`, `Order ${on} par abhi koi refund record nahi hai. ${d.refund_policy}`));
        const rf = d.refunds[0]!;
        const when = rf.completed_on ? `completed on ${rf.completed_on}` : rf.expected_by ? `expected by ${rf.expected_by}` : "pending quality check";
        return done(L(lang, `Your refund of ${rf.amount} for ${on} is ${rf.status.replace(/_/g, " ").toLowerCase()} (${when}). ${d.refund_policy}`, `${on} ka ${rf.amount} refund abhi ${rf.status.replace(/_/g, " ").toLowerCase()} hai (${when}). ${d.refund_policy}`));
      }
      case "cancel": {
        const r = await call("check_cancellation_eligibility", { order_number: on });
        if (!r.ok) return done(this.failure(lang, r));
        if (!(r.data as { cancellable: boolean }).cancellable) {
          state.intent = undefined;
          await save();
          return done(r.message ?? "");
        }
        return done(await this.propose(ctx, lang, { action: "cancel_order", order_number: on, reason: text.slice(0, 200) }));
      }
      case "exchange": {
        if (!state.newSize) return done(L(lang, "Which size would you like instead?", "Aapko kaunsa size chahiye?", "आपको कौन-सा साइज़ चाहिए?"));
        const r = await call("check_exchange_eligibility", { order_number: on, sku: state.sku, new_size: state.newSize });
        if (!r.ok) return done(this.failure(lang, r));
        if (!(r.data as { eligible: boolean }).eligible) {
          state.intent = undefined;
          await save();
          return done(r.message ?? "");
        }
        return done(await this.propose(ctx, lang, { action: "create_exchange", order_number: on, sku: state.sku, new_size: state.newSize, reason: text.slice(0, 200) }));
      }
      case "return": {
        const r = await call("check_return_eligibility", { order_number: on, sku: state.sku, unused_with_tags: true });
        if (!r.ok) return done(this.failure(lang, r));
        const d = r.data as { eligible: boolean; requires_manual_review: boolean; alternative?: string };
        if (d.requires_manual_review) {
          await call("handover_to_human", { reason: "MANUAL_REVIEW_REQUIRED", mood: "neutral", order_number: on, summary: `Customer wants to return an item on ${on}. Policy check: ${r.message}`, suggested_reply: "Hi, I'm from the Wishluck team. I'm reviewing your return request and will update you shortly." });
          return done("");
        }
        if (!d.eligible) {
          state.intent = undefined;
          await save();
          const alt = d.alternative === "SIZE_EXCHANGE" ? L(lang, " I can help you exchange it for another size if you'd like.", " Agar chahein to main size exchange karwa sakta hoon.") : "";
          return done(`${r.message}${alt}`);
        }
        if (state.awaiting !== "unused") {
          state.awaiting = "unused";
          await save();
          return done(L(lang, "This item is within the return window. Is it unused with the original tags still attached?", "Ye item return window mein hai. Kya ye unused hai aur tags lage hue hain?", "यह आइटम रिटर्न विंडो में है। क्या यह अनयूज़्ड है और टैग लगे हैं?"));
        }
        state.awaiting = undefined;
        const order = await prisma.order.findUnique({ where: { orderNumber: on } });
        const method = order?.paymentMethod === "COD" ? (/credit/i.test(text) ? "STORE_CREDIT" : "BANK_TRANSFER") : "ORIGINAL_PAYMENT";
        return done(await this.propose(ctx, lang, { action: "create_return", order_number: on, sku: state.sku, reason: "Customer request", unused_with_tags: true, refund_method: method }));
      }
      case "address":
      case "cod_edit": {
        if (!e.pincode) return done(L(lang, "Please share the full new address with house/flat number and the 6-digit pincode.", "Naya poora address house/flat number aur 6-digit pincode ke saath bhejiye."));
        const line = text.replace(/\b\d{6}\b/, "").replace(/(change|deliver|address|to|my|please|instead)\b/gi, "").trim().slice(0, 180) || text.slice(0, 180);
        return done(await this.propose(ctx, lang, { action: "change_address", order_number: on, address_line1: line, pincode: e.pincode }));
      }
      case "cod_pay":
        return done(this.codReply(lang, await call("respond_cod_confirmation", { order_number: on, choice: "PAY_ONLINE" })));
      default:
        return done(L(lang, "How can I help with this order?", "Is order mein kya madad chahiye?"));
    }
  }

  private async propose(ctx: ToolContext, lang: Lang, input: Record<string, unknown>): Promise<string> {
    const r = await executeTool(ctx, "propose_action", input);
    if (!r.ok) return this.failure(lang, r);
    const d = r.data as { eligible?: boolean; summary?: string; requires_manual_review?: boolean };
    if (d.requires_manual_review) {
      await executeTool(ctx, "handover_to_human", { reason: "MANUAL_REVIEW_REQUIRED", mood: "neutral", order_number: input.order_number, summary: `Request needs manual review: ${r.message}`, suggested_reply: "Hi, I'm from the Wishluck team and I'm reviewing your request now." });
      return "";
    }
    if (!d.eligible || !d.summary) return r.message ?? "";
    return L(lang, `Here's what I'll do: ${d.summary}\nShall I go ahead? Please reply yes or no.`, `Main ye karunga: ${d.summary}\nKya main aage badhoon? Haan ya nahi reply kijiye.`, `मैं यह करूँगा: ${d.summary}\nक्या मैं आगे बढ़ूँ? हाँ या नहीं लिखें।`);
  }

  private statusReply(lang: Lang, d: Record<string, unknown>): string {
    if (d.shipped === false) return `${d.order_number}: ${String(d.note)}${d.delivery_estimate_after_dispatch ? ` (${d.delivery_estimate_after_dispatch} after dispatch)` : ""}`;
    const status = String(d.courier_status).replace(/_/g, " ").toLowerCase();
    const eta = d.expected_delivery ? L(lang, ` Expected delivery: ${d.expected_delivery}.`, ` Expected delivery: ${d.expected_delivery}.`) : "";
    const fail = d.courier_status === "DELIVERY_FAILED" ? L(lang, ` The last attempt failed (${d.last_failure_reason}).`, ` Pichli delivery attempt fail hui (${d.last_failure_reason}).`) : "";
    if (d.courier_status === "DELIVERED") return L(lang, `Order ${d.order_number} was delivered on ${d.delivered_on}.`, `Order ${d.order_number} ${d.delivered_on} ko deliver ho gaya tha.`);
    return L(lang,
      `Your order ${d.order_number} is ${status} with ${d.courier} (AWB ${d.awb}).${eta}${fail} Track it here: ${d.tracking_link}`,
      `Aapka order ${d.order_number} abhi ${status} hai — ${d.courier} (AWB ${d.awb}).${eta}${fail} Track karein: ${d.tracking_link}`,
      `आपका ऑर्डर ${d.order_number} अभी ${status} है — ${d.courier} (AWB ${d.awb}).${eta}${fail} ट्रैक करें: ${d.tracking_link}`);
  }

  private codReply(lang: Lang, r: ToolResult): string {
    if (!r.ok) return r.message ?? this.failure(lang, r);
    return r.message ?? "";
  }

  private describeDone(lang: Lang, type: string, d: Record<string, unknown>): string {
    switch (type) {
      case "cancel_order": {
        const refund = d.refund as { amount: string; expected_by: string } | null;
        return L(lang, `Done — order ${d.order_number} is cancelled.${refund ? ` A refund of ${refund.amount} will reach your original payment method by ${refund.expected_by}.` : ""}`, `Ho gaya — order ${d.order_number} cancel ho gaya hai.${refund ? ` ${refund.amount} ka refund ${refund.expected_by} tak original payment method mein aa jayega.` : ""}`);
      }
      case "create_exchange":
        return L(lang, `Done! Exchange created for ${d.item}: size ${d.from_size} → ${d.to_size} (ref ${d.exchange_id}). We'll arrange a pickup and send the new size.`, `Ho gaya! ${d.item} ka exchange ban gaya: size ${d.from_size} → ${d.to_size} (ref ${d.exchange_id}). Pickup arrange karke naya size bhej denge.`);
      case "create_return":
        return L(lang, `Done! Return created for ${d.item} (ref ${d.return_id}). Refund of ${d.refund_amount} after quality check. ${d.refund_policy}`, `Ho gaya! ${d.item} ka return ban gaya (ref ${d.return_id}). Quality check ke baad ${d.refund_amount} refund hoga.`);
      case "change_address":
        return L(lang, `Done — the delivery address for ${d.order_number} is updated to ${d.new_city} ${d.new_pincode}.${d.cod_status === "CONFIRMED" ? " Your COD order is confirmed too." : ""}`, `Ho gaya — ${d.order_number} ka address ${d.new_city} ${d.new_pincode} par update ho gaya.${d.cod_status === "CONFIRMED" ? " Aapka COD order bhi confirm ho gaya." : ""}`);
      case "ndr_reschedule":
        return L(lang, `Done — the courier will re-attempt delivery of ${d.order_number} on ${d.new_delivery_date} (ref ${d.courier_reference}).`, `Ho gaya — courier ${d.new_delivery_date} ko ${d.order_number} dobara deliver karega (ref ${d.courier_reference}).`);
      case "ndr_cancel_rto":
        return L(lang, `Understood — order ${d.order_number} will be returned to us. Nothing more is needed from you.`, `Theek hai — order ${d.order_number} hamare paas wapas aa jayega.`);
      default:
        return L(lang, `Done — I've updated the courier for ${d.order_number} (ref ${d.courier_reference}).`, `Ho gaya — courier ko ${d.order_number} ke liye update kar diya (ref ${d.courier_reference}).`);
    }
  }

  private failure(lang: Lang, r: ToolResult): string {
    if (r.code === "INTERNAL_ERROR" || r.code === "TIMEOUT" || r.code === "COURIER_UNAVAILABLE") {
      return L(lang, "Sorry, I couldn't fetch the details right now. I can arrange a callback from our team — would that help?", "Sorry, abhi details fetch nahi ho payi. Kya main team se callback arrange karun?", "क्षमा करें, अभी जानकारी नहीं मिल पाई। क्या मैं टीम से कॉलबैक करवा दूँ?");
    }
    return r.message ?? L(lang, "Sorry, I couldn't complete that.", "Sorry, ye complete nahi ho paya.");
  }
}
