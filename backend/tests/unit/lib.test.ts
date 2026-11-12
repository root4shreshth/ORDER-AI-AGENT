import { describe, expect, it } from "vitest";
import { maskAddress, maskDeep, maskEmail, maskPhone, maskText } from "../../src/lib/mask.js";
import { signBody, verifySignature } from "../../src/lib/hmac.js";
import { normalizeOrderNumber, normalizePhone, addWorkingDays } from "../../src/lib/format.js";

describe("PII masking", () => {
  it("masks phones, emails and addresses", () => {
    expect(maskPhone("9876543210")).toBe("98XXXXXX10");
    expect(maskEmail("aarav.sharma@example.com")).toBe("a***@example.com");
    expect(maskAddress("Flat 402, Tower B")).toBe("Flat ***");
  });
  it("masks phones/emails inside free text", () => {
    expect(maskText("call me on +91 9876543210 or a@b.com")).toBe("call me on 91XXXXXXXX10 or a***@b.com");
  });
  it("deep-masks known keys", () => {
    expect(maskDeep({ phone: "9876543210", nested: { addressLine1: "12 MG Road", note: "ok 9812345678" } })).toEqual({
      phone: "98XXXXXX10",
      nested: { addressLine1: "12 ***", note: "ok 98XXXXXX78" },
    });
  });
});

describe("HMAC", () => {
  const body = JSON.stringify({ event_id: "e1", amount: 100 });
  it("verifies valid signatures (with or without prefix)", () => {
    const sig = signBody(body, "secret-123");
    expect(verifySignature(body, sig, "secret-123")).toBe(true);
    expect(verifySignature(body, `sha256=${sig}`, "secret-123")).toBe(true);
  });
  it("rejects tampered body, wrong secret, missing or malformed signature", () => {
    const sig = signBody(body, "secret-123");
    expect(verifySignature(body + " ", sig, "secret-123")).toBe(false);
    expect(verifySignature(body, sig, "other-secret")).toBe(false);
    expect(verifySignature(body, undefined, "secret-123")).toBe(false);
    expect(verifySignature(body, "zz", "secret-123")).toBe(false);
  });
});

describe("normalisers", () => {
  it("order numbers", () => {
    expect(normalizeOrderNumber("#WL10234")).toBe("WL10234");
    expect(normalizeOrderNumber("wl 10234")).toBe("WL10234");
    expect(normalizeOrderNumber("10234")).toBe("WL10234");
    expect(normalizeOrderNumber("hello")).toBeNull();
  });
  it("phones", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("9876543210");
    expect(normalizePhone("09876543210")).toBe("9876543210");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("98XXXXXX12")).toBeNull();
  });
  it("working days skip weekends", () => {
    // Fri 13 Nov 2026 + 1 working day = Mon 16 Nov
    expect(addWorkingDays(new Date("2026-11-13T06:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-11-16");
  });
});

describe("Telegram formatting", async () => {
  const { toTelegramHtml } = await import("../../src/channels/telegram.js");
  it("escapes HTML and converts **bold**", () => {
    expect(toTelegramHtml("Total: **₹1,348** <script> & more")).toBe("Total: <b>₹1,348</b> &lt;script&gt; &amp; more");
  });
});
