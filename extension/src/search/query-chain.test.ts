import { describe, expect, it } from "vitest";
import { countryQueries, nextChainQuery, nextEnabledQuery, nextEnabledQueryInCountry, orderedEnabledQueries, reachedDailyPostLimit, shouldRetryQuery } from "./query-chain";
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

  it("continues into the next country only when running across countries", () => {
    const records = [record(1, "AU", 0), record(2, "AU", 1), record(5, "CA", 1), record(4, "CA", 0), record(6, "DE", 0, false), record(7, "GB", 0)];
    expect(nextChainQuery(records, 1, "AU", true)?.id).toBe(2);
    expect(nextChainQuery(records, 2, "AU", false)).toBeNull();
    expect(nextChainQuery(records, 2, "AU", true)?.id).toBe(4);
    expect(nextChainQuery(records, 5, "CA", true)?.id).toBe(7);
    expect(nextChainQuery(records, 7, "GB", true)).toBeNull();
  });

  it("retries up to the configured failure limit and enforces a hard daily cap", () => {
    expect(shouldRetryQuery(0, 2)).toBe(true);
    expect(shouldRetryQuery(1, 2)).toBe(true);
    expect(shouldRetryQuery(2, 2)).toBe(false);
    expect(reachedDailyPostLimit(99, 100)).toBe(false);
    expect(reachedDailyPostLimit(100, 100)).toBe(true);
  });
});
