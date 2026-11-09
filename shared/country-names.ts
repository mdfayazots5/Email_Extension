const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Full country name for a stored country code ("US" → "United States"). */
export function countryName(countryCode: string | null | undefined): string {
  const code = (countryCode ?? "").trim().toUpperCase();
  if (!code) return "";
  if (code === "WW") return "Worldwide";
  // Placeholder for emails imported from the old v0.3 extension, which recorded no country.
  if (code === "XX") return "Legacy (v0.3)";
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Country part of a download's file name: "United-States", "Australia-India",
 * or "All-countries" when there are more than three or none.
 */
export function countryFilePart(countryCodes: Iterable<string | null | undefined>): string {
  const names = [...new Set([...countryCodes].map(countryName).filter(Boolean))].sort();
  if (!names.length || names.length > 3) return "All-countries";
  return names
    .map((name) => name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, ""))
    .join("_");
}
