export function normalizeForComparison(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
}

/**
 * Mirrors the service's `z.string().email()` rule (Zod v4) so the extension never sends an
 * address the service would reject — one rejected address fails the whole save batch.
 */
const storableEmailPattern = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

export function isStorableEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 320 && storableEmailPattern.test(email);
}

/**
 * Drops text glued to the front of an address, e.g. "email/hr@acme.com" -> "hr@acme.com",
 * by keeping only the local-part characters the service accepts after the last other symbol.
 */
export function repairEmailLocalPart(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at).replace(/^.*[^A-Za-z0-9_'+.\-]/, "").replace(/^[.']+/, "");
  return `${local}@${value.slice(at + 1)}`;
}
