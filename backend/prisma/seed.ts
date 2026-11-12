/**
 * Seed data (Appendix A). All names, phones and addresses are made up.
 * Dates are relative to "now" so the scenarios stay valid whenever you seed.
 *
 *   npm run seed            → wipe + reseed
 *   node dist/prisma/seed.js --if-empty   → seed only when the DB has no orders (Docker boot)
 */
import { randomBytes } from "node:crypto";
import { PrismaClient, type CourierStatus, type OrderStatus, type PaymentMethod, type Prisma } from "@prisma/client";
import { CATALOG, PINCODES } from "../src/modules/catalog/data.js";
import { DEFAULT_SETTINGS } from "../src/modules/settings/settings.js";
import { POLICY, shippingFee, ETA_DAYS } from "../src/policies/index.js";
import { scoreCodRisk } from "../src/risk/codRisk.js";

const prisma = new PrismaClient();
const COD_QUICK_REPLIES = [
  { id: "CONFIRM", label: "✅ Confirm order" },
  { id: "CANCEL", label: "❌ Cancel order" },
  { id: "EDIT_ADDRESS", label: "📍 Edit address" },
  { id: "PAY_ONLINE", label: "💳 Pay online & get 5% off" },
];
const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

interface CustomerSeed {
  key: string;
  name: string;
  phone: string;
  email?: string;
}

const CUSTOMERS: CustomerSeed[] = [
  { key: "aarav", name: "Aarav Sharma", phone: "9876543210", email: "aarav.sharma@example.com" },
  { key: "priya", name: "Priya Nair", phone: "9812345678", email: "priya.nair@example.com" },
  { key: "rohan", name: "Rohan Verma", phone: "9123456780" },
  { key: "sneha", name: "Sneha Iyer", phone: "9988776655" },
  { key: "vikram", name: "Vikram Singh", phone: "9090909090" },
  { key: "neha", name: "Neha Gupta", phone: "9765432109" },
  { key: "arjun", name: "Arjun Mehta", phone: "9654321098" },
  { key: "kavya", name: "Kavya Reddy", phone: "9543210987" },
  { key: "ishaan", name: "Ishaan Kapoor", phone: "9432109876" },
  { key: "ananya", name: "Ananya Das", phone: "9321098765" },
  { key: "meera", name: "Meera Joshi", phone: "9210987654" },
  { key: "karan", name: "Karan Malhotra", phone: "8899001122" },
  { key: "pooja", name: "Pooja Bhatt", phone: "8877665544" },
  { key: "rahul", name: "Rahul Yadav", phone: "8765432190" },
  { key: "divya", name: "Divya Pillai", phone: "8654321970" },
  { key: "aditya", name: "Aditya Kumar", phone: "8543219760" },
  { key: "sanjay", name: "Sanjay Patil", phone: "8432197650" },
  { key: "farhan", name: "Farhan Ali", phone: "8321976540" },
  { key: "lakshmi", name: "Lakshmi Menon", phone: "7896541230" },
  { key: "tenzin", name: "Tenzin Dorji", phone: "7788990011" },
  { key: "gaurav", name: "Gaurav Saini", phone: "7766554433" },
  { key: "nisha", name: "Nisha Agarwal", phone: "7654321980" },
  { key: "manish", name: "Manish Tiwari", phone: "7543219860" },
  { key: "ritu", name: "Ritu Saxena", phone: "7432198760" },
  { key: "deepak", name: "Deepak Chauhan", phone: "7321987650" },
];

interface Addr {
  line1: string;
  line2?: string;
  landmark?: string;
  pincode: string;
}

interface OrderSeed {
  no: string;
  customer: string;
  scenario: string;
  pay: PaymentMethod;
  status: OrderStatus;
  items: { sku: string; size: string; qty?: number; exchangeCount?: number; returned?: boolean }[];
  addr: Addr;
  placedDaysAgo: number;
  shippedDaysAgo?: number;
  deliveredDaysAgo?: number;
  courier?: CourierStatus;
  attempts?: number;
  failReason?: string;
  ndrOpen?: boolean;
  refund?: { status: "PENDING_QC" | "COMPLETED" | "PROCESSING"; method: string; daysAgo: number };
  returnReq?: { type: "RETURN" | "EXCHANGE"; status: "REQUESTED" | "COMPLETED" | "PICKUP_SCHEDULED"; reason: string; newSize?: string; daysAgo: number };
  cod?: "AWAITING" | "CONFIRMED" | "ON_HOLD";
  cancelReason?: string;
  rtoReason?: string;
}

