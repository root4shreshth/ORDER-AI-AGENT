/** Money is stored in paise. */
export const toRupees = (p: number): number => Math.round(p) / 100;
export const toPaise = (rupeesValue: number): number => Math.round(rupeesValue * 100);
export const fmtInr = (p: number): string =>
  `₹${toRupees(p).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function normalizePhone(input: string): string | null {
  const d = input.replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export function normalizeOrderNumber(input: string): string | null {
  const m = input.toUpperCase().replace(/[#\s-]/g, "").match(/^(?:WL)?(\d{4,8})$/);
  return m ? `WL${m[1]}` : null;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const daysBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / DAY_MS;

export function fmtDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** YYYY-MM-DD in IST. */
export function isoDateIST(d: Date): string {
  return new Date(d.getTime() + 5.5 * HOUR_MS).toISOString().slice(0, 10);
}

/** Add N working days (Mon–Fri). */
export function addWorkingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

export function addDays(from: Date, n: number): Date {
  return new Date(from.getTime() + n * DAY_MS);
}
