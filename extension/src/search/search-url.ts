import type { QueryFilters } from "../api/types";

const dateValues: Record<string, string> = {
  "24h": "past-24h",
  week: "past-week",
  month: "past-month"
};

const sortValues: Record<string, string> = {
  recent: "date_posted",
  relevance: "relevance"
};

export function buildLinkedInSearchUrl(queryText: string, filters: QueryFilters): string {
  const url = new URL("https://www.linkedin.com/search/results/content/");
  url.searchParams.set("keywords", queryText);
  url.searchParams.set("origin", "FACETED_SEARCH");

  const date = dateValues[filters.date_posted];
  if (date) url.searchParams.set("datePosted", `"${date}"`);

  const sort = sortValues[filters.sort_by];
  if (sort && sort !== "relevance") url.searchParams.set("sortBy", `"${sort}"`);

  return url.toString();
}

export function captureLinkedInFilterParams(searchUrl: string): string {
  const params = new URL(searchUrl).searchParams;
  params.delete("keywords");
  params.delete("origin");
  return params.toString();
}

export function filterParameterNames(params: string): string[] {
  return [...new Set([...new URLSearchParams(params).keys()])];
}

export function buildLinkedInSearchUrlFromParams(queryText: string, params: string): string {
  const url = new URL("https://www.linkedin.com/search/results/content/");
  url.searchParams.set("keywords", queryText);
  url.searchParams.set("origin", "FACETED_SEARCH");
  for (const [key, value] of new URLSearchParams(params)) {
    if (key !== "keywords" && key !== "origin") url.searchParams.append(key, value);
  }
  return url.toString();
}

export function searchUrlHasFilterParams(searchUrl: string, params: string): boolean {
  const actual = new URL(searchUrl).searchParams;
  for (const [key, value] of new URLSearchParams(params)) {
    if (key === "keywords" || key === "origin") continue;
    if (actual.getAll(key).includes(value) === false) return false;
  }
  return true;
}

export function filterNavigationStatus(searchUrl: string, params: string, fallback: boolean): "present" | "lost" | "confirm" {
  if (fallback) return "confirm";
  return searchUrlHasFilterParams(searchUrl, params) ? "present" : "lost";
}

export function summarizeFilterParams(params: string): string {
  const values = new URLSearchParams(params);
  const display = (key: string, aliases: Record<string, string>, fallback: string) => {
    const value = values.get(key);
    if (!value) return fallback;
    let normalized = value.trim();
    if (normalized.startsWith("[") || normalized.startsWith("\"")) {
      try {
        const parsed: unknown = JSON.parse(normalized);
        if (typeof parsed === "string") normalized = parsed;
        else if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") normalized = parsed[0];
      } catch {
        normalized = normalized.replace(/^["']|["']$/g, "");
      }
    } else {
      normalized = normalized.replace(/^["']|["']$/g, "");
    }
    const normalizedKey = normalized.toLowerCase();
    return aliases[normalizedKey] ?? normalized;
  };
  return [
    display("datePosted", { "past-24h": "Past 24 hours", "past-week": "Past week", "past-month": "Past month" }, "Any date"),
    display("sortBy", { date_posted: "Latest", relevance: "Relevance", latest: "Latest", recent: "Latest" }, "Default sort"),
    display("contentType", {
      all: "All content",
      posts: "All content",
      post: "All content",
      content_type_post: "Posts",
      content_type_video: "Videos",
      content_type_image: "Images",
      content_type_document: "Documents"
    }, "All content")
  ].join(" · ");
}

export function expectedUrlFilters(filters: QueryFilters): { datePosted?: string; sortBy?: string } {
  const date = dateValues[filters.date_posted];
  const sort = sortValues[filters.sort_by];
  return {
    ...(date ? { datePosted: `"${date}"` } : {}),
    ...(sort && sort !== "relevance" ? { sortBy: `"${sort}"` } : {})
  };
}
