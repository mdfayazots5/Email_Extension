import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogFileName,
  applyActivity,
  logCountries,
  diffRunActivity,
  emptyDayLog,
  formatDayReport,
  readAccountGuard,
  readActivityLogs,
  recordActivityEvent,
  recordRunActivity,
  startBlockReason,
  summarizeDay
} from "./activity-log";
import type { SearchRunState } from "./types";

function run(overrides: Partial<SearchRunState> = {}): SearchRunState {
  return {
    runId: 1,
    queryId: 10,
    status: "running",
    statusText: "Scanning",
    countryCode: "US",
    cityLabel: "Los Angeles",
    waitingForNextQuery: false,
    currentQueryRetries: 0,
    counters: { scrollCount: 0, postsScanned: 0, emailsFound: 0, newEmails: 0, duplicateEmails: 0, ignoredEmails: 0, queryStatus: "pending" },
    ...overrides
  } as SearchRunState;
}

describe("diffRunActivity", () => {
  it("records a new run as one run and one search", () => {
    const change = diffRunActivity(null, run({ status: "awaiting_filters" }));
    expect(change.counters).toMatchObject({ runsStarted: 1, searchesOpened: 1 });
    expect(change.events.map((event) => event.kind)).toEqual(["run_started", "search_opened"]);
  });

  it("counts scrolls and posts within a record, and a new record as a search", () => {
    const first = run({ counters: { ...run().counters, scrollCount: 2, postsScanned: 8 } });
    const scrolled = diffRunActivity(first, run({ counters: { ...run().counters, scrollCount: 5, postsScanned: 20 } }));
    expect(scrolled.counters).toMatchObject({ scrolls: 3, postsScanned: 12 });
    expect(scrolled.events.filter((event) => event.kind === "scroll")).toHaveLength(3);

    const nextRecord = diffRunActivity(first, run({ queryId: 11, cityLabel: "Dallas" }));
    expect(nextRecord.counters).toMatchObject({ searchesOpened: 1 });
    expect(nextRecord.counters.scrolls).toBeUndefined();
  });

  it("classifies a LinkedIn warning separately from other errors", () => {
    const warning = diffRunActivity(run(), run({
      status: "error",
      statusText: "Stopped for LinkedIn security notice",
      error: "LinkedIn displayed a security check, captcha, rate-limit or restriction notice."
    }));
    expect(warning.counters).toMatchObject({ securityNotices: 1 });
    expect(warning.events[0].kind).toBe("security_notice");

    const other = diffRunActivity(run(), run({ status: "error", statusText: "Could not save", error: "Service offline" }));
    expect(other.counters).toMatchObject({ errors: 1 });
  });

  it("counts a retry as another search", () => {
    const change = diffRunActivity(run(), run({ currentQueryRetries: 1 }));
    expect(change.counters).toMatchObject({ retries: 1, searchesOpened: 1 });
  });
});

describe("summary and report", () => {
  it("finds the busiest hour and the activity before the first warning", () => {
    let log = emptyDayLog("2026-11-09", "2026-11-09T10:00:00.000Z");
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 10, minutes)).toISOString();
    for (let minute = 0; minute < 50; minute += 5) {
      log = applyActivity(log, { events: [{ kind: "search_opened" }], counters: { searchesOpened: 1 } }, at(minute));
      log = applyActivity(log, { events: [{ kind: "scroll" }, { kind: "scroll" }], counters: { scrolls: 2 } }, at(minute + 1));
    }
    log = applyActivity(log, { events: [{ kind: "security_notice", detail: "unusual search traffic" }], counters: { securityNotices: 1 } }, at(52));

    const summary = summarizeDay(log);
    expect(summary.busiestHourSearches).toBe(10);
    expect(summary.medianMinutesBetweenSearches).toBe(5);
    expect(summary.beforeWarning).toMatchObject({ searchesLastHour: 10, scrollsLastHour: 20, searchesToday: 10 });

    const report = formatDayReport(log);
    expect(report).toContain("First LinkedIn warning");
    expect(report).toContain("Searches opened by the extension: 10");
  });
});

describe("startBlockReason", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  it("blocks during the rest period and after the daily search limit", () => {
    const limits = { maxSearchesPerDay: 25, restHoursAfterWarning: 24 };
    expect(startBlockReason({ day: "x", searches: 3, lastWarningAt: "2026-11-09T19:37:00.000Z" }, limits, now)).toMatch(/Resting until/);
    expect(startBlockReason({ day: "x", searches: 3, lastWarningAt: "2026-11-09T10:00:00.000Z" }, limits, now)).toBeNull();
    expect(startBlockReason({ day: "x", searches: 25 }, limits, now)).toMatch(/Daily search limit/);
    expect(startBlockReason({ day: "x", searches: 99 }, { maxSearchesPerDay: 0, restHoursAfterWarning: 0 }, now)).toBeNull();
  });
});

describe("storage", () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => key in storage).map((key) => [key, storage[key]]));
          }),
          set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values); }),
          remove: vi.fn(async (key: string) => { delete storage[key]; })
        }
      }
    });
  });

  it("starts a fresh log each day and keeps earlier days", async () => {
    await recordRunActivity(null, run(), new Date(2026, 10, 9, 22, 0));
    await recordRunActivity(null, run({ runId: 2 }), new Date(2026, 10, 10, 9, 0));
    const logs = await readActivityLogs();
    expect(logs.map((log) => log.day)).toEqual(["2026-11-10", "2026-11-09"]);
    expect(logs[0].counters.runsStarted).toBe(1);
    expect(logs[0].events[0].runId).toBe(2);
  });

  it("keeps the guard but writes no log when the log is switched off", async () => {
    storage.activityLogEnabled = false;
    const today = new Date();
    await recordRunActivity(null, run(), today);
    await recordRunActivity(run(), run({ status: "error", error: "LinkedIn security check" }), today);
    expect(await readActivityLogs()).toEqual([]);
    const guard = await readAccountGuard(today);
    expect(guard.searches).toBe(1);
    expect(guard.lastWarningAt).toBeDefined();
  });

  it("counts page loads without using the extension's search allowance", async () => {
    const today = new Date();
    await recordActivityEvent("page_load", "LinkedIn content search page", { pageLoads: 1 }, today);
    expect((await readAccountGuard(today)).searches).toBe(0);
    expect((await readActivityLogs())[0].counters.pageLoads).toBe(1);
  });
});

describe("country names in downloads", () => {
  it("names the countries searched in the report and the file name", () => {
    let log = emptyDayLog("2026-11-10", "2026-11-10T10:00:00.000Z");
    log = applyActivity(log, diffRunActivity(null, run({ countryCode: "US" })), "2026-11-10T10:00:00.000Z");
    log = applyActivity(log, diffRunActivity(run({ countryCode: "US" }), run({ countryCode: "AU", queryId: 11, cityLabel: "Sydney" })), "2026-11-10T10:05:00.000Z");
    expect(logCountries(log).map((country) => country.name)).toEqual(["Australia", "United States"]);
    expect(activityLogFileName(log)).toBe("linkedin-activity-2026-11-10-Australia_United-States.txt");
    expect(formatDayReport(log)).toContain("Countries searched: Australia (1), United States (1)");
    expect(formatDayReport(log)).toContain("United States · Los Angeles");
  });
});
