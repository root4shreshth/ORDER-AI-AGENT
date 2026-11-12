export type ConvStatus = "AI_HANDLING" | "NEEDS_HUMAN" | "HUMAN_HANDLING" | "RESOLVED";

export interface ConversationSummary {
  id: string;
  status: ConvStatus;
  customerName: string;
  customerPhone: string;
  language: string | null;
  channel: string;
  lastMessage: { role: string; content: string; at: string; voice?: boolean } | null;
  messageCount: number;
  handoverReason: string | null;
  ticket: { id: string; reason: string; mood: string; status: string } | null;
  assignedTo: string | null;
  flow: string | null;
  orderNumber: string | null;
  lastMessageAt: string;
}

export interface Message {
  id: string;
  role: "CUSTOMER" | "AI" | "HUMAN" | "SYSTEM";
  content: string;
  engine: string | null;
  intent: string | null;
  language: string | null;
  meta: Record<string, unknown> | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  messageId: string | null;
  turnId: string;
  toolName: string;
  input: unknown;
  output: { ok: boolean; code?: string; message?: string; data?: unknown };
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
  createdAt: string;
}

export interface Ticket {
  id: string;
  conversationId: string;
  orderNumber: string | null;
  reason: string;
  mood: string;
  summary: string;
  suggestedReply: string;
  orderContext: Record<string, unknown> | null;
  toolsCalled: unknown;
  status: string;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  status: ConvStatus;
  channel: string;
  language: string | null;
  verifiedOrderNumbers: string[];
  failedVerifyCount: number;
  handoverReason: string | null;
  assignedTo: string | null;
  context: { orderNumber?: string; flow?: string } | null;
  customerToken: string;
  firstResponseMs: number | null;
  createdAt: string;
  customer: { name: string; phone: string; email: string } | null;
  messages: Message[];
  toolCalls: ToolCall[];
  tickets: Ticket[];
  pendingActions: { id: string; type: string; summary: string; status: string; createdAt: string }[];
}

export interface OrderRow {
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  paymentMethod: "COD" | "PREPAID";
  status: string;
  total: number;
  totalText: string;
  itemCount: number;
  city: string;
  pincode: string;
  placedAt: string;
  cod: { score: number; band: "LOW" | "MEDIUM" | "HIGH"; status: string } | null;
  shipment: { awb: string; status: string; attempts: number; ndrOpen: boolean } | null;
}

export interface RiskReason {
  signal: string;
  points: number;
  explanation: string;
}

export interface AuditRow {
  id: string;
  actor: string;
  entityType: string;
  entityId: string;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  meta: unknown;
  createdAt: string;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod: "COD" | "PREPAID";
  itemsTotal: number;
  shippingFee: number;
  codFee: number;
  discount: number;
  total: number;
  addressLine1: string;
  addressLine2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  placedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelReason: string | null;
  rtoReason: string | null;
  notes: { at: string; by: string; text: string }[];
  customer: { name: string; phone: string; email: string };
  items: { id: string; sku: string; size: string; quantity: number; unitPrice: number; exchangeCount: number; returned: boolean; product: { name: string } }[];
  shipment: {
    awb: string;
    courier: string;
    status: string;
    attemptCount: number;
    lastFailureReason: string | null;
    expectedDeliveryAt: string | null;
    rescheduledFor: string | null;
    alternatePhone: string;
    deliveryNote: string | null;
    ndrOpen: boolean;
    events: { id: string; type: string; reason: string | null; location: string | null; occurredAt: string; externalEventId: string }[];
  } | null;
  codConfirmation: {
    riskScore: number;
    riskBand: "LOW" | "MEDIUM" | "HIGH";
    reasons: RiskReason[];
    status: string;
    sentAt: string | null;
    reminderSentAt: string | null;
    heldAt: string | null;
    respondedAt: string | null;
    response: string | null;
    paymentLink: string | null;
  } | null;
  refunds: { id: string; amount: number; method: string; status: string; expectedBy: string | null; completedAt: string | null }[];
  returnRequests: { id: string; type: string; status: string; reason: string; newSize: string | null; createdAt: string }[];
  audit: AuditRow[];
  conversations: { id: string; status: string; customerToken: string; createdAt: string; flow: string | null }[];
}

export interface PublicMessage {
  id: string;
  role: Message["role"];
  content: string;
  createdAt: string;
  engine: string | null;
  quickReplies: { id: string; label: string }[] | null;
  orderNumber: string | null;
  paymentLink: string | null;
  kind: string | null;
}
