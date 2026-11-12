/**
 * Store knowledge base for the assistant (sample content for this demo store — consistent with
 * the Appendix A policy, which stays authoritative in src/policies). The agent answers product and
 * general questions ONLY from get_product_info / search_knowledge_base results.
 */

export interface ProductDetails {
  description: string;
  fabric: string;
  fit: string;
  care: string;
  /** each product is sold in one colourway (stock is tracked per size only) */
  colours: string[];
  highlights: string[];
  model_info?: string;
}

export const PRODUCT_DETAILS: Record<string, ProductDetails> = {
  "WL-KUR-01": {
    description: "Straight-cut cotton kurta with an all-over block-style print, mandarin collar and side slits. Works for office, festive lunches and everyday wear.",
    fabric: "100% cotton cambric, 120 GSM, breathable and soft",
    fit: "Regular fit, hip length (about 40–44 in depending on size)",
    care: "Machine wash cold, gentle cycle, wash dark colours separately, dry in shade, warm iron",
    colours: ["Indigo with off-white block print (single colourway)"],
    highlights: ["Hand-block inspired print", "Side pockets", "Coconut-shell buttons"],
    model_info: "Model is 5'10\" and wears size L",
  },
  "WL-TEE-02": {
    description: "Drop-shoulder oversized tee with a front graphic print. Relaxed street-style look.",
    fabric: "100% combed cotton, 220 GSM heavyweight jersey, bio-washed",
    fit: "Oversized — if you prefer a regular fit, take one size down",
    care: "Machine wash cold inside out, do not iron on the print, line dry",
    colours: ["Black (single colourway)"],
    highlights: ["Puff-print graphic", "Ribbed crew neck", "Pre-shrunk"],
    model_info: "Model is 5'11\" and wears size L",
  },
  "WL-JNS-03": {
    description: "Relaxed fit five-pocket jeans with a straight leg and a mid-rise waist.",
    fabric: "98% cotton, 2% elastane denim, 12 oz, mid-wash",
    fit: "Relaxed through the thigh, straight leg, mid rise. Sizes are waist in inches.",
    care: "Wash inside out in cold water, avoid tumble dry to keep the colour",
    colours: ["Mid blue wash (single colourway)"],
    highlights: ["Comfort stretch", "YKK zip", "Reinforced belt loops"],
    model_info: "Model is 5'11\" and wears size 32",
  },
  "WL-BRF-04": {
    description: "Pack of 3 everyday cotton briefs with a soft, covered waistband.",
    fabric: "95% cotton, 5% elastane",
    fit: "Mid rise, full coverage",
    care: "Machine wash warm, tumble dry low",
    colours: ["Assorted pack: black, grey melange, navy"],
    highlights: ["Tag-free comfort", "Breathable cotton"],
  },
  "WL-BAG-05": {
    description: "Sturdy canvas tote with an inner zip pocket — fits a 14-inch laptop.",
    fabric: "12 oz cotton canvas with cotton webbing handles",
    fit: "One size: 40 × 38 cm, 10 cm gusset",
    care: "Spot clean or hand wash cold, air dry",
    colours: ["Natural canvas (single colourway)"],
    highlights: ["Inner zip pocket", "Magnetic snap closure", "Carries up to 10 kg"],
  },
  "WL-SAL-06": {
    description: "Classic crew-neck tee in solid colours — end-of-season sale price.",
    fabric: "100% cotton, 180 GSM",
    fit: "Regular fit",
    care: "Machine wash cold, tumble dry low",
    colours: ["Navy (single colourway)"],
    highlights: ["Sale item — size exchange only, no returns or refunds"],
  },
};

export interface KbEntry {
  id: string;
  title: string;
  tags: string[];
  text: string;
}

export const KNOWLEDGE_BASE: KbEntry[] = [
  { id: "about", title: "About Wishluck", tags: ["about", "brand", "company", "who"], text: "Wishluck is an Indian D2C fashion brand selling everyday cotton clothing — kurtas, tees, jeans, innerwear and bags — online across India." },
  { id: "support-hours", title: "Support hours", tags: ["support", "hours", "contact", "call", "human", "timing"], text: "This assistant replies 24×7. Our human support team is available Monday to Saturday, 10 am to 7 pm IST; requests outside these hours are picked up the next working day." },
  { id: "payments", title: "Payment methods", tags: ["payment", "upi", "card", "cod", "netbanking", "pay"], text: "Pay online by UPI, cards or net banking (prepaid orders get 5% off when switching from COD), or Cash on Delivery for orders between ₹299 and ₹4,999 with a ₹49 COD fee on COD-serviceable pincodes." },
  { id: "shipping", title: "Shipping & delivery", tags: ["shipping", "delivery", "days", "charges", "free", "time"], text: "Free shipping above ₹999, otherwise ₹79. Metro cities 2–4 days, rest of India 4–7 days, North East and J&K 6–9 days. Orders ship from our warehouse in Bhiwandi, Maharashtra." },
  { id: "returns", title: "Returns & exchanges", tags: ["return", "exchange", "refund", "size"], text: "Returns within 7 days of delivery for unused items with tags. Innerwear can't be returned. Sale items are size-exchange only. One size exchange per item within 7 days, subject to stock." },
  { id: "sizing", title: "Choosing a size", tags: ["size", "fit", "measure", "chart", "height", "weight"], text: "Each product has its own size chart (ask about a product to get it). Our oversized tees run large — take one size down for a regular fit. Jeans sizes are waist in inches." },
  { id: "bulk", title: "Bulk & corporate orders", tags: ["bulk", "corporate", "wholesale", "quote", "quotation", "team", "event", "pieces"], text: "Orders above 10 pieces are bulk orders. Our team prepares a custom quotation (price per piece, size split, delivery timeline). The assistant collects the requirement and checks with the team; once the team approves a quote, the order can be booked in chat. Bulk orders are prepaid." },
  { id: "custom", title: "Customisation & gifting", tags: ["custom", "logo", "print", "gift", "personalise", "embroidery"], text: "Logo printing, embroidery and gift packing are possible only on bulk orders and need a team quote." },
  { id: "order-changes", title: "Changing an order", tags: ["change", "address", "cancel", "modify"], text: "You can cancel or change the delivery address free of charge before the order ships. After shipping you can refuse the delivery or return it after delivery." },
  { id: "fabric-care", title: "Fabric & care", tags: ["cotton", "fabric", "wash", "care", "shrink", "colour"], text: "Most of our clothing is 100% cotton and pre-shrunk. Wash cold, dry in shade and wash dark colours separately to keep them looking new." },
  { id: "privacy", title: "Your data", tags: ["privacy", "data", "phone", "safe", "security"], text: "We only share order details after verifying the order number and the phone number on the order. We never share one customer's details with another." },
];

/** Tiny keyword search (the KB is small; no vector DB needed). */
export function searchKnowledge(query: string, limit = 3): KbEntry[] {
  const words = query.toLowerCase().split(/[^a-z0-9₹]+/).filter((w) => w.length > 2);
  return KNOWLEDGE_BASE.map((e) => {
    const hay = `${e.title} ${e.tags.join(" ")} ${e.text}`.toLowerCase();
    const score = words.reduce((s, w) => s + (e.tags.some((t) => t.startsWith(w) || w.startsWith(t)) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0);
    return { e, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}
