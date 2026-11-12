/** PII masking for logs, tool traces and audit records. */

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const d = phone.replace(/\D/g, "");
  if (d.length < 4) return "XXXX";
  return `${d.slice(0, 2)}${"X".repeat(Math.max(d.length - 4, 2))}${d.slice(-2)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}

export function maskAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  const words = addr.trim().split(/\s+/);
  return `${words[0] ?? ""} ***`;
}

const PHONE_RE = /(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Mask phones and emails that appear inside free text. */
export function maskText(text: string): string {
  return text.replace(PHONE_RE, (m) => maskPhone(m)).replace(EMAIL_RE, (m) => maskEmail(m));
}

const ADDRESS_KEYS = new Set(["addressLine1", "addressLine2", "landmark", "address", "newAddress", "address_line1", "new_address"]);
const PHONE_KEYS = new Set(["phone", "alternatePhone", "alternate_phone", "newPhone"]);
const EMAIL_KEYS = new Set(["email"]);

/** Deep-mask a JSON-like value. */
export function maskDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskText(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v)) as T;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && ADDRESS_KEYS.has(k)) out[k] = maskAddress(v);
      else if (typeof v === "string" && PHONE_KEYS.has(k)) out[k] = maskPhone(v);
      else if (typeof v === "string" && EMAIL_KEYS.has(k)) out[k] = maskEmail(v);
      else out[k] = maskDeep(v);
    }
    return out as T;
  }
  return value;
}
