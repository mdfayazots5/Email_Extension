import { isStorableEmail, normalizeForComparison, repairEmailLocalPart } from "../../../shared/email-normalization";

export type ExtractedEmail = { original: string; normalized: string };

const plainEmailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;
const bracketAtPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+\s*(?:\[at\]|\(at\)|\s+at\s+)\s*[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*[A-Z]{2,}/gi;
const parenthesizedAtPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+\(at\)[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;

function trimPunctuation(value: string): string {
  return value.replace(/^[<([{'"`]+/, "").replace(/[>,;:!?)\]}'"`]+$/, "");
}

/** Removes email addresses so words inside them (e.g. a city in a domain) do not count as post text. */
export function stripEmails(text: string): string {
  return text
    .replace(plainEmailPattern, " ")
    .replace(bracketAtPattern, " ")
    .replace(parenthesizedAtPattern, " ");
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validEmail(value: string): boolean {
  if (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  const [local, ...domainParts] = value.split("@");
  const domain = domainParts.join("@");
  return local.length <= 64
    && !local.startsWith(".")
    && !local.endsWith(".")
    && !local.includes("..")
    && domain.split(".").every((part) => part.length > 0 && part.length <= 63 && !part.startsWith("-") && !part.endsWith("-"));
}

function normalizeObfuscated(value: string): string {
  return value
    .replace(/\s*(?:\[at\]|\(at\)|\bat\b)\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\bdot\b)\s*/gi, ".");
}

export function extractEmails(text: string): ExtractedEmail[] {
  const matches = [
    ...text.matchAll(plainEmailPattern),
    ...text.matchAll(bracketAtPattern),
    ...text.matchAll(parenthesizedAtPattern)
  ];
  const found = new Map<string, ExtractedEmail>();
  for (const match of matches) {
    const original = trimPunctuation(match[0]);
    const normalized = repairEmailLocalPart(normalizeForComparison(normalizeObfuscated(original).replace(/\s+/g, "")));
    if (!validEmail(normalized) || !isStorableEmail(normalized) || found.has(normalized)) continue;
    found.set(normalized, { original, normalized });
  }
  return [...found.values()];
}

export function isGenericEmail(email: string, ignoredPrefixes: string[]): boolean {
  const local = email.slice(0, email.indexOf("@")).toLowerCase();
  return ignoredPrefixes.some((prefix) => prefix.trim() && local.startsWith(prefix.trim().toLowerCase()));
}

export function relativeDateToISO(value: string, now = new Date()): string | null {
  const raw = value.trim();
  const absolute = raw.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (absolute) return absolute;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed) && /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(raw)) {
    return formatLocalDate(new Date(parsed));
  }

  const relative = raw.match(/(?:^|\b)(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)\b/i);
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!relative) {
    if (/^(?:just now|now|today)$/i.test(raw)) return formatLocalDate(date);
    return null;
  }

  const amount = Number(relative[1]);
  const unit = relative[2].toLowerCase();
  if (["m", "min", "minute", "minutes", "h", "hr", "hour", "hours"].includes(unit)) return formatLocalDate(date);
  if (["d", "day", "days"].includes(unit)) date.setDate(date.getDate() - amount);
  else if (["w", "wk", "week", "weeks"].includes(unit)) date.setDate(date.getDate() - amount * 7);
  else {
    const targetMonth = date.getMonth() - amount;
    const target = new Date(date.getFullYear(), targetMonth, 1);
    const finalDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(date.getDate(), finalDay));
    return formatLocalDate(target);
  }
  return formatLocalDate(date);
}
