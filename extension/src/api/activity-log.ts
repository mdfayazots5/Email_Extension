/**
 * Daily activity log and account-health guard.
 *
 * One log per local day records what the extension (and this Chrome profile) did on
 * LinkedIn: runs, searches opened, scrolls, posts, pauses, stops and any LinkedIn
 * warning. A new day starts a new, empty log; the newest LOG_RETENTION_DAYS days are
 * kept so a day that ended with a warning can be reviewed, copied or downloaded later.
 *
 * The guard (searches started today, last LinkedIn warning) is always kept, even when
 * the log is switched off, because the daily search limit and the rest period use it.
 *
 * No email addresses, post text, author names or URLs are stored.
 */
import type { SearchRunState } from "./types";
import { countryFilePart, countryName } from "../../../shared/country-names";

export type ActivityKind =
  | "run_started"
  | "search_opened"
  | "search_retry"
  | "page_load"
  | "scroll"
  | "search_completed"
  | "waiting_next"
  | "awaiting_filters"
  | "paused"
  | "resumed"
  | "stopped"
  | "completed"
  | "error"
  | "security_notice"
  | "start_blocked";

export type ActivityEvent = { t: string; kind: ActivityKind; detail?: string; runId?: number; /** Country code of the record searched. */ country?: string };

export type ActivityCounters = {
  runsStarted: number;
  searchesOpened: number;
  retries: number;
  pageLoads: number;
  scrolls: number;
  postsScanned: number;
  emailsFound: number;
  newEmails: number;
  pauses: number;
  stops: number;
  errors: number;
  securityNotices: number;
};

export type DayActivityLog = {
  day: string;
  startedAt: string;
  updatedAt: string;
  counters: ActivityCounters;
  events: ActivityEvent[];
  /** Events dropped because the day exceeded MAX_EVENTS_PER_DAY (oldest scrolls go first). */
  droppedEvents: number;
};

export type AccountGuard = {
  day: string;
  /** Searches (records) the extension opened today in this Chrome profile, retries included. */
  searches: number;
  lastWarningAt?: string;
  lastWarningText?: string;
};

export const ACTIVITY_LOG_ENABLED_KEY = "activityLogEnabled";
export const ACTIVITY_LOGS_KEY = "activityLogs";
export const ACCOUNT_GUARD_KEY = "accountGuard";
export const LOG_RETENTION_DAYS = 14;
export const MAX_EVENTS_PER_DAY = 5000;

const SECURITY_PATTERN = /login|security|captcha|rate.?limit|restrict|unusual|verification/i;