const A = {
  delhi: { line1: "Flat 402, Tower B, Green Park Apartments", line2: "Sector 12", pincode: "110017" },
  mumbai: { line1: "12, Sea View Building, Linking Road", line2: "Bandra West", pincode: "400050" },
  blr: { line1: "221, 5th Cross, Koramangala 4th Block", pincode: "560034" },
  chennai: { line1: "18, Gandhi Street, T Nagar", pincode: "600001" },
  kolkata: { line1: "7B, Lake Road, Ballygunge", pincode: "700001" },
  hyd: { line1: "Plot 45, Road No 3, Banjara Hills", pincode: "500001" },
  pune: { line1: "B-14, Shanti Niketan Society, FC Road", pincode: "411001" },
  jaipur: { line1: "House 88, Vaishali Nagar", line2: "Near Amrapali Circle", pincode: "302001" },
  lucknow: { line1: "C-21, Gomti Nagar Extension", pincode: "226001" },
  indore: { line1: "56, Vijay Nagar Scheme 54", pincode: "452001" },
  kochi: { line1: "Door 9/112, MG Road, Ernakulam", pincode: "682001" },
  patna: { line1: "Near Hanuman mandir", pincode: "800001" }, // landmark-only (high risk)
  noida: { line1: "Tower 3, Flat 1104, Supertech Capetown", line2: "Sector 74", pincode: "201301" },
  imphal: { line1: "House 14, Thangal Bazar", pincode: "795001" },
  guwahati: { line1: "22, GS Road, Christian Basti", pincode: "781001" },
  bhopal: { line1: "E-7/120, Arera Colony", pincode: "462001" },
} satisfies Record<string, Addr>;

