import type { QueryInput, QueryRecord } from "../api/types";

const SAMPLE_NOTE = "Sample record: change the job titles to the job you want, or delete it.";

const sample = (country_code: string, label: string, place: string): Omit<QueryInput, "position"> => ({
  country_code,
  label,
  query_text: `("Software Engineer" OR "Software Developer") AND "${place}" AND hiring`,
  enabled: true,
  notes: SAMPLE_NOTE
});

/** Example search records for a first run. They hold no emails; users edit or delete them. */
export const SAMPLE_QUERIES: ReadonlyArray<Omit<QueryInput, "position">> = [
  sample("IN", "Bengaluru", "Bengaluru"),
  sample("IN", "Hyderabad", "Hyderabad"),
  sample("AE", "Dubai", "Dubai"),
  sample("GB", "London", "London"),
  { ...sample("US", "Remote", "Remote"), query_text: `("Software Engineer" OR "Software Developer") AND (remote OR "work from home") AND hiring` }
];

type QueryCreator = { createQuery(input: QueryInput): Promise<QueryRecord> };

/**
 * Adds the sample records that are not there yet (same country and label), placing them
 * after the existing records of each country. Returns how many were added.
 */
export async function addSampleQueries(api: QueryCreator, existing: QueryRecord[]): Promise<number> {
  const taken = new Set(existing.map((query) => `${query.country_code.toUpperCase()}|${query.label.trim().toLowerCase()}`));
  const nextPosition = new Map<string, number>();
  for (const query of existing) {
    const code = query.country_code.toUpperCase();
    nextPosition.set(code, Math.max(nextPosition.get(code) ?? 0, query.position + 1));
  }
  let added = 0;
  for (const item of SAMPLE_QUERIES) {
    const key = `${item.country_code}|${item.label.toLowerCase()}`;
    if (taken.has(key)) continue;
    const position = nextPosition.get(item.country_code) ?? 0;
    await api.createQuery({ ...item, position });
    nextPosition.set(item.country_code, position + 1);
    taken.add(key);
    added += 1;
  }
  return added;
}