export function localDay(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function emptyCounters(): ActivityCounters {
  return {
    runsStarted: 0, searchesOpened: 0, retries: 0, pageLoads: 0, scrolls: 0, postsScanned: 0,
    emailsFound: 0, newEmails: 0, pauses: 0, stops: 0, errors: 0, securityNotices: 0
  };
}

export function emptyDayLog(day: string, now: string): DayActivityLog {
  return { day, startedAt: now, updatedAt: now, counters: emptyCounters(), events: [], droppedEvents: 0 };
}

type RunSnapshot = Pick<SearchRunState,
  "runId" | "queryId" | "status" | "statusText" | "error" | "counters" | "waitingForNextQuery"
  | "currentQueryRetries" | "countryCode" | "cityLabel"
> & Partial<SearchRunState>;

export type ActivityChange = {
  events: Array<Omit<ActivityEvent, "t">>;
  counters: Partial<ActivityCounters>;
};

function grow(next: number | undefined, previous: number | undefined): number {
  const after = next ?? 0;
  const before = previous ?? 0;
  // Counters reset to zero for each new record; a drop means a fresh count started.
  return after >= before ? after - before : after;
}

function recordLabel(run: RunSnapshot): string {
  return `${countryName(run.countryCode) || "?"} · ${run.cityLabel || `record ${run.queryId}`}`;
}

export function isSecurityText(text: string | undefined): boolean {
  return Boolean(text && SECURITY_PATTERN.test(text));
}

function settingsSummary(run: RunSnapshot): string {
  const seconds = (ms: number | undefined) => ms === undefined ? "?" : `${Math.round(ms / 100) / 10}`;
  return [
    `scroll wait ${seconds(run.scanDelayMinMs)}–${seconds(run.scanDelayMaxMs)}s`,
    `scrolls/record ${run.maxScrolls ?? "?"}`,
    `posts/record ${run.maxPosts ?? "?"}`,
    `pause between records ${seconds(run.queryPauseMinMs)}–${seconds(run.queryPauseMaxMs)}s`,
    `records/run ${run.maxQueriesPerRun ?? "?"}`,
    `posts/day ${run.maxPostsPerDay ?? "?"}`,
    `searches/day ${run.maxSearchesPerDay ?? "?"}`,
    `continue ${run.runAllCountries ? "all countries" : run.continueNext ? "country" : "off"}`
  ].join(", ");
}

/** Works out what happened between two saved states of the run. Pure, so it can be tested. */
export function diffRunActivity(previous: RunSnapshot | null, next: RunSnapshot): ActivityChange {
  const events: ActivityChange["events"] = [];
  const counters: Partial<ActivityCounters> = {};
  const add = (key: keyof ActivityCounters, amount = 1) => {
    if (amount > 0) counters[key] = (counters[key] ?? 0) + amount;
  };
  const runId = next.runId;
  const isNewRun = !previous || previous.runId !== next.runId;

  if (isNewRun) {
    if (!["running", "awaiting_filters", "paused"].includes(next.status)) return { events, counters };
    add("runsStarted");
    add("searchesOpened");
    const country = next.countryCode || undefined;
    events.push({ kind: "run_started", runId, country, detail: `${recordLabel(next)} · ${settingsSummary(next)}` });
    events.push({ kind: "search_opened", runId, country, detail: recordLabel(next) });
  } else if (previous.queryId !== next.queryId) {
    add("searchesOpened");
    events.push({ kind: "search_opened", runId, country: next.countryCode || undefined, detail: recordLabel(next) });
  } else if ((next.currentQueryRetries ?? 0) > (previous.currentQueryRetries ?? 0)) {
    add("retries");
    add("searchesOpened");
    events.push({ kind: "search_retry", runId, country: next.countryCode || undefined, detail: `${recordLabel(next)} · retry ${next.currentQueryRetries}` });
  }

  const sameRecord = !isNewRun && previous.queryId === next.queryId;
  const before = sameRecord ? previous.counters : undefined;
  const scrolls = grow(next.counters?.scrollCount, before?.scrollCount);
  add("scrolls", scrolls);
  for (let index = scrolls - 1; index >= 0; index--) {
    events.push({ kind: "scroll", runId, detail: `#${(next.counters?.scrollCount ?? 0) - index} · posts ${next.counters?.postsScanned ?? 0}` });
  }
  add("postsScanned", grow(next.counters?.postsScanned, before?.postsScanned));
  add("emailsFound", grow(next.counters?.emailsFound, before?.emailsFound));
  add("newEmails", grow(next.counters?.newEmails, before?.newEmails));

  if (next.counters?.queryStatus === "completed" && before?.queryStatus !== "completed") {
    events.push({
      kind: "search_completed",
      runId,
      detail: `${recordLabel(next)} · scrolls ${next.counters.scrollCount}, posts ${next.counters.postsScanned}, emails ${next.counters.emailsFound}`
    });
  }
  if (!isNewRun && next.waitingForNextQuery && !previous.waitingForNextQuery && next.status === "running") {
    events.push({ kind: "waiting_next", runId, detail: "pause before the next record" });
  }

  const previousStatus = isNewRun ? undefined : previous.status;
  if (next.status !== previousStatus) {
    const text = [next.statusText, next.error].filter(Boolean).join(" · ");
    switch (next.status) {
      case "paused":
        add("pauses");
        events.push({ kind: "paused", runId, detail: next.statusText });
        break;
      case "running":
        if (previousStatus === "paused") events.push({ kind: "resumed", runId });
        break;
      case "awaiting_filters":
        if (!isNewRun) events.push({ kind: "awaiting_filters", runId, detail: next.statusText });
        break;
      case "stopped":
        add("stops");
        events.push({ kind: "stopped", runId, detail: next.statusText });
        break;
      case "completed":
      case "country_completed":
        events.push({ kind: "completed", runId, detail: next.statusText });
        break;
      case "error":
        if (isSecurityText(text)) {
          add("securityNotices");
          events.push({ kind: "security_notice", runId, detail: text });
        } else {
          add("errors");
          events.push({ kind: "error", runId, detail: text });
        }
        break;
      default:
        break;
    }
  }
  return { events, counters };
}

export function applyActivity(log: DayActivityLog, change: ActivityChange, now: string): DayActivityLog {
  const counters = { ...log.counters };
  for (const [key, amount] of Object.entries(change.counters) as Array<[keyof ActivityCounters, number]>) {
    counters[key] = (counters[key] ?? 0) + amount;
  }
  const events = [...log.events, ...change.events.map((event) => ({ t: now, ...event }))];
  let dropped = log.droppedEvents;
  while (events.length > MAX_EVENTS_PER_DAY) {
    const scrollIndex = events.findIndex((event) => event.kind === "scroll");
    events.splice(scrollIndex >= 0 ? scrollIndex : 0, 1);
    dropped++;
  }
  return { ...log, counters, events, droppedEvents: dropped, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Summary and report (pure)
// ---------------------------------------------------------------------------

/** Countries searched that day, with how many searches each, most first. */
export function logCountries(log: DayActivityLog): Array<{ code: string; name: string; searches: number }> {
  const counts = new Map<string, number>();
  for (const event of log.events) {
    if (!event.country || (event.kind !== "search_opened" && event.kind !== "search_retry")) continue;
    counts.set(event.country, (counts.get(event.country) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, searches]) => ({ code, name: countryName(code), searches }))
    .sort((left, right) => right.searches - left.searches || left.name.localeCompare(right.name));
}

/** File name for a day's download, e.g. linkedin-activity-2026-11-10-United-States.txt */
export function activityLogFileName(log: DayActivityLog): string {
  const countries = logCountries(log);
  return `linkedin-activity-${log.day}${countries.length ? `-${countryFilePart(countries.map((country) => country.code))}` : ""}.txt`;
}

export type DaySummary = {
  activeMinutes: number;
  busiestHourSearches: number;
  busiestHourStart: string | null;
  busiestHourScrolls: number;
  medianSecondsBetweenScrolls: number | null;
  medianMinutesBetweenSearches: number | null;
  firstWarningAt: string | null;
  beforeWarning: null | { minutesSinceDayStart: number; searchesLastHour: number; scrollsLastHour: number; pageLoadsLastHour: number; searchesToday: number; scrollsToday: number };
};

const SEARCH_KINDS: ReadonlySet<ActivityKind> = new Set(["search_opened", "search_retry"]);

function times(events: ActivityEvent[], kinds: ReadonlySet<ActivityKind>): number[] {
  return events.filter((event) => kinds.has(event.kind)).map((event) => Date.parse(event.t)).sort((a, b) => a - b);
}

function busiestWindow(values: number[], windowMs: number): { count: number; start: number | null } {
  let best = { count: 0, start: null as number | null };
  let left = 0;
  for (let right = 0; right < values.length; right++) {
    while (values[right] - values[left] >= windowMs) left++;
    if (right - left + 1 > best.count) best = { count: right - left + 1, start: values[left] };
  }
  return best;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeDay(log: DayActivityLog): DaySummary {
  const all = log.events.map((event) => Date.parse(event.t));
  const searchTimes = times(log.events, SEARCH_KINDS);
  const scrollTimes = times(log.events, new Set<ActivityKind>(["scroll"]));
  const hour = 60 * 60 * 1000;
  const busiest = busiestWindow(searchTimes, hour);
  const busiestScrolls = busiestWindow(scrollTimes, hour);

  // Gaps between consecutive scrolls of the same record (ignore the gap across a new search).
  const scrollGaps: number[] = [];
  let lastScroll: number | null = null;
  for (const event of log.events) {
    if (SEARCH_KINDS.has(event.kind) || event.kind === "paused") lastScroll = null;
    if (event.kind !== "scroll") continue;
    const at = Date.parse(event.t);
    if (lastScroll !== null) scrollGaps.push((at - lastScroll) / 1000);
    lastScroll = at;
  }
  const searchGaps = searchTimes.slice(1).map((at, index) => (at - searchTimes[index]) / 60_000);

  const warning = log.events.find((event) => event.kind === "security_notice");
  let beforeWarning: DaySummary["beforeWarning"] = null;
  if (warning) {
    const at = Date.parse(warning.t);
    const inLastHour = (kind: ActivityKind) => log.events.filter((event) => {
      const time = Date.parse(event.t);
      return event.kind === kind && time <= at && at - time < hour;
    }).length;
    const upTo = (kinds: ReadonlySet<ActivityKind>) => log.events.filter((event) => kinds.has(event.kind) && Date.parse(event.t) <= at).length;
    beforeWarning = {
      minutesSinceDayStart: Math.round((at - (all[0] ?? at)) / 60_000),
      searchesLastHour: inLastHour("search_opened") + inLastHour("search_retry"),
      scrollsLastHour: inLastHour("scroll"),
      pageLoadsLastHour: inLastHour("page_load"),
      searchesToday: upTo(SEARCH_KINDS),
      scrollsToday: upTo(new Set<ActivityKind>(["scroll"]))
    };
  }
  return {
    activeMinutes: all.length ? Math.round((Math.max(...all) - Math.min(...all)) / 60_000) : 0,
    busiestHourSearches: busiest.count,
    busiestHourStart: busiest.start === null ? null : new Date(busiest.start).toISOString(),
    busiestHourScrolls: busiestScrolls.count,
    medianSecondsBetweenScrolls: median(scrollGaps),
    medianMinutesBetweenSearches: median(searchGaps),
    firstWarningAt: warning?.t ?? null,
    beforeWarning
  };
}

function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function round(value: number | null, digits = 1): string {
  return value === null ? "n/a" : String(Math.round(value * 10 ** digits) / 10 ** digits);
}

/** Plain-text report for copying or downloading. */
export function formatDayReport(log: DayActivityLog): string {
  const summary = summarizeDay(log);
  const c = log.counters;
  const lines = [
    `Email Extension · LinkedIn activity log · ${log.day}`,
    `Generated ${new Date().toLocaleString()} · times are this computer's local time`,
    "",
    "== Totals ==",
    `First activity ${log.events[0] ? clock(log.events[0].t) : "n/a"} · last activity ${log.events.length ? clock(log.events[log.events.length - 1].t) : "n/a"} · span ${summary.activeMinutes} min`,
    `Countries searched: ${logCountries(log).map((country) => `${country.name} (${country.searches})`).join(", ") || "none"}`,
    `Runs started: ${c.runsStarted}`,
    `Searches opened by the extension: ${c.searchesOpened} (retries ${c.retries})`,
    `LinkedIn search page loads in this profile (manual included): ${c.pageLoads}`,
    `Scrolls: ${c.scrolls}`,
    `Posts scanned: ${c.postsScanned} · emails found ${c.emailsFound} · new ${c.newEmails}`,
    `Pauses ${c.pauses} · stops ${c.stops} · errors ${c.errors} · LinkedIn warnings ${c.securityNotices}`,
    "",
    "== Pace ==",
    `Busiest 60 min: ${summary.busiestHourSearches} searches${summary.busiestHourStart ? ` (from ${clock(summary.busiestHourStart)})` : ""} · busiest 60 min of scrolling: ${summary.busiestHourScrolls} scrolls`,
    `Typical time between scrolls: ${round(summary.medianSecondsBetweenScrolls)} s`,
    `Typical time between searches: ${round(summary.medianMinutesBetweenSearches)} min`
  ];
  if (summary.beforeWarning && summary.firstWarningAt) {
    const before = summary.beforeWarning;
    lines.push(
      "",
      "== First LinkedIn warning ==",
      `At ${clock(summary.firstWarningAt)}, ${before.minutesSinceDayStart} min after the day's first activity`,
      `Up to then today: ${before.searchesToday} searches, ${before.scrollsToday} scrolls`,
      `In the 60 min before it: ${before.searchesLastHour} searches, ${before.scrollsLastHour} scrolls, ${before.pageLoadsLastHour} search page loads`
    );
  }
  lines.push("", "== Timeline ==");
  if (log.droppedEvents) lines.push(`(${log.droppedEvents} older scroll events were dropped to keep the log small)`);
  for (const event of log.events) {
    lines.push(`${clock(event.t)}  ${event.kind.padEnd(16)}${event.runId ? ` run ${event.runId}` : ""}${event.detail ? `  ${event.detail}` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Storage (chrome.storage.local, this Chrome profile only)
// ---------------------------------------------------------------------------

let writes: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = writes.then(task);
  writes = result.catch((error: unknown) => console.error("Activity log write failed:", error));
  return result;
}

export async function isActivityLogEnabled(): Promise<boolean> {
  const state = await chrome.storage.local.get(ACTIVITY_LOG_ENABLED_KEY);
  // On by default; the user can switch it off in Settings → Activity log.
  return state[ACTIVITY_LOG_ENABLED_KEY] !== false;
}

export async function setActivityLogEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ACTIVITY_LOG_ENABLED_KEY]: enabled });
}

export async function readActivityLogs(): Promise<DayActivityLog[]> {
  const state = await chrome.storage.local.get(ACTIVITY_LOGS_KEY);
  const logs = state[ACTIVITY_LOGS_KEY] as Record<string, DayActivityLog> | undefined;
  return Object.values(logs ?? {}).sort((left, right) => right.day.localeCompare(left.day));
}

export function deleteActivityLog(day?: string): Promise<void> {
  return serialize(async () => {
    if (!day) {
      await chrome.storage.local.remove(ACTIVITY_LOGS_KEY);
      return;
    }
    const state = await chrome.storage.local.get(ACTIVITY_LOGS_KEY);
    const logs = { ...(state[ACTIVITY_LOGS_KEY] as Record<string, DayActivityLog> | undefined ?? {}) };
    delete logs[day];
    await chrome.storage.local.set({ [ACTIVITY_LOGS_KEY]: logs });
  });
}

export async function readAccountGuard(now: Date = new Date()): Promise<AccountGuard> {
  const state = await chrome.storage.local.get(ACCOUNT_GUARD_KEY);
  const stored = state[ACCOUNT_GUARD_KEY] as AccountGuard | undefined;
  const day = localDay(now);
  if (!stored) return { day, searches: 0 };
  return stored.day === day ? stored : { ...stored, day, searches: 0 };
}

export function clearLastWarning(): Promise<void> {
  return serialize(async () => {
    const guard = await readAccountGuard();
    delete guard.lastWarningAt;
    delete guard.lastWarningText;
    await chrome.storage.local.set({ [ACCOUNT_GUARD_KEY]: guard });
  });
}

/** Why a new run must not start right now, or null. */
export function startBlockReason(
  guard: AccountGuard,
  limits: { maxSearchesPerDay: number; restHoursAfterWarning: number },
  now: Date = new Date()
): string | null {
  if (guard.lastWarningAt && limits.restHoursAfterWarning > 0) {
    const until = Date.parse(guard.lastWarningAt) + limits.restHoursAfterWarning * 3_600_000;
    if (now.getTime() < until) {
      return `LinkedIn showed a warning at ${new Date(guard.lastWarningAt).toLocaleString()}. Resting until ${new Date(until).toLocaleString()} `
        + "(Settings → Speed & limits → Account health).";
    }
  }
  if (limits.maxSearchesPerDay > 0 && guard.searches >= limits.maxSearchesPerDay) {
    return `Daily search limit reached (${guard.searches} of ${limits.maxSearchesPerDay}). Try again tomorrow or change it in Settings → Speed & limits.`;
  }
  return null;
}

async function writeChange(change: ActivityChange, now: Date): Promise<void> {
  const iso = now.toISOString();
  const day = localDay(now);

  const guard = await readAccountGuard(now);
  guard.searches += change.counters.searchesOpened ?? 0;
  const warning = change.events.find((event) => event.kind === "security_notice");
  if (warning) {
    guard.lastWarningAt = iso;
    guard.lastWarningText = warning.detail;
  }
  await chrome.storage.local.set({ [ACCOUNT_GUARD_KEY]: guard });

  if (!change.events.length && !Object.keys(change.counters).length) return;
  if (!await isActivityLogEnabled()) return;
  const state = await chrome.storage.local.get(ACTIVITY_LOGS_KEY);
  const logs = { ...(state[ACTIVITY_LOGS_KEY] as Record<string, DayActivityLog> | undefined ?? {}) };
  logs[day] = applyActivity(logs[day] ?? emptyDayLog(day, iso), change, iso);
  const keep = Object.keys(logs).sort().slice(-LOG_RETENTION_DAYS);
  const trimmed = Object.fromEntries(keep.map((key) => [key, logs[key]]));
  await chrome.storage.local.set({ [ACTIVITY_LOGS_KEY]: trimmed });
}

/** Records what changed between two saved run states. Never throws. */
export function recordRunActivity(previous: RunSnapshot | null, next: RunSnapshot, now: Date = new Date()): Promise<void> {
  const change = diffRunActivity(previous, next);
  return serialize(() => writeChange(change, now)).catch(() => undefined);
}

/** Records a single event that does not come from a run state change. Never throws. */
export function recordActivityEvent(kind: ActivityKind, detail?: string, counters: Partial<ActivityCounters> = {}, now: Date = new Date()): Promise<void> {
  return serialize(() => writeChange({ events: [{ kind, detail }], counters }, now)).catch(() => undefined);
}