const ORDERS: OrderSeed[] = [
  // --- Aarav: repeat customer, WL10234 in transit (Appendix B #1/#2)
  { no: "WL10220", customer: "aarav", scenario: "Older delivered order (repeat customer history)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-TEE-02", size: "L" }], addr: A.delhi, placedDaysAgo: 52, shippedDaysAgo: 51, deliveredDaysAgo: 48, courier: "DELIVERED" },
  { no: "WL10221", customer: "aarav", scenario: "Older delivered COD order", pay: "COD", status: "DELIVERED", items: [{ sku: "WL-BAG-05", size: "ONE" }], addr: A.delhi, placedDaysAgo: 30, shippedDaysAgo: 29, deliveredDaysAgo: 27, courier: "DELIVERED" },
  { no: "WL10234", customer: "aarav", scenario: "In transit — Appendix B #1/#2 order status", pay: "PREPAID", status: "SHIPPED", items: [{ sku: "WL-KUR-01", size: "M" }, { sku: "WL-TEE-02", size: "L" }], addr: A.delhi, placedDaysAgo: 2, shippedDaysAgo: 1, courier: "IN_TRANSIT" },
  // --- Returns / exchanges
  { no: "WL10235", customer: "priya", scenario: "Kurta delivered 3 days ago — exchange M→L (Appendix B #3)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-KUR-01", size: "M" }], addr: A.mumbai, placedDaysAgo: 7, shippedDaysAgo: 6, deliveredDaysAgo: 3, courier: "DELIVERED" },
  { no: "WL10236", customer: "rohan", scenario: "Innerwear (briefs) delivered — return rejected (Appendix B #4)", pay: "COD", status: "DELIVERED", items: [{ sku: "WL-BRF-04", size: "M" }, { sku: "WL-TEE-02", size: "M" }], addr: A.blr, placedDaysAgo: 6, shippedDaysAgo: 5, deliveredDaysAgo: 2, courier: "DELIVERED" },
  { no: "WL10237", customer: "sneha", scenario: "Sale tee delivered 2 days ago — refund rejected, exchange offered (Appendix B #5)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-SAL-06", size: "S" }], addr: A.chennai, placedDaysAgo: 6, shippedDaysAgo: 5, deliveredDaysAgo: 2, courier: "DELIVERED" },
  { no: "WL10238", customer: "vikram", scenario: "Shipped (in transit) — cancel refused (Appendix B #6)", pay: "PREPAID", status: "SHIPPED", items: [{ sku: "WL-JNS-03", size: "32" }], addr: A.kolkata, placedDaysAgo: 3, shippedDaysAgo: 2, courier: "IN_TRANSIT" },
  // --- NDR
  { no: "WL10239", customer: "neha", scenario: "Delivery failed once — customer not available (Appendix B #8)", pay: "COD", status: "SHIPPED", items: [{ sku: "WL-KUR-01", size: "S" }], addr: A.hyd, placedDaysAgo: 5, shippedDaysAgo: 4, courier: "DELIVERY_FAILED", attempts: 1, failReason: "Customer not available", ndrOpen: true },
  { no: "WL10240", customer: "arjun", scenario: "Delivery failed twice — escalation candidate", pay: "COD", status: "SHIPPED", items: [{ sku: "WL-JNS-03", size: "34" }], addr: A.pune, placedDaysAgo: 8, shippedDaysAgo: 7, courier: "DELIVERY_FAILED", attempts: 2, failReason: "Address not found", ndrOpen: true },
  { no: "WL10241", customer: "kavya", scenario: "RTO initiated after refusal", pay: "COD", status: "RTO_INITIATED", items: [{ sku: "WL-TEE-02", size: "S" }], addr: A.jaipur, placedDaysAgo: 10, shippedDaysAgo: 9, courier: "RTO_INITIATED", attempts: 2, failReason: "Customer refused delivery", rtoReason: "Customer refused delivery twice" },
  // --- Refunds
  { no: "WL10242", customer: "ishaan", scenario: "Refund pending (returned, awaiting QC)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-JNS-03", size: "30", returned: true }], addr: A.lucknow, placedDaysAgo: 12, shippedDaysAgo: 11, deliveredDaysAgo: 8, courier: "DELIVERED", returnReq: { type: "RETURN", status: "PICKUP_SCHEDULED", reason: "Fit too loose", daysAgo: 5 }, refund: { status: "PENDING_QC", method: "ORIGINAL_PAYMENT", daysAgo: 2 } },
  { no: "WL10243", customer: "ananya", scenario: "Refund completed", pay: "COD", status: "DELIVERED", items: [{ sku: "WL-BAG-05", size: "ONE", returned: true }], addr: A.indore, placedDaysAgo: 25, shippedDaysAgo: 24, deliveredDaysAgo: 21, courier: "DELIVERED", returnReq: { type: "RETURN", status: "COMPLETED", reason: "Colour different from photo", daysAgo: 18 }, refund: { status: "COMPLETED", method: "STORE_CREDIT", daysAgo: 10 } },
  // --- Meera: 3 returns in last 60 days → manual review on next return
  { no: "WL10244", customer: "meera", scenario: "Past return #1 (frequent returner)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-TEE-02", size: "M", returned: true }], addr: A.kochi, placedDaysAgo: 50, shippedDaysAgo: 49, deliveredDaysAgo: 46, courier: "DELIVERED", returnReq: { type: "RETURN", status: "COMPLETED", reason: "Did not like print", daysAgo: 44 }, refund: { status: "COMPLETED", method: "ORIGINAL_PAYMENT", daysAgo: 38 } },
  { no: "WL10245", customer: "meera", scenario: "Past return #2 (frequent returner)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-KUR-01", size: "S", returned: true }], addr: A.kochi, placedDaysAgo: 35, shippedDaysAgo: 34, deliveredDaysAgo: 31, courier: "DELIVERED", returnReq: { type: "RETURN", status: "COMPLETED", reason: "Size issue", daysAgo: 29 }, refund: { status: "COMPLETED", method: "ORIGINAL_PAYMENT", daysAgo: 22 } },
  { no: "WL10246", customer: "meera", scenario: "Past return #3 (frequent returner)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-BAG-05", size: "ONE", returned: true }], addr: A.kochi, placedDaysAgo: 20, shippedDaysAgo: 19, deliveredDaysAgo: 16, courier: "DELIVERED", returnReq: { type: "RETURN", status: "COMPLETED", reason: "Changed mind", daysAgo: 14 }, refund: { status: "COMPLETED", method: "ORIGINAL_PAYMENT", daysAgo: 8 } },
  { no: "WL10247", customer: "meera", scenario: "New return request → manual review (3+ returns in 60 days)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-TEE-02", size: "L" }], addr: A.kochi, placedDaysAgo: 6, shippedDaysAgo: 5, deliveredDaysAgo: 2, courier: "DELIVERED" },
  // --- Pre-dispatch
  { no: "WL10248", customer: "karan", scenario: "Unshipped prepaid — cancel / address change allowed", pay: "PREPAID", status: "CONFIRMED", items: [{ sku: "WL-KUR-01", size: "L" }, { sku: "WL-JNS-03", size: "32" }], addr: A.noida, placedDaysAgo: 0.5 },
  { no: "WL10249", customer: "pooja", scenario: "Unshipped COD — low risk (repeat customer), awaiting confirmation", pay: "COD", status: "PENDING_CONFIRMATION", items: [{ sku: "WL-TEE-02", size: "M" }], addr: A.bhopal, placedDaysAgo: 0.1, cod: "AWAITING" },
  { no: "WL10250", customer: "rahul", scenario: "Unshipped COD — high risk (first-time, ₹4,600-ish, landmark-only address)", pay: "COD", status: "PENDING_CONFIRMATION", items: [{ sku: "WL-JNS-03", size: "32" }, { sku: "WL-KUR-01", size: "L" }, { sku: "WL-BAG-05", size: "ONE" }], addr: A.patna, placedDaysAgo: 0.05, cod: "AWAITING" },
  // --- Shipping states
  { no: "WL10251", customer: "divya", scenario: "Out for delivery", pay: "COD", status: "SHIPPED", items: [{ sku: "WL-TEE-02", size: "S" }, { sku: "WL-SAL-06", size: "L" }], addr: A.blr, placedDaysAgo: 3, shippedDaysAgo: 2, courier: "OUT_FOR_DELIVERY" },
  { no: "WL10252", customer: "aditya", scenario: "Delivered 10 days ago — outside return window", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-KUR-01", size: "XL" }], addr: A.hyd, placedDaysAgo: 14, shippedDaysAgo: 13, deliveredDaysAgo: 10, courier: "DELIVERED" },
  { no: "WL10253", customer: "sanjay", scenario: "Delivered 3 days ago, ₹1,799 jeans — refund above ₹1,500 → manual review", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-JNS-03", size: "34" }], addr: A.pune, placedDaysAgo: 7, shippedDaysAgo: 6, deliveredDaysAgo: 3, courier: "DELIVERED" },
  { no: "WL10254", customer: "farhan", scenario: "Kurta already exchanged once — second exchange rejected", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-KUR-01", size: "L", exchangeCount: 1 }], addr: A.lucknow, placedDaysAgo: 9, shippedDaysAgo: 8, deliveredDaysAgo: 4, courier: "DELIVERED", returnReq: { type: "EXCHANGE", status: "COMPLETED", reason: "M too tight", newSize: "L", daysAgo: 3 } },
  // --- Lakshmi: previous COD refusal + a new COD order
  { no: "WL10255", customer: "lakshmi", scenario: "Previous COD refused (RTO delivered back)", pay: "COD", status: "RTO_DELIVERED", items: [{ sku: "WL-KUR-01", size: "M" }], addr: A.chennai, placedDaysAgo: 40, shippedDaysAgo: 39, courier: "RTO_INITIATED", attempts: 2, failReason: "Customer refused delivery", rtoReason: "Refused at door" },
  { no: "WL10256", customer: "lakshmi", scenario: "New COD order from a customer with a past refusal (medium/high risk)", pay: "COD", status: "PENDING_CONFIRMATION", items: [{ sku: "WL-JNS-03", size: "30" }], addr: A.chennai, placedDaysAgo: 0.02, cod: "AWAITING" },
  // --- North East (non-COD pincode)
  { no: "WL10257", customer: "tenzin", scenario: "Prepaid to Imphal 795001 (non-COD pincode), in transit", pay: "PREPAID", status: "SHIPPED", items: [{ sku: "WL-TEE-02", size: "M" }], addr: A.imphal, placedDaysAgo: 4, shippedDaysAgo: 3, courier: "IN_TRANSIT" },
  { no: "WL10258", customer: "gaurav", scenario: "Tote bag delivered 5 days ago — returnable, no size exchange", pay: "COD", status: "DELIVERED", items: [{ sku: "WL-BAG-05", size: "ONE" }], addr: A.guwahati, placedDaysAgo: 12, shippedDaysAgo: 11, deliveredDaysAgo: 5, courier: "DELIVERED" },
  { no: "WL10259", customer: "nisha", scenario: "COD on hold — no reply to confirmation", pay: "COD", status: "ON_HOLD", items: [{ sku: "WL-KUR-01", size: "M" }], addr: A.indore, placedDaysAgo: 1.5, cod: "ON_HOLD" },
  { no: "WL10260", customer: "manish", scenario: "COD confirmed, ready to ship", pay: "COD", status: "CONFIRMED", items: [{ sku: "WL-TEE-02", size: "L" }, { sku: "WL-BRF-04", size: "L" }], addr: A.bhopal, placedDaysAgo: 0.8, cod: "CONFIRMED" },
  { no: "WL10261", customer: "ritu", scenario: "Cancelled before shipping", pay: "PREPAID", status: "CANCELLED", items: [{ sku: "WL-SAL-06", size: "S" }], addr: A.jaipur, placedDaysAgo: 4, cancelReason: "Ordered by mistake", refund: { status: "COMPLETED", method: "ORIGINAL_PAYMENT", daysAgo: 3 } },
  { no: "WL10262", customer: "deepak", scenario: "Tee delivered 2 days ago — wants XL (out of stock)", pay: "PREPAID", status: "DELIVERED", items: [{ sku: "WL-TEE-02", size: "M" }], addr: A.noida, placedDaysAgo: 6, shippedDaysAgo: 5, deliveredDaysAgo: 2, courier: "DELIVERED" },
];

async function reset(): Promise<void> {
  // children first
  await prisma.$transaction([
    prisma.toolCall.deleteMany(),
    prisma.message.deleteMany(),
    prisma.pendingAction.deleteMany(),
    prisma.supportTicket.deleteMany(),
    prisma.conversation.deleteMany(),
    prisma.codConfirmation.deleteMany(),
    prisma.shipmentEvent.deleteMany(),
    prisma.shipment.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.returnRequest.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.productVariant.deleteMany(),
    prisma.product.deleteMany(),
    prisma.pincode.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.appSetting.deleteMany(),
  ]);
}

function timeline(o: OrderSeed): { type: CourierStatus; at: Date; reason?: string; location?: string }[] {
  if (o.shippedDaysAgo === undefined || !o.courier) return [];
  const s = o.shippedDaysAgo;
  const ev: { type: CourierStatus; at: Date; reason?: string; location?: string }[] = [
    { type: "PICKED_UP", at: ago(s), location: "Wishluck Warehouse, Bhiwandi" },
  ];
  const end = o.deliveredDaysAgo ?? 0;
  if (o.courier === "PICKED_UP") return ev;
  ev.push({ type: "IN_TRANSIT", at: ago(s, -6), location: "Regional hub" });
  if (o.courier === "IN_TRANSIT") return ev;
  if (o.courier === "OUT_FOR_DELIVERY") return [...ev, { type: "OUT_FOR_DELIVERY", at: ago(0, 3), location: "Local delivery centre" }];
  if (o.courier === "DELIVERED") return [...ev, { type: "OUT_FOR_DELIVERY", at: ago(end, 5) }, { type: "DELIVERED", at: ago(end, 2) }];
  const attempts = o.attempts ?? 1;
  for (let i = 0; i < attempts; i++) {
    const dayAgo = Math.max(0.1, s - 1.5 - i);
    ev.push({ type: "OUT_FOR_DELIVERY", at: ago(dayAgo, 4) });
    ev.push({ type: "DELIVERY_FAILED", at: ago(dayAgo, 1), reason: o.failReason ?? "Customer not available" });
  }
  if (o.courier === "RTO_INITIATED") ev.push({ type: "RTO_INITIATED", at: ago(Math.max(0.05, s - 1.5 - attempts)), reason: o.rtoReason });
  return ev;
}

export async function seed(): Promise<void> {
  await reset();

  await prisma.appSetting.create({ data: { key: "app", value: DEFAULT_SETTINGS as unknown as Prisma.InputJsonValue } });
  await prisma.pincode.createMany({ data: PINCODES.map((p) => ({ ...p, serviceable: p.serviceable ?? true })) });

  const productBySku = new Map<string, { id: string; price: number }>();
  for (const p of CATALOG) {
    const prod = await prisma.product.create({
      data: {
        sku: p.sku,
        name: p.name,
        priceInr: p.priceInr * 100,
        category: p.category,
        returnClass: p.returnClass,
        notes: p.notes,
        sizeChart: p.sizeChart,
        variants: { create: Object.entries(p.stock).map(([size, stock]) => ({ size, stock })) },
      },
    });
    productBySku.set(p.sku, { id: prod.id, price: p.priceInr * 100 });
  }

  const customerId = new Map<string, string>();
  for (const c of CUSTOMERS) {
    const created = await prisma.customer.create({
      data: { name: c.name, phone: c.phone, email: c.email, createdAt: ago(60) },
    });
    customerId.set(c.key, created.id);
  }

  const pinMap = new Map(PINCODES.map((p) => [p.pincode, p]));
  let awbSeq = 7_100_000;

  for (const o of ORDERS) {
    const pin = pinMap.get(o.addr.pincode)!;
    const itemsTotal = o.items.reduce((s, it) => s + productBySku.get(it.sku)!.price * (it.qty ?? 1), 0);
    const ship = shippingFee(itemsTotal);
    const codFee = o.pay === "COD" ? POLICY.COD_FEE : 0;
    const placedAt = ago(o.placedDaysAgo);

    const order = await prisma.order.create({
      data: {
        orderNumber: o.no,
        customerId: customerId.get(o.customer)!,
        paymentMethod: o.pay,
        status: o.status,
        itemsTotal,
        shippingFee: ship,
        codFee,
        total: itemsTotal + ship + codFee,
        addressLine1: o.addr.line1,
        addressLine2: "line2" in o.addr ? o.addr.line2 : null,
        city: pin.city,
        state: pin.state,
        pincode: pin.pincode,
        placedAt,
        createdAt: placedAt,
        shippedAt: o.shippedDaysAgo !== undefined ? ago(o.shippedDaysAgo) : null,
        deliveredAt: o.deliveredDaysAgo !== undefined ? ago(o.deliveredDaysAgo, 2) : null,
        cancelledAt: o.status === "CANCELLED" ? ago(o.placedDaysAgo - 0.2) : null,
        cancelReason: o.cancelReason,
        rtoReason: o.rtoReason,
        notes: [{ at: placedAt.toISOString(), by: "seed", text: `Scenario: ${o.scenario}` }],
        items: {
          create: o.items.map((it) => ({
            productId: productBySku.get(it.sku)!.id,
            sku: it.sku,
            size: it.size,
            quantity: it.qty ?? 1,
            unitPrice: productBySku.get(it.sku)!.price,
            exchangeCount: it.exchangeCount ?? 0,
            returned: it.returned ?? false,
          })),
        },
      },
      include: { items: true },
    });

    if (o.courier) {
      const [, maxDays] = ETA_DAYS[pin.zone];
      const shipment = await prisma.shipment.create({
        data: {
          orderId: order.id,
          awb: `WS${awbSeq++}`,
          status: o.courier,
          attemptCount: o.attempts ?? 0,
          lastFailureReason: o.failReason,
          ndrOpen: o.ndrOpen ?? false,
          expectedDeliveryAt: o.courier === "DELIVERED" || o.courier === "RTO_INITIATED" ? null : ahead(Math.max(1, maxDays - (o.shippedDaysAgo ?? 0) - 1)),
        },
      });
      const events = timeline(o);
      for (const [i, e] of events.entries()) {
        await prisma.shipmentEvent.create({
          data: { shipmentId: shipment.id, externalEventId: `seed-${shipment.awb}-${i}`, type: e.type, reason: e.reason, location: e.location, occurredAt: e.at },
        });
      }
    }

    if (o.returnReq) {
      await prisma.returnRequest.create({
        data: {
          orderId: order.id,
          orderItemId: order.items[0]!.id,
          type: o.returnReq.type,
          reason: o.returnReq.reason,
          newSize: o.returnReq.newSize,
          status: o.returnReq.status,
          createdAt: ago(o.returnReq.daysAgo),
        },
      });
    }

    if (o.refund) {
      const refundAmount = o.status === "CANCELLED" ? order.total : order.items[0]!.unitPrice;
      await prisma.refund.create({
        data: {
          orderId: order.id,
          amount: refundAmount,
          method: o.refund.method,
          status: o.refund.status,
          qcPassedAt: o.refund.status === "COMPLETED" ? ago(o.refund.daysAgo + 2) : null,
          completedAt: o.refund.status === "COMPLETED" ? ago(o.refund.daysAgo) : null,
          createdAt: ago(o.refund.daysAgo + 3),
        },
      });
    }

    if (o.cod) {
      const priorOrders = ORDERS.filter((x) => x.customer === o.customer && x.placedDaysAgo > o.placedDaysAgo);
      const risk = scoreCodRisk(
        {
          orderTotal: order.total,
          addressLine1: order.addressLine1,
          addressLine2: order.addressLine2,
          priorOrders: priorOrders.length,
          deliveredOrders: priorOrders.filter((x) => x.status === "DELIVERED").length,
          previousCodRefusals: priorOrders.filter((x) => x.pay === "COD" && (x.status === "RTO_DELIVERED" || x.status === "RTO_INITIATED")).length,
          recentCodOrders: 0,
        },
        DEFAULT_SETTINGS.risk,
      );
      // Awaiting / held COD orders already received their confirmation message.
      let conversationId: string | undefined;
      if (o.cod === "AWAITING" || o.cod === "ON_HOLD") {
        const conv = await prisma.conversation.create({
          data: {
            token: randomBytes(18).toString("base64url"),
            customerId: customerId.get(o.customer)!,
            verifiedOrderNumbers: [o.no],
            verifiedAt: placedAt,
            context: { orderNumber: o.no, flow: "COD" },
            createdAt: placedAt,
            lastMessageAt: placedAt,
          },
        });
        conversationId = conv.id;
        const cust = CUSTOMERS.find((c) => c.key === o.customer)!;
        await prisma.message.create({
          data: {
            conversationId: conv.id,
            role: "AI",
            engine: "template",
            createdAt: placedAt,
            content: `Hi ${cust.name.split(" ")[0]}, thanks for shopping with Wishluck! Please confirm your Cash on Delivery order ${o.no}. Amount to pay on delivery: ₹${(order.total / 100).toLocaleString("en-IN")} (incl. ₹49 COD fee). Pay online now and get 5% off.`,
            meta: { quickReplies: COD_QUICK_REPLIES, orderNumber: o.no, kind: "COD_CONFIRMATION" },
          },
        });
      }
      await prisma.codConfirmation.create({
        data: {
          conversationId,
          orderId: order.id,
          riskScore: risk.score,
          riskBand: risk.band,
          reasons: risk.reasons as unknown as Prisma.InputJsonValue,
          status: o.cod,
          sentAt: placedAt,
          reminderSentAt: o.cod === "ON_HOLD" ? ago(o.placedDaysAgo - 0.1) : null,
          heldAt: o.cod === "ON_HOLD" ? ago(o.placedDaysAgo - 1) : null,
          respondedAt: o.cod === "CONFIRMED" ? ago(o.placedDaysAgo - 0.1) : null,
          response: o.cod === "CONFIRMED" ? "CONFIRM" : null,
        },
      });
    }
  }

  await prisma.auditLog.create({
    data: { actor: "system", entityType: "system", entityId: "seed", action: "SEED", newValue: { orders: ORDERS.length, customers: CUSTOMERS.length } },
  });
}

async function main(): Promise<void> {
  const ifEmpty = process.argv.includes("--if-empty");
  if (ifEmpty && (await prisma.order.count()) > 0) {
    console.log("Seed skipped: database already has orders.");
    return;
  }
  await seed();
  console.log(`Seeded ${CUSTOMERS.length} customers, ${ORDERS.length} orders, ${CATALOG.length} products, ${PINCODES.length} pincodes.`);
}

const invokedDirectly = process.argv[1] ? /seed\.(ts|js)$/.test(process.argv[1]) : false;
if (invokedDirectly) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
