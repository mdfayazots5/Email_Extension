import type { QueryRecord } from "../api/types";

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryLabel(countryCode: string): string {
  if (countryCode.toUpperCase() === "WW") return "Worldwide";
  // Placeholder for emails imported from the old v0.3 extension, which recorded no country.
  if (countryCode.toUpperCase() === "XX") return "Legacy (v0.3)";
  return countryNames.of(countryCode.toUpperCase()) ?? countryCode;
}

// Codes that Intl knows but that are not countries a LinkedIn search targets.
const NON_COUNTRY_CODES = new Set(["EU", "EZ", "UN", "QO", "ZZ", "XA", "XB", "AQ", "BV", "HM", "UM", "IO", "TF", "GS"]);
let countryOptionCache: Array<{ code: string; name: string }> | null = null;

/** Every ISO country the browser can name (A–Z pairs), plus Worldwide, sorted by name. */
export function countryOptions(): Array<{ code: string; name: string }> {
  if (countryOptionCache) return countryOptionCache;
  const strict = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const options: Array<{ code: string; name: string }> = [{ code: "WW", name: "Worldwide" }];
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (code === "WW" || NON_COUNTRY_CODES.has(code)) continue;
      const name = strict.of(code);
      if (name && name !== code) options.push({ code, name });
    }
  }
  countryOptionCache = options.sort((a, b) => a.name.localeCompare(b.name));
  return countryOptionCache;
}

export function queryFilterSummary(query: QueryRecord): string {
  const datePosted: Record<string, string> = {
    any: "Any time",
    "24h": "Past 24 hours",
    week: "Past week",
    month: "Past month"
  };
  const sortBy: Record<string, string> = {
    relevance: "Relevance",
    recent: "Most recent"
  };
  const contentType: Record<string, string> = {
    all: "All content",
    posts: "Posts",
    images: "Images",
    videos: "Videos",
    documents: "Documents"
  };
  return [
    datePosted[query.date_posted ?? "any"] ?? query.date_posted ?? "Any time",
    sortBy[query.sort_by ?? "relevance"] ?? query.sort_by ?? "Relevance",
    contentType[query.content_type ?? "all"] ?? query.content_type ?? "All content"
  ].join(" · ");
}

export function formatDisplayDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.valueOf())) return date;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(parsed);
}

export function historyPeriodLabel(
  period: "day" | "week" | "month",
  start: string,
  endExclusive: string
): string {
  if (period === "day") return formatDisplayDate(start);
  const lastInclusiveDay = new Date(`${endExclusive}T12:00:00`);
  if (Number.isNaN(lastInclusiveDay.valueOf())) return `${start} – ${endExclusive}`;
  lastInclusiveDay.setDate(lastInclusiveDay.getDate() - 1);
  const inclusiveEnd = `${lastInclusiveDay.getFullYear()}-${String(lastInclusiveDay.getMonth() + 1).padStart(2, "0")}-${String(lastInclusiveDay.getDate()).padStart(2, "0")}`;
  return `${formatDisplayDate(start)} – ${formatDisplayDate(inclusiveEnd)}`;
}

export function shortProfileId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

export function displayTimezone(timezone: string): string {
  return timezone === "Asia/Calcutta" ? "Asia/Kolkata" : timezone;
}
