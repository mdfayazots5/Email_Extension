import type { QueryRecord } from "../api/types";

export function orderedEnabledQueries(records: QueryRecord[]): QueryRecord[] {
  return records
    .filter((record) => Boolean(record.enabled))
    .sort((left, right) =>
      left.country_code.localeCompare(right.country_code)
      || left.position - right.position
      || left.id - right.id
    );
}

export function nextEnabledQuery(records: QueryRecord[], currentId: number): QueryRecord | null {
  const ordered = orderedEnabledQueries(records);
  const index = ordered.findIndex((record) => record.id === currentId);
  return index < 0 ? ordered[0] ?? null : ordered[index + 1] ?? null;
}

export function nextEnabledQueryInCountry(records: QueryRecord[], currentId: number, countryCode: string): QueryRecord | null {
  const ordered = orderedEnabledQueries(records).filter((record) => record.country_code === countryCode);
  const index = ordered.findIndex((record) => record.id === currentId);
  return index < 0 ? ordered[0] ?? null : ordered[index + 1] ?? null;
}

/**
 * Next record for a chained run. Within a country it follows record order; when
 * `acrossCountries` is on and the country is exhausted, it moves to the first record
 * of the next country (countries ordered by `compareCountries`).
 */
export function nextChainQuery(
  records: QueryRecord[],
  currentId: number,
  countryCode: string,
  acrossCountries: boolean,
  compareCountries: (left: string, right: string) => number = (left, right) => left.localeCompare(right)
): QueryRecord | null {
  const inCountry = nextEnabledQueryInCountry(records, currentId, countryCode);
  if (inCountry || !acrossCountries) return inCountry;
  const countries = [...new Set(orderedEnabledQueries(records).map((record) => record.country_code))].sort(compareCountries);
  const index = countries.indexOf(countryCode);
  if (index < 0) return null;
  for (const nextCountry of countries.slice(index + 1)) {
    const first = countryQueries(records, nextCountry)[0];
    if (first) return first;
  }
  return null;
}

export function countryQueries(records: QueryRecord[], countryCode: string): QueryRecord[] {
  return orderedEnabledQueries(records).filter((record) => record.country_code === countryCode);
}

export function shouldRetryQuery(retries: number, retryLimit: number): boolean {
  return retries < retryLimit;
}

export function reachedDailyPostLimit(postsScanned: number, maxPostsPerDay: number): boolean {
  return postsScanned >= maxPostsPerDay;
}
