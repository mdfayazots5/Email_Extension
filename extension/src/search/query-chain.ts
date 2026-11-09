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

export function countryQueries(records: QueryRecord[], countryCode: string): QueryRecord[] {
  return orderedEnabledQueries(records).filter((record) => record.country_code === countryCode);
}

export function shouldRetryQuery(retries: number, retryLimit: number): boolean {
  return retries < retryLimit;
}

export function reachedDailyPostLimit(postsScanned: number, maxPostsPerDay: number): boolean {
  return postsScanned >= maxPostsPerDay;
}
