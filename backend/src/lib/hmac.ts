import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time verification of a hex HMAC-SHA256 signature (accepts a "sha256=" prefix). */
export function verifySignature(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = signBody(rawBody, secret);
  if (!/^[0-9a-f]+$/i.test(provided) || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}
