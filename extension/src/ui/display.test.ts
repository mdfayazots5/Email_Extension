import { describe, expect, it } from "vitest";
import { countryLabel, displayTimezone, formatDisplayDate, historyPeriodLabel, queryFilterSummary, shortProfileId } from "./display";

describe("UI display helpers", () => {
  it("uses country names and saved query filter labels", () => {
    expect(countryLabel("GB")).toBe("United Kingdom");
    expect(countryLabel("WW")).toBe("Worldwide");
    expect(queryFilterSummary({
      id: 1,
      country_code: "GB",
      label: "London",
      query_text: "",
      position: 0,
      enabled: 1,
      notes: "",
      created_at: "",
      updated_at: "",
      date_posted: "week",
      sort_by: "recent",
      content_type: "all"
    })).toBe("Past week · Most recent · All content");
  });

  it("formats day and inclusive week/month ranges", () => {
    expect(formatDisplayDate("2026-10-25")).toBe("Sun, 25 Oct 2026");
    expect(historyPeriodLabel("week", "2026-10-19", "2026-10-26"))
      .toBe("Mon, 19 Oct 2026 – Sun, 25 Oct 2026");
    expect(historyPeriodLabel("month", "2026-10-01", "2026-11-01"))
      .toBe("Thu, 01 Oct 2026 – Sat, 31 Oct 2026");
  });

  it("shortens long profile IDs without altering short ones", () => {
    expect(shortProfileId("12345678901234567890")).toBe("123456…567890");
    expect(shortProfileId("short-id")).toBe("short-id");
  });

  it("displays the legacy India timezone using the current IANA name", () => {
    expect(displayTimezone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(displayTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });
});
