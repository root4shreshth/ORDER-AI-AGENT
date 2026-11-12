/**
 * Deterministic guards that run BEFORE / AROUND the LLM. They don't replace backend
 * authorization (tools enforce verification + policy regardless); they make escalation
 * and confirmation behaviour predictable across English, Hindi and Hinglish.
 */
import type { Settings } from "../modules/settings/settings.js";
import type { HandoverReason } from "../modules/tickets/service.js";

export type Lang = "en" | "hi" | "hinglish";

const DEVANAGARI = /[ऀ-ॿ]/;
const HINGLISH_WORDS =
  /\b(mera|meri|mere|mujhe|muje|kab|kaise|kya|kyu|kyun|hai|hain|nahi|nahin|nhi|aayega|ayega|aaya|bhai|bhaiya|didi|karo|kar|kardo|krdo|do|dena|chahiye|wapas|paisa|paise|jaldi|abhi|kal|parso|haan|haa|ji|theek|thik|accha|acha|wala|wali|mil|jayega|jaega|hoga|bata|batao|tha|thi|aap|aapka|apna|yaar|bahut|bohot|kitna|kitne|kahan|kaha|se|ko|ka|ki|ke|ne|pe|par|lekin|aur|bhi|sirf|order\s+kab)\b/gi;

export function detectLanguage(text: string): Lang {
  if (DEVANAGARI.test(text)) return "hi";
  const hits = text.match(HINGLISH_WORDS)?.length ?? 0;
  const words = text.trim().split(/\s+/).length;
  if (hits >= 2 || (hits >= 1 && words <= 4)) return "hinglish";
  return "en";
}

// ---------------------------------------------------------------- escalation triggers
const LEGAL = /\b(consumer\s*(court|forum)|court|legal\s*(action|notice)|lawyer|advocate|sue|police|fir|complaint\s*(file|register)|case\s*(file|karunga|karungi|kar\s*dunga))\b|उपभोक्ता\s*(अदालत|फोरम)|कोर्ट|वकील|पुलिस|केस/i;
const PUBLIC = /\b(twitter|tweet|instagram|facebook|linkedin|youtube|social\s*media|post\s+(it\s+)?online|viral|review\s+(everywhere|online)|bad\s+review|1[\s-]?star|expose)\b|सोशल\s*मीडिया/i;
const HUMAN = /\b(human|real\s+person|a\s+person|someone\s+real|agent|executive|representative|customer\s*care|support\s*team|manager|supervisor|call\s+me|talk\s+to\s+(a\s+)?(person|someone|human)|insaan|insan|aadmi\s+se|kisi\s+se\s+baat)\b|इंसान|किसी\s*से\s*बात|मैनेजर/i;
const ANGER =
  /\b(worst|pathetic|useless|disgusting|fraud|cheat(ed|ers?)?|scam|scammers?|rubbish|nonsense|ridiculous|third\s+time|3rd\s+time|fed\s+up|sick\s+of|bakwas|bekaar|bekar|ghatiya|chor|dhokha|dhokebaaz|pagal|bloody|damn|wtf|hell)\b|धोखा|बकवास|घटिया|चोर/i;
const BULK = /\b(bulk|wholesale|corporate\s+order|reseller|\d{2,}\s*(pieces|pcs|units|qty)|b2b)\b/i;

export interface Trigger {
  reason: HandoverReason;
  mood: string;
}

export function detectEscalation(text: string, rules: Settings["handover"]): Trigger | null {
  const t = text.trim();
  const shouting = t.length > 12 && t.replace(/[^A-Za-z]/g, "").length > 8 && t === t.toUpperCase();
  const exclaim = (t.match(/!/g)?.length ?? 0) >= 3;
  const angry = ANGER.test(t) || shouting || exclaim;
  if (rules.onLegalThreat && LEGAL.test(t)) return { reason: "LEGAL_THREAT", mood: angry ? "angry" : "frustrated" };
  if (rules.onPublicComplaintThreat && PUBLIC.test(t)) return { reason: "PUBLIC_COMPLAINT_THREAT", mood: angry ? "angry" : "frustrated" };
  if (rules.onHumanRequest && HUMAN.test(t)) return { reason: "CUSTOMER_REQUESTED_HUMAN", mood: angry ? "angry" : "neutral" };
  if (rules.onAnger && angry) return { reason: "ANGRY_CUSTOMER", mood: "angry" };
  if (rules.onBulkOrder && BULK.test(t)) return { reason: "BULK_ORDER", mood: "neutral" };
  return null;
}

// ---------------------------------------------------------------- injection / data-leak probes
const INJECTION =
  /(ignore\s+(all\s+)?(the\s+|your\s+)?(previous|prior|above|earlier)?\s*(instructions|rules|prompts?)|disregard\s+(your|all|the)\s+(rules|instructions)|forget\s+(your|all)\s+(rules|instructions)|system\s*prompt|developer\s*mode|jailbreak|you\s+are\s+now|act\s+as\s+(an?\s+)?(admin|developer|system)|reveal\s+(your|the)\s+(prompt|instructions)|print\s+(your|the)\s+(prompt|instructions)|override|sudo|admin\s+mode|\bDAN\b|rules\s+bhool|instructions\s+bhool|नियम\s*भूल)/i;
const OTHER_CUSTOMER =
  /(orders?\s+(of|for)\s+(\+?\d|[A-Z]{2}\d|someone|my\s+(friend|wife|husband|brother|sister|neighbour))|show\s+(me\s+)?(all\s+)?(the\s+)?orders|list\s+(all\s+)?orders|all\s+customers|customer\s+(list|data|database)|\b\d{2}X{4,}\d{2}\b|kisi\s+aur\s+ka\s+order)/i;

export function detectInjection(text: string): boolean {
  return INJECTION.test(text);
}

export function detectOtherCustomerProbe(text: string): boolean {
  return OTHER_CUSTOMER.test(text);
}

// ---------------------------------------------------------------- yes / no
const YES = /^(y|ya|yes|yess+|yeah|yep|yup|sure|ok|okay|okk+|confirm(ed)?|go\s+ahead|do\s+it|please\s+do|proceed|correct|right|haan|han|haa|ha|hanji|haan\s*ji|ha\s*ji|ji|ji\s*haan|bilkul|theek\s*hai|thik\s*hai|thik|theek|kar\s*do|kardo|krdo|kar\s*dijiye|chalega|done|हाँ|हां|जी|जी\s*हाँ|ठीक\s*है|कर\s*दो|बिल्कुल)(?=$|[\s,.!?])/iu;
const NO = /^(n|no|nope|nah|don'?t|do\s+not|cancel\s+that|stop|wait|nahi|nahin|nhi|mat\s+karo|rehne\s+do|na|नहीं|मत)(?=$|[\s,.!?])/iu;

export function isAffirmative(text: string): boolean {
  const t = text.trim().replace(/[.!🙏👍]+$/u, "").trim();
  if (NO.test(t)) return false;
  return YES.test(t) || /^👍|✅/u.test(t);
}

export function isNegative(text: string): boolean {
  return NO.test(text.trim());
}
