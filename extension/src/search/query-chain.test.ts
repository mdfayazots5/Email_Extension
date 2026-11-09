import { describe, expect, it } from "vitest";
import { countryQueries, nextEnabledQuery, nextEnabledQueryInCountry, orderedEnabledQueries, reachedDailyPostLimit, shouldRetryQuery } from "./query-chain";
import type { QueryRecord } from "../api/types";

const record = (id: number, country_code: string, position: number, enabled = true) =>
  ({ id, country_code, position, enabled } as QueryRecord);

describe("query chaining", () => {
  it("orders by country and position and skips disabled records", () => {
    const records = [record(3, "US", 0), record(2, "GB", 2, false), record(1, "GB", 0), record(4, "GB", 1)];
    expect(orderedEnabledQueries(records).map(({ id }) => id)).toEqual([1, 4, 3]);
    expect(nextEnabledQuery(records, 1)?.id).toBe(4);
    expect(nextEnabledQuery(records, 3)).toBeNull();
    expect(nextEnabledQueryInCountry(records, 1, "GB")?.id).toBe(4);
    expect(nextEnabledQueryInCountry(records, 4, "GB")).toBeNull();
    expect(nextEnabledQuery(records, 4)?.id).toBe(3);
    expect(countryQueries(records, "GB").map(({ id }) => id)).toEqual([1, 4]);
  });

  it("retries up to the configured failure limit and enforces a hard daily cap", () => {
    expect(shouldRetryQuery(0, 2)).toBe(true);
    expect(shouldRetryQuery(1, 2)).toBe(true);
    expect(shouldRetryQuery(2, 2)).toBe(false);
    expect(reachedDailyPostLimit(99, 100)).toBe(false);
    expect(reachedDailyPostLimit(100, 100)).toBe(true);
  });
});
