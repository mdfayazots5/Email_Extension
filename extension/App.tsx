import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, ensureService, getProfileIdentity, readSavedRun } from "./src/api/client";
import type { AppSettings, CountryFilterProfile, DailyComparisonSummary, DailyHistory, DailySummary, FilterResult, HistorySummary, MasterStatus, QueryFilters, QueryInput, QueryRecord, SearchRunState } from "./src/api/types";
import { Modal } from "./src/components/Modal";
import { SetupScreen } from "./src/components/SetupScreen";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { ConnectionLogControls } from "./src/components/ConnectionLogControls";
import { buildLinkedInSearchUrl, summarizeFilterParams } from "./src/search/search-url";
import { checkRule, evaluatePost } from "./src/search/post-rule";
import { DEFAULT_JOB_WORDS } from "../shared/post-defaults";
import { countryQueries } from "./src/search/query-chain";
import { recordConnectionLog } from "./src/api/connection-logs";
import { countryLabel, countryOptions, displayTimezone, formatDisplayDate, historyPeriodLabel, shortProfileId } from "./src/ui/display";

type Page = "view" | "history" | "queries" | "settings";
const navItems: Array<{ id: Page; label: string; icon: string }> = [
  { id: "view", label: "View", icon: "grid" },
  { id: "history", label: "History", icon: "clock" },
  { id: "queries", label: "Queries", icon: "list" },
  { id: "settings", label: "Settings", icon: "gear" }
];

const defaultFilters: QueryFilters = {
  date_posted: "any",
  sort_by: "relevance",
  content_type: "all",
  from_member: "",
  other_note: ""
};

const defaultSettings: AppSettings = {
  starting_country: null,
  starting_query_id: null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  data_retention_days: null,
  action_delay_min_ms: 1500,
  action_delay_max_ms: 3000,
  scan_delay_min_ms: 2000,
  scan_delay_max_ms: 4000,
  max_scrolls_per_query: 50,
  max_posts_per_query: 300,
  stop_after_no_new_posts: 3,
  query_pause_min_ms: 20_000,
  query_pause_max_ms: 40_000,
  max_queries_per_run: 10,
  max_posts_per_day: 10_000,
  query_retry_limit: 2,
  ignore_generic_addresses: true,
  ignored_email_prefixes: ["noreply", "no-reply", "donotreply"],
  exclude_earlier_emails: false,
  post_require_job_words: true,
  post_job_words: [...DEFAULT_JOB_WORDS],
  post_match_query: false,
  post_rule_custom: ""
};

const emptyCounters = (): SearchRunState["counters"] => ({
  scrollCount: 0,
  postsScanned: 0,
  emailsFound: 0,
  newEmails: 0,
  duplicateEmails: 0,
  ignoredEmails: 0,
  queryStatus: "pending"
});

function runStatusLabel(status: SearchRunState["status"] | undefined): string {
  switch (status) {
    case "running": return "Running";
    case "paused": return "Paused";
    case "awaiting_filters": return "Set filters";
    case "country_completed": return "Country done";
    case "error": return "Needs attention";
    case "completed": return "Finished";
    case "stopped": return "Stopped";
    default: return "Ready";
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function timestampLocalDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2",
    list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2m10-10h-2M4 12H2m17.07-7.07-1.42 1.42M6.35 17.65l-1.42 1.42m14.14 0-1.42-1.42M6.35 6.35 4.93 4.93",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
    gauge: "M12 14l4-4M3.5 18a10 10 0 1 1 17 0",
    mail: "M3 6h18v12H3zM3 7l9 6 9-6",
    file: "M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6",
    database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    flask: "M9 3h6M10 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4A1.5 1.5 0 0 0 20 19L14 9V3",
    filter: "M3 5h18l-7 8v6l-4 2v-8z"
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="nav-icon"><path d={paths[name]} /></svg>;
}

const SETTINGS_SECTIONS = [
  { id: "general", icon: "gear", title: "General", hint: "Profile, start record, timezone" },
  { id: "collecting", icon: "filter", title: "Collecting", hint: "Which posts and emails are saved" },
  { id: "limits", icon: "gauge", title: "Speed & limits", hint: "Scrolling, delays, safety caps" },
  { id: "data", icon: "database", title: "Data", hint: "Master list and data file" },
  { id: "advanced", icon: "flask", title: "Advanced", hint: "Troubleshooting options" }
] as const;
type SettingsSectionId = typeof SETTINGS_SECTIONS[number]["id"];

/**
 * Collapsible card. The open/closed choice is remembered per panel in this
 * Chrome profile. When `auto` is given, the panel also opens when it turns
 * true and closes when it turns false (e.g. run-related panels follow the run).
 */
function Panel({ id, title, subtitle, summary, actions, defaultOpen = true, auto, className = "", children }: {
  id: string;
  title: string;
  subtitle?: React.ReactNode;
  summary?: React.ReactNode;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  auto?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const storageKey = `panel:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === null ? defaultOpen : saved === "1";
    } catch {
      return defaultOpen;
    }
  });
  const firstAuto = useRef(true);
  useEffect(() => {
    if (auto === undefined) return;
    if (firstAuto.current) {
      firstAuto.current = false;
      if (auto) setOpen(true);
      return;
    }
    setOpen(auto);
  }, [auto]);
  const toggle = () => setOpen((current) => {
    const next = !current;
    try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* storage unavailable */ }
    return next;
  });
  return (
    <section className={`card panel ${open ? "panel--open" : "panel--closed"} ${className}`}>
      <header className="panel-head">
        <button type="button" className="panel-toggle" aria-expanded={open} aria-controls={`panel-${id}`} onClick={toggle}>
          <svg className="panel-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          <span className="panel-titles"><span className="panel-title">{title}</span>{subtitle && <small>{subtitle}</small>}</span>
        </button>
        {!open && summary !== undefined && <span className="panel-summary">{summary}</span>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {open && <div className="panel-body" id={`panel-${id}`}>{children}</div>}
    </section>
  );
}

/** Splits a comma- or line-separated list into trimmed, non-empty entries. */
function splitList(text: string): string[] {
  return text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function saveDownload(name: string, data: string | Blob, type: string) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

export default function App() {
  const [page, setPage] = useState<Page>("view");
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => localStorage.getItem("trackerTheme") === "dark" ? "dark" : "light"
  );
  const [queries, setQueries] = useState<QueryRecord[]>([]);
  const [countryFilters, setCountryFilters] = useState<CountryFilterProfile[]>([]);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [dailyComparison, setDailyComparison] = useState<DailyComparisonSummary | null>(null);
  const [masterInfo, setMasterInfo] = useState<MasterStatus | null>(null);
  const [dailyHistory, setDailyHistory] = useState<DailyHistory | null>(null);
  const [newEmailSearch, setNewEmailSearch] = useState("");
  const [dailyBusy, setDailyBusy] = useState(false);
  const [masterUploadBusy, setMasterUploadBusy] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [savedSettings, setSavedSettings] = useState<AppSettings | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [notice, setNotice] = useState("");
  const [searchRun, setSearchRun] = useState<SearchRunState | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<number | "">("");
  const [selectedCountry, setSelectedCountry] = useState("");
  const [continueNext, setContinueNext] = useState(true);
  const [runAllCountries, setRunAllCountries] = useState(false);
  const [debugFilters, setDebugFilters] = useState(false);
  const [debugScan, setDebugScan] = useState(false);
  const [continueOnFilterFailure, setContinueOnFilterFailure] = useState(false);
  const [experimentalAutomaticFilters, setExperimentalAutomaticFilters] = useState(false);
  const [historyPeriod, setHistoryPeriod] = useState<"day" | "week" | "month">("day");
  const [historyDate, setHistoryDate] = useState(todayString);
  const [historyCountry, setHistoryCountry] = useState("");
  const [historySummary, setHistorySummary] = useState<HistorySummary | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [editor, setEditor] = useState<QueryRecord | null | undefined>(undefined);
  const [editorCountry, setEditorCountry] = useState("");
  const [queryCountry, setQueryCountry] = useState("");
  const [querySearch, setQuerySearch] = useState("");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [rulePostSample, setRulePostSample] = useState("");
  const [ruleTestRecordId, setRuleTestRecordId] = useState<number | "">("");
  const [jobWordsText, setJobWordsText] = useState("");
  const [prefixesText, setPrefixesText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [profileLabel, setProfileLabel] = useState("Chrome profile");
  const [profileId, setProfileId] = useState("");
  const [linkedinTabFound, setLinkedinTabFound] = useState(false);

  const loadData = useCallback(async () => {
    setServiceError("");
    try {
      const [queryList, today, savedSettings, master, profiles] = await Promise.all([
        api.queries(),
        api.today(),
        api.settings(),
        api.masterStatus(),
        api.countryFilters()
      ]);
      const comparison = await api.daily(today.date);
      setQueries(queryList);
      setCountryFilters(profiles);
      setSummary(today);
      setMasterInfo(master);
      setDailyComparison(comparison);
      setHistoryDate((current) => current === todayString() ? today.date : current);
      // Defaults first, so a setting the service does not send yet can never be undefined.
      const normalizedSettings = {
        ...defaultSettings,
        ...savedSettings,
        timezone: displayTimezone(savedSettings.timezone)
      };
      setSettings(normalizedSettings);
      setSavedSettings(normalizedSettings);
      const localPreferences = await chrome.storage.local.get([
        "selectedQueryId",
        "continueNext",
        "runAllCountries",
        "debugFilters",
        "debugScan",
        "continueOnFilterFailure",
        "experimentalAutomaticFilters",
        "selectedCountryCode"
      ]);
      setSelectedQuery((current) => {
        if (current && queryList.some((query) => query.id === current)) return current;
        const savedSelection = Number(localPreferences.selectedQueryId);
        if (savedSelection && queryList.some((query) => query.id === savedSelection && Boolean(query.enabled))) return savedSelection;
        return savedSettings.starting_query_id
          && queryList.some((query) => query.id === savedSettings.starting_query_id)
          ? savedSettings.starting_query_id
          : queryList.find((query) => query.country_code === savedSettings.starting_country && Boolean(query.enabled))?.id
          ?? queryList.find((query) => Boolean(query.enabled))?.id
          ?? "";
      });
      const availableCountries = [...new Set(queryList.filter((query) => Boolean(query.enabled)).map((query) => query.country_code))];
      setSelectedCountry((current) => {
        const savedCountry = typeof localPreferences.selectedCountryCode === "string" ? localPreferences.selectedCountryCode : "";
        if (current && availableCountries.includes(current)) return current;
        if (savedCountry && availableCountries.includes(savedCountry)) return savedCountry;
        return queryList.find((query) => query.id === savedSettings.starting_query_id)?.country_code
          ?? queryList.find((query) => query.country_code === savedSettings.starting_country && Boolean(query.enabled))?.country_code
          ?? availableCountries[0]
          ?? "";
      });
      if (typeof localPreferences.continueNext === "boolean") setContinueNext(localPreferences.continueNext);
      setRunAllCountries(localPreferences.runAllCountries === true);
      setDebugFilters(localPreferences.debugFilters === true);
      setDebugScan(localPreferences.debugScan === true);
      setContinueOnFilterFailure(localPreferences.continueOnFilterFailure === true);
      setExperimentalAutomaticFilters(localPreferences.experimentalAutomaticFilters === true);
      setConnected(true);
    } catch (error) {
      setServiceError(formatError(error));
      if (error instanceof ApiError && (error.kind === "offline" || error.kind === "unauthorized")) {
        setConnected(false);
      }
    }
  }, []);

  useEffect(() => {
    const updateLinkedInTab = () => {
      void chrome.tabs.query({ url: "https://www.linkedin.com/*" })
        .then((tabs) => setLinkedinTabFound(tabs.length > 0))
        .catch(() => setLinkedinTabFound(false));
    };
    updateLinkedInTab();
    chrome.tabs.onCreated.addListener(updateLinkedInTab);
    chrome.tabs.onRemoved.addListener(updateLinkedInTab);
    chrome.tabs.onUpdated.addListener(updateLinkedInTab);
    return () => {
      chrome.tabs.onCreated.removeListener(updateLinkedInTab);
      chrome.tabs.onRemoved.removeListener(updateLinkedInTab);
      chrome.tabs.onUpdated.removeListener(updateLinkedInTab);
    };
  }, []);

  useEffect(() => {
    let active = true;
    // No token check here: api.health() asks the native host to start the service
    // and provide the token when needed.
    getProfileIdentity().then(async (profile) => {
      if (!active) return;
      setProfileId(profile.id);
      setProfileLabel(profile.label);
      try {
        // Once per page open: lets the native host replace a service that is running
        // older code (e.g. after an update). If the host is missing, health() below
        // reports it.
        await ensureService().catch(() => undefined);
        await api.health();
        if (active) {
          setConnected(true);
          await loadData();
          let savedRun = await readSavedRun();
          const activeProfileRun = await api.activeRun(profile.id);
          if (!savedRun && activeProfileRun) {
            const progress = JSON.parse(activeProfileRun.progress_json || "{}") as Partial<SearchRunState>;
            if (activeProfileRun.current_query_id && progress.queryText && progress.searchUrl && progress.filters && progress.counters) {
              savedRun = {
                ...progress,
                runId: activeProfileRun.id,
                queryId: activeProfileRun.current_query_id,
                queryText: progress.queryText,
                continueNext: Boolean(activeProfileRun.continue_next),
                status: progress.stage === "awaiting_filters" ? "awaiting_filters" : "paused",
                stage: progress.stage ?? "opening",
                statusText: "Interrupted run · Resume or Discard",
                filters: progress.filters,
                searchUrl: progress.searchUrl,
                filterResults: progress.filterResults ?? [],
                delayMinMs: progress.delayMinMs ?? 1500,
                delayMaxMs: progress.delayMaxMs ?? 3000,
                scanDelayMinMs: progress.scanDelayMinMs ?? 2000,
                scanDelayMaxMs: progress.scanDelayMaxMs ?? 4000,
                maxScrolls: Math.min(progress.maxScrolls ?? 50, 50),
                maxPosts: progress.maxPosts ?? 300,
                stopAfterNoNewPosts: progress.stopAfterNoNewPosts ?? 3,
                ignoreGenericAddresses: progress.ignoreGenericAddresses ?? true,
                ignoredEmailPrefixes: progress.ignoredEmailPrefixes ?? ["noreply", "no-reply", "donotreply"],
                postRequireJobWords: progress.postRequireJobWords,
                postJobWords: progress.postJobWords,
                postMatchQuery: progress.postMatchQuery,
                postRuleCustom: progress.postRuleCustom ?? "",
                counters: progress.counters,
                recentCaptures: [],
                processedPostIds: progress.processedPostIds ?? [],
                countryCode: progress.countryCode ?? "",
                cityLabel: progress.cityLabel ?? "",
                profileId: profile.id,
                profileLabel: activeProfileRun.profile_label || profile.label,
                queryResults: progress.queryResults ?? [],
                queriesAttempted: progress.queriesAttempted ?? 1,
                retryLimit: progress.retryLimit ?? 2,
                queryPauseMinMs: progress.queryPauseMinMs ?? 20_000,
                queryPauseMaxMs: progress.queryPauseMaxMs ?? 40_000,
                maxQueriesPerRun: progress.maxQueriesPerRun ?? 10,
                maxPostsPerDay: progress.maxPostsPerDay ?? 10_000,
                dailyPostsScanned: progress.dailyPostsScanned ?? 0,
                currentQueryRetries: progress.currentQueryRetries ?? 0,
                waitingForNextQuery: progress.waitingForNextQuery ?? progress.counters.queryStatus === "completed"
              };
              await chrome.storage.local.set({ activeSearchRun: savedRun });
            }
          }
          if (savedRun) {
            const persisted = await api.getRun(savedRun.runId);
            const progress = JSON.parse(persisted.progress_json || "{}") as Partial<SearchRunState>;
            const status = persisted.status === "paused" || persisted.status === "running" || persisted.status === "awaiting_filters" || persisted.status === "country_completed" || persisted.status === "query_completed" || persisted.status === "completed"
              ? persisted.status
              : persisted.status === "stopped" || persisted.status === "error"
                ? persisted.status
                : savedRun.status;
            if (status === "running" || status === "paused" || status === "awaiting_filters" || status === "country_completed" || status === "stopped" || status === "error" || status === "query_completed" || status === "completed") {
              setSearchRun({
                ...savedRun,
                ...progress,
                status,
                stage: progress.stage ?? savedRun.stage,
                statusText: progress.statusText ?? savedRun.statusText,
                counters: progress.counters ?? savedRun.counters ?? emptyCounters(),
                processedPostIds: progress.processedPostIds ?? savedRun.processedPostIds ?? [],
                recentCaptures: savedRun.recentCaptures ?? [],
                pendingSave: savedRun.pendingSave ?? false,
                queryResults: progress.queryResults ?? savedRun.queryResults ?? [],
                profileId: savedRun.profileId ?? profile.id,
                profileLabel: savedRun.profileLabel ?? persisted.profile_label ?? profile.label,
                queriesAttempted: progress.queriesAttempted ?? savedRun.queriesAttempted ?? 1,
                retryLimit: progress.retryLimit ?? savedRun.retryLimit ?? 2,
                queryPauseMinMs: progress.queryPauseMinMs ?? savedRun.queryPauseMinMs ?? 20_000,
                queryPauseMaxMs: progress.queryPauseMaxMs ?? savedRun.queryPauseMaxMs ?? 40_000,
                maxQueriesPerRun: progress.maxQueriesPerRun ?? savedRun.maxQueriesPerRun ?? 10,
                maxPostsPerDay: progress.maxPostsPerDay ?? savedRun.maxPostsPerDay ?? 10_000,
                dailyPostsScanned: progress.dailyPostsScanned ?? savedRun.dailyPostsScanned ?? 0,
                currentQueryRetries: progress.currentQueryRetries ?? savedRun.currentQueryRetries ?? 0,
                waitingForNextQuery: progress.waitingForNextQuery ?? savedRun.waitingForNextQuery ?? progress.counters?.queryStatus === "completed"
              });
            }
          }
        }
      } catch (error) {
        if (active) {
          setConnected(false);
          setServiceError(formatError(error));
        }
      } finally {
        if (active) setChecking(false);
      }
    }).catch((error: unknown) => {
      if (active) {
        setServiceError(formatError(error));
        setChecking(false);
      }
    });
    return () => { active = false; };
  }, [loadData]);

  useEffect(() => {
    const onRuntimeMessage = (message: {
      type?: string;
      run?: SearchRunState;
      profile?: CountryFilterProfile;
      runId?: number;
      error?: string;
    }) => {
      if (message.type === "RUN_STATE" && message.run) {
        setSearchRun(message.run);
      } else if (message.type === "FILTER_PROFILE_UPDATED" && message.profile) {
        const profile = message.profile;
        setCountryFilters((profiles) => [
          ...profiles.filter((item) => item.country_code !== profile.country_code),
          profile
        ]);
      } else if (message.type === "RUN_DISCARDED") {
        setSearchRun(null);
      } else if (message.type === "RUN_PERSIST_ERROR") {
        setServiceError(message.error ?? "Could not save search progress.");
      }
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, []);

  useEffect(() => {
    if (!searchRun?.runId || !connected) return;
    api.recentCaptures(searchRun.runId).then((recentCaptures) => {
      setSearchRun((current) => current?.runId === searchRun.runId ? { ...current, recentCaptures } : current);
    }).catch((error: unknown) => setServiceError(formatError(error)));
  }, [connected, searchRun?.runId, searchRun?.counters.newEmails, searchRun?.counters.duplicateEmails]);

  useEffect(() => {
    if (!connected) return;
    const intervalId = window.setInterval(() => {
      void api.today().then(async (today) => {
        setSummary(today);
        setDailyComparison(await api.daily(today.date));
        setMasterInfo(await api.masterStatus());
      }).catch((error: unknown) => {
        setConnected(false);
        setServiceError(formatError(error));
      });
    }, searchRun?.status === "running" ? 5_000 : 20_000);
    return () => window.clearInterval(intervalId);
  }, [connected, searchRun?.status]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("trackerTheme", theme);
  }, [theme]);

  useEffect(() => {
    if (connected && page === "history") {
      setHistoryLoading(true);
      setHistoryError("");
      Promise.all([
        api.history(historyPeriod, historyDate, historyCountry || undefined),
        api.dailyHistory(historyPeriod, historyDate, historyCountry || undefined)
      ])
        .then(([result, comparison]) => {
          setHistorySummary(result);
          setDailyHistory(comparison);
          setHistoryLoading(false);
        })
        .catch((error: unknown) => {
          setHistorySummary(null);
          setDailyHistory(null);
          setHistoryError(formatError(error));
          setHistoryLoading(false);
        });
    }
  }, [connected, page, historyPeriod, historyDate, historyCountry, summary?.last_saved_at]);

  const countries = useMemo(
    () => [...new Set(queries.map((query) => query.country_code))]
      .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b))),
    [queries]
  );
  const dailyHistoryCountries = useMemo(() => {
    const grouped = new Map<string, { collected: number; already: number; newCount: number }>();
    for (const row of dailyHistory?.days ?? []) {
      const current = grouped.get(row.country_code) ?? { collected: 0, already: 0, newCount: 0 };
      current.collected += row.collected;
      current.already += row.already_in_master;
      current.newCount += row.new;
      grouped.set(row.country_code, current);
    }
    return [...grouped.entries()].map(([country_code, counts]) => ({ country_code, ...counts }));
  }, [dailyHistory]);
  const dailyHistoryTotals = dailyHistoryCountries.reduce((total, row) => ({
    collected: total.collected + row.collected,
    already: total.already + row.already,
    newCount: total.newCount + row.newCount
  }), { collected: 0, already: 0, newCount: 0 });
  const enabledQueries = queries.filter((query) => Boolean(query.enabled));
  const countryStartQueries = countryQueries(enabledQueries, selectedCountry);
  const orderedQueries = [...queries].sort((a, b) => a.position - b.position || a.id - b.id);
  const orderedQueriesByCountry = [...queries].sort((a, b) =>
    a.country_code.localeCompare(b.country_code) || a.position - b.position || a.id - b.id
  );
  const liveQueryIndex = searchRun?.currentRecordNumber
    ? searchRun.currentRecordNumber - 1
    : searchRun ? Math.max(0, orderedQueriesByCountry.findIndex((query) => query.id === searchRun.queryId)) : -1;
  const settingsDirty = savedSettings !== null && JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const invalidSettings = settings.action_delay_min_ms > settings.action_delay_max_ms
    || settings.scan_delay_min_ms > settings.scan_delay_max_ms
    || settings.query_pause_min_ms > settings.query_pause_max_ms
    || !isValidTimezone(settings.timezone);
  const riskierSettings = settings.action_delay_min_ms < 1500
    || settings.action_delay_max_ms < 3000
    || settings.scan_delay_min_ms < 2000
    || settings.scan_delay_max_ms < 4000
    || settings.query_pause_min_ms < 20_000
    || settings.query_pause_max_ms < 40_000
    || settings.max_queries_per_run > 10
    || settings.max_posts_per_day > 10_000
    || settings.max_posts_per_query > 300
    || settings.max_scrolls_per_query > 50
    || settings.query_retry_limit > 2;

  const connectedAndRefresh = async () => {
    await loadData();
  };

  const retryCurrentPage = async () => {
    setServiceError("");
    await loadData();
    if (page === "history") {
      try {
        setHistoryLoading(true);
        setHistoryError("");
        setHistorySummary(await api.history(historyPeriod, historyDate, historyCountry || undefined));
      } catch (error) {
        setHistoryError(formatError(error));
      } finally {
        setHistoryLoading(false);
      }
    }
  };

  const copyExport = async (
    format: "csv" | "tsv",
    period: "day" | "week" | "month",
    date: string,
    country?: string
  ) => {
    setServiceError("");
    try {
      const result = await api.export(format, date, period, country);
      if (format === "tsv") {
        await navigator.clipboard.writeText(result);
        setNotice(period === "day" && date === summary?.date ? "Today's results copied." : `${period[0].toUpperCase()}${period.slice(1)} results copied.`);
      } else {
        const excelCsv = result.startsWith("\uFEFF") ? result : `\uFEFF${result}`;
        saveDownload(`tracker-${period}-${date}.csv`, excelCsv, "text/csv;charset=utf-8");
        setNotice("CSV downloaded.");
      }
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const recomputeToday = async () => {
    if (!summary) return;
    setDailyBusy(true);
    setServiceError("");
    try {
      setDailyComparison(await api.recomputeDaily(summary.date));
      setNotice("Today's comparison was recomputed.");
    } catch (error) {
      setServiceError(formatError(error));
    } finally {
      setDailyBusy(false);
    }
  };

  const uploadMasterFile = async (file?: File) => {
    if (!file) return;
    setMasterUploadBusy(true);
    setServiceError("");
    try {
      await api.uploadMaster(file);
      const [status, today] = await Promise.all([api.masterStatus(), api.daily(summary?.date ?? todayString())]);
      setMasterInfo(status);
      setDailyComparison(today);
      setNotice(`${file.name} imported. Today's comparison has been refreshed.`);
    } catch (error) {
      setServiceError(formatError(error));
    } finally {
      setMasterUploadBusy(false);
    }
  };

  const copyNewEmails = async () => {
    try {
      const text = (dailyComparison?.emails ?? [])
        .filter((email) => `${email.original_email} ${email.city} ${email.country_code}`.toLowerCase().includes(newEmailSearch.toLowerCase()))
        .map((email) => email.original_email)
        .join("\n");
      await navigator.clipboard.writeText(text);
      setNotice("New emails copied, one per line.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const downloadDailySheet = async () => {
    const date = dailyComparison?.date ?? summary?.date ?? todayString();
    try {
      const csv = await api.uniqueCsv(date);
      saveDownload(`Unique-Emails-${date}.csv`, csv, "text/csv;charset=utf-8");
      setNotice("Today's new-email CSV downloaded.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const downloadWorkbook = async () => {
    try {
      saveDownload("Unique-Emails.xlsx", await api.uniqueWorkbook(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      setNotice("The daily workbook downloaded.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const downloadHistoryDay = async (date: string) => {
    try {
      saveDownload(`Unique-Emails-${date}.csv`, await api.uniqueCsv(date), "text/csv;charset=utf-8");
      setNotice(`CSV for ${date} downloaded.`);
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const saveQuery = async (queryInput: QueryInput) => {
    setServiceError("");
    setNotice("");
    try {
      if (editor?.id) await api.updateQuery(editor.id, queryInput);
      else await api.createQuery(queryInput);
      setEditor(undefined);
      await loadData();
      setNotice(editor?.id ? "Query updated." : "Query added.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const deleteRecord = async (record: QueryRecord) => {
    if (!window.confirm(`Delete “${record.label}”? This cannot be undone.`)) return;
    try {
      await api.deleteQuery(record.id);
      await loadData();
      setNotice("Query deleted.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const reorder = async (record: QueryRecord, direction: -1 | 1) => {
    const sameCountry = orderedQueries.filter((query) => query.country_code === record.country_code);
    const index = sameCountry.findIndex((query) => query.id === record.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sameCountry.length) return;
    // Renumber the whole country 0..n-1 so records with equal positions can still move.
    const next = [...sameCountry];
    [next[index], next[target]] = [next[target], next[index]];
    try {
      await Promise.all(next
        .map((query, position) => ({ query, position }))
        .filter(({ query, position }) => query.position !== position)
        .map(({ query, position }) => api.updateQuery(query.id, { position })));
      await loadData();
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const setCountryEnabled = async (countryCode: string, enabled: boolean) => {
    try {
      await Promise.all(queries
        .filter((query) => query.country_code === countryCode && Boolean(query.enabled) !== enabled)
        .map((query) => api.updateQuery(query.id, { enabled })));
      await loadData();
      setNotice(`${countryLabel(countryCode)}: all records ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const openEditor = (record: QueryRecord | null, countryCode = "") => {
    setEditorCountry(record?.country_code ?? countryCode);
    setEditor(record);
  };

  const nextPositionFor = (countryCode: string) =>
    queries.filter((query) => query.country_code === countryCode.toUpperCase())
      .reduce((highest, query) => Math.max(highest, query.position + 1), 0);

  const recaptureCountry = (countryCode: string, preferred?: QueryRecord | null) => {
    const record = preferred && preferred.country_code === countryCode
      ? preferred
      : orderedQueries.find((query) => query.country_code === countryCode && Boolean(query.enabled));
    setEditor(undefined);
    setPage("view");
    if (record) {
      setSelectedCountry(record.country_code);
      setSelectedQuery(record.id);
      void startSearch(record);
    }
  };

  const toggleRecord = async (record: QueryRecord) => {
    try {
      await api.updateQuery(record.id, { enabled: !Boolean(record.enabled) });
      await loadData();
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const importQueries = async () => {
    const lines = importText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;
    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const hasHeader = header.includes("country_code") && header.includes("query_text");
    const fields = hasHeader ? header : ["country_code", "label", "query_text", "enabled", "notes"];
    const existingTexts = new Set(queries.map((query) => query.query_text.trim().toLowerCase()));
    const parsed = lines.slice(hasHeader ? 1 : 0).map((line) => {
      const cells = parseCsvLine(line);
      const value = (name: string, fallbackIndex: number) => cells[fields.indexOf(name) >= 0 ? fields.indexOf(name) : fallbackIndex] ?? "";
      return {
        country_code: value("country_code", 0).toUpperCase(),
        label: value("label", 1) || value("query_text", 2),
        query_text: value("query_text", 2),
        position: queries.length,
        enabled: value("enabled", 3).toLowerCase() !== "false" && value("enabled", 3) !== "0",
        notes: value("notes", 4)
      };
    }).filter((row) => row.country_code && row.label && row.query_text);
    const duplicates = parsed.filter((row) => existingTexts.has(row.query_text.trim().toLowerCase())).length;
    if (duplicates && !window.confirm(`${duplicates} query text duplicate(s) already exist. Import only new query texts?`)) return;
    try {
      let added = 0;
      for (const item of parsed) {
        const key = item.query_text.trim().toLowerCase();
        if (existingTexts.has(key)) continue;
        await api.createQuery(item);
        existingTexts.add(key);
        added++;
      }
      setImportOpen(false);
      setImportText("");
      await loadData();
      setNotice(`Imported ${added} query${added === 1 ? "" : "ies"}.`);
    } catch (error) {
      setServiceError(formatError(error));
      await loadData();
    }
  };

  // Keep the comma-list text boxes in sync when the lists change from outside (load, reset),
  // without reformatting what the user is typing.
  useEffect(() => {
    setJobWordsText((text) => splitList(text).join("|") === settings.post_job_words.join("|") ? text : settings.post_job_words.join(", "));
  }, [settings.post_job_words]);
  useEffect(() => {
    setPrefixesText((text) => splitList(text).join("|") === settings.ignored_email_prefixes.join("|") ? text : settings.ignored_email_prefixes.join(", "));
  }, [settings.ignored_email_prefixes]);

  const saveAppSettings = async (patch: Partial<AppSettings>) => {
    setSettingsBusy(true);
    setServiceError("");
    try {
      const saved = await api.saveSettings(patch);
      const merged = { ...defaultSettings, ...saved, timezone: displayTimezone(saved.timezone) };
      setSettings(merged);
      setSavedSettings(merged);
      setNotice("Settings saved.");
    } catch (error) {
      setServiceError(formatError(error));
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveProfileLabel = async () => {
    const label = profileLabel.trim();
    if (!label) {
      setServiceError("Enter a profile label.");
      return;
    }
    await chrome.storage.local.set({ profileLabel: label });
    setProfileLabel(label);
    setNotice("Profile label saved for this Chrome profile.");
  };

  const runBackup = async () => {
    try {
      const result = await api.backup();
      setNotice(`Copy saved in data\\backups (${result.backup.split(/[\\/]/).pop()}).`);
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const startSearch = async (recordOverride?: QueryRecord) => {
    const startingRecord = recordOverride ?? selectedRecord;
    if (!startingRecord) return;
    if (!Boolean(startingRecord.enabled)) {
      setServiceError("This query is disabled. Enable it in Queries before starting.");
      return;
    }
    setServiceError("");
    setNotice("");
    try {
      const filters: QueryFilters = experimentalAutomaticFilters ? {
        date_posted: startingRecord.date_posted ?? defaultFilters.date_posted,
        sort_by: startingRecord.sort_by ?? defaultFilters.sort_by,
        content_type: startingRecord.content_type ?? defaultFilters.content_type,
        from_member: startingRecord.from_member ?? "",
        other_note: startingRecord.other_note ?? ""
      } : defaultFilters;
      const searchUrl = buildLinkedInSearchUrl(startingRecord.query_text, filters);
      const sameCountryRecords = enabledQueries
        .filter((query) => query.country_code === startingRecord.country_code)
        .sort((a, b) => a.position - b.position || a.id - b.id);
      const startingIndex = sameCountryRecords.findIndex((query) => query.id === startingRecord.id);
      const status = experimentalAutomaticFilters ? "running" as const : "awaiting_filters" as const;
      const stage = experimentalAutomaticFilters ? "opening" as const : "awaiting_filters" as const;
      const statusText = experimentalAutomaticFilters ? "Opening search" : `Set filters for ${startingRecord.country_code}`;
      const response = await api.createRun({
        current_query_id: startingRecord.id,
        continue_next: continueNext || runAllCountries,
        progress_json: { stage, statusText, queryText: startingRecord.query_text, searchUrl, filters, runAllCountries },
        profile_label: profileLabel,
        profile_id: profileId
      });
      await chrome.storage.local.set({ selectedCountryCode: startingRecord.country_code, selectedQueryId: startingRecord.id });
      const run: SearchRunState = {
        runId: response.id,
        queryId: startingRecord.id,
        queryText: startingRecord.query_text,
        continueNext: continueNext || runAllCountries,
        runAllCountries,
        status,
        stage,
        statusText,
        filters,
        searchUrl,
        filterResults: [],
        delayMinMs: settings.action_delay_min_ms,
        delayMaxMs: settings.action_delay_max_ms,
        scanDelayMinMs: settings.scan_delay_min_ms,
        scanDelayMaxMs: settings.scan_delay_max_ms,
        maxScrolls: settings.max_scrolls_per_query,
        maxPosts: settings.max_posts_per_query,
        stopAfterNoNewPosts: settings.stop_after_no_new_posts,
        ignoreGenericAddresses: settings.ignore_generic_addresses,
        ignoredEmailPrefixes: settings.ignored_email_prefixes,
        postRequireJobWords: settings.post_require_job_words,
        postJobWords: settings.post_job_words,
        postMatchQuery: settings.post_match_query,
        postRuleCustom: settings.post_rule_custom,
        counters: emptyCounters(),
        recentCaptures: [],
        processedPostIds: [],
        countryCode: startingRecord.country_code,
        cityLabel: startingRecord.label,
        profileId,
        profileLabel,
        queryResults: [],
        queriesAttempted: 1,
        retryLimit: settings.query_retry_limit,
        queryPauseMinMs: settings.query_pause_min_ms,
        queryPauseMaxMs: settings.query_pause_max_ms,
        maxQueriesPerRun: settings.max_queries_per_run,
        maxPostsPerDay: settings.max_posts_per_day,
        dailyPostsScanned: summary?.posts_scanned ?? 0,
        currentQueryRetries: 0,
        waitingForNextQuery: false,
        debugFilters,
        debugScan,
        continueOnFilterFailure,
        countryQueryIds: sameCountryRecords.map((query) => query.id),
        countryQueryIndex: startingIndex,
        currentRecordNumber: startingIndex + 1,
        capturedFilterParams: "",
        filterSummary: "",
        filterFallback: false,
        filtersConfigured: false,
        experimentalAutomaticFilters
      };
      setSearchRun(run);
      const result = await chrome.runtime.sendMessage({
        type: "START_SEARCH",
        run
      }) as { ok: boolean; error?: string };
      if (!result?.ok) throw new Error(result?.error ?? "The search could not be started.");
    } catch (error) {
      setServiceError(formatError(error));
      setSearchRun((current) => current ? {
        ...current,
        status: "error",
        stage: "error",
        statusText: "Could not start search",
        error: formatError(error)
      } : current);
    }
  };

  const sendRunAction = async (action: "PAUSE_SEARCH" | "RESUME_SEARCH" | "STOP_SEARCH" | "DISCARD_RUN") => {
    if (!searchRun) return;
    setServiceError("");
    try {
      const result = await chrome.runtime.sendMessage({ type: action, runId: searchRun.runId }) as {
        ok: boolean;
        error?: string;
      };
      if (!result?.ok) throw new Error(result?.error ?? "Could not update the run.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const retryPendingSave = async () => {
    if (!searchRun) return;
    setServiceError("");
    try {
      const result = await chrome.runtime.sendMessage({ type: "RETRY_SAVE", runId: searchRun.runId }) as {
        ok: boolean;
        error?: string;
      };
      if (!result?.ok) setServiceError(result?.error ?? "The pending save could not be retried.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const sendFilterChoice = async (choice: "capture" | "saved" | "skip" | "continue") => {
    if (!searchRun) return;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "FILTER_CHOICE",
        runId: searchRun.runId,
        choice
      }) as { ok?: boolean; error?: string };
      if (!result?.ok) throw new Error(result?.error ?? "Could not continue with the selected filter option.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const sendCountryBoundaryAction = async (action: "continue" | "skip") => {
    if (!searchRun) return;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "COUNTRY_BOUNDARY_ACTION",
        runId: searchRun.runId,
        action
      }) as { ok?: boolean; error?: string };
      if (!result?.ok) throw new Error(result?.error ?? "Could not continue the country flow.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const testSettingsToken = async () => {
    setServiceError("");
    setSettingsBusy(true);
    let succeeded = false;
    try {
      await recordConnectionLog("settings_test_clicked");
      await ensureService();
      await api.health();
      succeeded = true;
      setConnected(true);
      setNotice("Connected to the tracker service.");
      await loadData();
    } catch (error) {
      setServiceError(formatError(error));
    } finally {
      await recordConnectionLog("settings_test_finished", { success: succeeded });
      setSettingsBusy(false);
    }
  };

  const copyProfileId = async () => {
    try {
      await navigator.clipboard.writeText(profileId);
      setNotice("Profile ID copied.");
    } catch (error) {
      setServiceError(formatError(error));
    }
  };

  const settingsValidationMessage = !isValidTimezone(settings.timezone)
    ? "Choose a valid IANA timezone."
    : settings.action_delay_min_ms > settings.action_delay_max_ms
      || settings.scan_delay_min_ms > settings.scan_delay_max_ms
      || settings.query_pause_min_ms > settings.query_pause_max_ms
        ? "Each minimum delay must be less than or equal to its maximum."
        : "";

  const countriesToday = summary?.countries ?? [];
  const selectedRecord = countryStartQueries.find((query) => query.id === selectedQuery) ?? countryStartQueries[0];
  const selectedCountryFilter = countryFilters.find((profile) => profile.country_code === selectedCountry);
  const isRunActive = searchRun?.status === "running" || searchRun?.status === "paused" || searchRun?.status === "awaiting_filters" || searchRun?.status === "country_completed";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">EE</div>
          <div><strong>Email</strong><span>Extension</span></div>
        </div>
        <nav className="top-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${page === item.id ? "nav-item--active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => { setPage(item.id); setServiceError(""); setNotice(""); }}
            >
              <Icon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {!checking && !connected ? (
            <button type="button" className="connection-pill is-offline connection-pill--action" disabled={settingsBusy} onClick={() => void testSettingsToken()} title="The tracker service starts automatically. Click to try again now.">
              <i />{settingsBusy ? "Reconnecting…" : "Not connected · Reconnect"}
            </button>
          ) : (
            <span className={`connection-pill ${checking ? "is-checking" : "is-connected"}`} role="status" title="Tracker service is running and shared by every Chrome profile on this PC.">
              <i />{checking ? "Connecting…" : "Connected"}
            </span>
          )}
          <time className="topbar-date">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</time>
          <button className="theme-toggle" title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
            {theme === "light" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      <main className="main-content">
        <ErrorBoundary key={`${page}-${settingsSection}`}>
        {checking ? (
          <div className="page-loading"><LoadingState /></div>
        ) : !connected ? (
          <div className="setup-layout">
            <SetupScreen onConnected={() => {
              setConnected(true);
              setChecking(false);
              void loadData();
            }} />
            {serviceError && <p className="feedback feedback--error" role="alert">{serviceError}</p>}
          </div>
        ) : (
          <>
            <h1 className="sr-only">{page === "view" ? "Overview" : page === "queries" ? "Saved queries" : page === "history" ? "History" : "Settings"}</h1>
            {serviceError && (
              <div className="alert alert--error" role="alert">
                <span>{serviceError}</span><button type="button" onClick={() => void retryCurrentPage()}>Retry</button>
              </div>
            )}
            {notice && <div className="alert alert--success" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}

            {page === "view" && (
              <>
                <section className="metrics-grid" aria-label="Today at a glance">
                  <article className="metric-card card"><span className="metric-icon metric-icon--green">✓</span><span className="metric-label">New emails today</span><strong>{dailyComparison?.new ?? "—"}</strong><small>Not in your master list</small></article>
                  <article className="metric-card card"><span className="metric-icon metric-icon--blue">@</span><span className="metric-label">Collected today</span><strong>{dailyComparison?.collected ?? "—"}</strong><small>{dailyComparison ? `${dailyComparison.already_in_master} already in master` : "Comparing with master…"}</small></article>
                  <article className="metric-card card"><span className="metric-icon metric-icon--amber">◷</span><span className="metric-label">Run status</span><strong>{runStatusLabel(searchRun?.status)}</strong><small>{searchRun && searchRun.status !== "completed" && searchRun.status !== "stopped" ? `${countryLabel(searchRun.countryCode)} · ${searchRun.cityLabel}${searchRun.runAllCountries ? " · All countries" : ""}` : linkedinTabFound ? "LinkedIn tab open" : "Open a LinkedIn tab to start"}</small></article>
                  <article className="metric-card card"><span className="metric-icon metric-icon--purple">▤</span><span className="metric-label">Records searched today</span><strong>{summary?.queries_completed ?? 0}</strong><small>{(summary?.posts_scanned ?? 0).toLocaleString()} posts scanned</small></article>
                </section>

                <Panel
                  id="search-controls"
                  className="control-card"
                  title="Search controls"
                  subtitle="Choose a country and starting record."
                  summary={selectedRecord ? `${countryLabel(selectedRecord.country_code)} · ${selectedRecord.label}` : "No record selected"}
                  actions={<span className={`run-pill run-pill--${searchRun?.status ?? "ready"}`}>{searchRun?.statusText ?? "Ready to start"}</span>}
                >
                  <div className="control-copy">
                    <div className="readiness-row" aria-label="Search readiness">
                      <span className={`readiness ${linkedinTabFound ? "readiness--ok" : "readiness--idle"}`}><i />{linkedinTabFound ? "LinkedIn tab open" : "LinkedIn tab not open"}</span>
                      <span className={`readiness ${selectedCountryFilter ? "readiness--ok" : "readiness--idle"}`}><i />{selectedCountryFilter ? "Filters ready" : "Filters will be set on LinkedIn"}</span>
                    </div>
                    {!connected && <p className="alert alert--error" role="alert">{serviceError || "Tracker service unavailable. Open Settings and select Reconnect."}</p>}
                    <div className="form-grid">
                      <label className="field"><span>Country</span><select value={selectedCountry} disabled={isRunActive} onChange={(event) => {
                        const value = event.target.value;
                        setSelectedCountry(value);
                        const first = countryQueries(enabledQueries, value)[0];
                        setSelectedQuery(first?.id ?? "");
                        void chrome.storage.local.set({ selectedCountryCode: value, selectedQueryId: first?.id ?? null });
                      }}><option value="">Choose a country</option>{[...new Set(enabledQueries.map((query) => query.country_code))].sort((a, b) => countryLabel(a).localeCompare(countryLabel(b))).map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}</select></label>
                      <label className="field"><span>Starting record</span><select aria-label="Starting record" value={selectedRecord?.id ?? ""} disabled={isRunActive || !countryStartQueries.length} onChange={(event) => {
                        const id = event.target.value ? Number(event.target.value) : "";
                        setSelectedQuery(id);
                        void chrome.storage.local.set({ selectedQueryId: id || null });
                      }}><option value="">Choose a record</option>{countryStartQueries.map((query) => <option key={query.id} value={query.id}>{query.position + 1} – {query.label}</option>)}</select></label>
                    </div>
                    <div className="country-filter-chip">
                      <span>{selectedCountryFilter ? `${selectedCountryFilter.params ? summarizeFilterParams(selectedCountryFilter.params) : selectedCountryFilter.summary} · Captured ${new Date(selectedCountryFilter.captured_at).toLocaleString()}${new Date(selectedCountryFilter.captured_at).toDateString() !== new Date().toDateString() ? " · Stale" : ""}` : "No saved filter profile for this country"}</span>
                      <button type="button" className="inline-link" disabled={!selectedRecord || isRunActive} onClick={() => void startSearch(selectedRecord)}>Recapture</button>
                    </div>
                    <label className="checkbox-field">
                      <input type="checkbox" checked={runAllCountries} onChange={(event) => {
                        setRunAllCountries(event.target.checked);
                        void chrome.storage.local.set({ runAllCountries: event.target.checked });
                      }} disabled={isRunActive} />
                      <span>Run all countries</span><small>Starts at the selected record and runs every remaining record in every country, one by one, with the filters you set on the first record. No pause between countries.</small>
                    </label>
                    <label className="checkbox-field">
                      <input type="checkbox" checked={continueNext || runAllCountries} onChange={(event) => {
                        setContinueNext(event.target.checked);
                        void chrome.storage.local.set({ continueNext: event.target.checked });
                      }} disabled={isRunActive || runAllCountries} />
                      <span>Continue through this country&apos;s records</span><small>{runAllCountries ? "Included in Run all countries." : "The run pauses when this country is finished."}</small>
                    </label>
                    <div className="control-actions control-actions--inline">
                      <button type="button" className="button button--primary" disabled={!selectedRecord || !connected || isRunActive} onClick={() => void startSearch()}>▶ <span>Start</span></button>
                      {searchRun?.status === "paused" && !searchRun.pendingSave && <button type="button" className="button button--secondary" onClick={() => void sendRunAction("RESUME_SEARCH")}>▶ <span>Resume</span></button>}
                      <button type="button" className="button button--secondary" disabled={searchRun?.status !== "running" && searchRun?.status !== "awaiting_filters"} onClick={() => void sendRunAction("PAUSE_SEARCH")}>Ⅱ <span>Pause</span></button>
                      <button type="button" className="button button--danger-outline" disabled={!isRunActive} onClick={() => {
                        if (window.confirm("Stop this search run? The run will be saved as stopped and existing data will be kept.")) {
                          void sendRunAction("STOP_SEARCH");
                        }
                      }}>■ <span>Stop</span></button>
                    </div>
                  </div>
                </Panel>

                {searchRun?.status === "awaiting_filters" && (
                  <section className="card country-action-panel" aria-live="polite">
                    <strong>{searchRun.statusText}</strong>
                    <p>{searchRun.statusText.startsWith("Filters were lost.")
                      ? "Filters were lost. Set the filters again, then click Continue."
                      : searchRun.filterFallback
                        ? `LinkedIn does not expose filters in the URL. Choose filters on this first record, then Continue. The extension will reuse the current LinkedIn page's filter selection for the rest of ${countryLabel(searchRun.countryCode)} by changing only the search text. This fallback is limited to the current LinkedIn tab.`
                        : "Set your filters on LinkedIn now (Date posted, Sort by, Content type, From member), then click Continue."}</p>
                    <div className="button-row">
                      <button className="button button--primary" type="button" onClick={() => void sendFilterChoice(searchRun.filterFallback ? "continue" : "capture")}>Continue</button>
                      {countryFilters.some((profile) => profile.country_code === searchRun.countryCode && Boolean(profile.params)) && <button className="button button--secondary" type="button" onClick={() => void sendFilterChoice("saved")}>Use saved filters</button>}
                      <button className="button button--secondary" type="button" onClick={() => void sendFilterChoice("skip")}>Skip filters</button>
                      <button className="button button--danger-outline" type="button" onClick={() => void sendRunAction("STOP_SEARCH")}>Stop</button>
                    </div>
                  </section>
                )}
                {searchRun?.status === "country_completed" && (
                  <section className="card country-action-panel" aria-live="polite">
                    <strong>Country finished</strong><p>{searchRun.statusText}</p>
                    <div className="button-row">
                      {searchRun.nextCountryCode && <button className="button button--primary" type="button" onClick={() => void sendCountryBoundaryAction("continue")}>Set filters &amp; continue with {countryLabel(searchRun.nextCountryCode)}</button>}
                      {searchRun.nextCountryCode && <button className="button button--secondary" type="button" onClick={() => void sendCountryBoundaryAction("skip")}>Skip country</button>}
                      <button className="button button--danger-outline" type="button" onClick={() => void sendRunAction("STOP_SEARCH")}>Stop</button>
                    </div>
                  </section>
                )}

                {isRunActive && searchRun && (
                  <Panel
                    id="live-run"
                    className="run-progress-card"
                    title="Live run"
                    subtitle={`${countryLabel(searchRun.countryCode)} · ${searchRun.cityLabel}`}
                    summary={`${searchRun.counters.postsScanned} posts · ${searchRun.counters.newEmails} new emails`}
                    actions={<span className={`run-pill run-pill--${searchRun.status}`}>{searchRun.statusText}</span>}
                  >
                    <div className="panel-stack" aria-live="polite">
                    <p className="live-query-text">{searchRun.queryText}</p>
                    <div className="live-query-progress"><span>Record {searchRun.currentRecordNumber ?? liveQueryIndex + 1} of {searchRun.countryQueryIds?.length ?? queries.length}</span><span>{searchRun.counters.queryStatus === "completed" ? "Record complete" : searchRun.statusText}</span></div>
                    <div className="progress-track" role="progressbar" aria-label="Current query scroll progress" aria-valuemin={0} aria-valuemax={searchRun.maxScrolls} aria-valuenow={Math.min(searchRun.counters.scrollCount, searchRun.maxScrolls)}><span style={{ width: `${Math.min(100, searchRun.counters.scrollCount / Math.max(1, searchRun.maxScrolls) * 100)}%` }} /></div>
                    <div className="live-counters">
                      <div><span>Scrolls</span><strong>{searchRun.counters.scrollCount}</strong></div>
                      <div><span>Posts scanned</span><strong>{searchRun.counters.postsScanned}</strong></div>
                      <div><span>Emails found</span><strong>{searchRun.counters.emailsFound}</strong></div>
                      <div><span>New</span><strong>{searchRun.counters.newEmails}</strong></div>
                      <div><span>Duplicates</span><strong>{searchRun.counters.duplicateEmails}</strong></div>
                      <div><span>Skipped by rule</span><strong>{searchRun.counters.skippedByRule ?? 0}</strong></div>
                    </div>
                    <div className="live-run-footer"><span>Last saved: {summary?.last_saved_at ? new Date(summary.last_saved_at).toLocaleTimeString() : "Not saved yet"}</span><div className="button-row">
                      {searchRun.status === "running" && <button className="button button--secondary" type="button" onClick={() => void sendRunAction("PAUSE_SEARCH")}>Pause</button>}
                      {searchRun.status === "paused" && !searchRun.pendingSave && <button className="button button--secondary" type="button" onClick={() => void sendRunAction("RESUME_SEARCH")}>Resume</button>}
                      {searchRun.status === "paused" && <button className="button button--danger-outline" type="button" disabled={searchRun.pendingSave} onClick={() => { if (window.confirm("Discard this run? Already saved results will remain.")) void sendRunAction("DISCARD_RUN"); }}>Discard</button>}
                      <button className="button button--danger-outline" type="button" onClick={() => { if (window.confirm("Stop this search run? The run will be saved as stopped and existing data will be kept.")) void sendRunAction("STOP_SEARCH"); }}>Stop</button>
                    </div></div>
                    {searchRun.error && <p className="feedback feedback--error" role="alert">{searchRun.error}</p>}
                    {(searchRun.stage === "scanning" || searchRun.counters.postsScanned > 0 || searchRun.counters.queryStatus === "completed") && (
                      <div className="scan-summary" aria-live="polite">
                        <span>Scrolling ({searchRun.counters.scrollCount}/{searchRun.maxScrolls})</span>
                        <span>Posts scanned {searchRun.counters.postsScanned}/{searchRun.maxPosts}</span>
                        <strong>Emails found {searchRun.counters.emailsFound} · New {searchRun.counters.newEmails} · Duplicate {searchRun.counters.duplicateEmails} · Ignored {searchRun.counters.ignoredEmails}</strong>
                      </div>
                    )}
                    {searchRun.pendingSave && <button className="button button--secondary" type="button" onClick={() => void retryPendingSave()}>Retry pending save</button>}
                    {searchRun.filterResults.length > 0 && <ul className="filter-results">
                      {searchRun.filterResults.map((filter) => <FilterResultRow key={filter.key} result={filter} />)}
                    </ul>}
                    {searchRun.queryResults.length > 0 && <ul className="query-run-results" aria-label="Query run results">
                      {searchRun.queryResults.map((result, index) => <li key={`${result.queryId}-${index}`}><span>{result.label}</span><strong>{result.status}</strong>{result.error && <small>{result.error}</small>}</li>)}
                    </ul>}
                    <p className="helper-text">Queries completed in this run: {searchRun.queryResults.filter((result) => result.status === "completed").length} / {searchRun.queriesAttempted} attempted. Last saved: {summary?.last_saved_at ? new Date(summary.last_saved_at).toLocaleString() : "—"}.</p>
                    </div>
                  </Panel>
                )}
                {searchRun?.status === "error" && (
                  <section className="card run-progress-card" role="alert">
                    <div className="card-heading"><h2>Run needs attention</h2><p className="muted">{searchRun.error ?? searchRun.statusText}</p></div>
                    <button className="button button--secondary" type="button" onClick={() => void retryCurrentPage()}>Retry connection</button>
                  </section>
                )}

                <Panel
                  id="today-results"
                  className="table-card"
                  title="Today's results"
                  subtitle="Emails captured today compared with the current master list."
                  summary={dailyComparison ? `${dailyComparison.new} new · ${dailyComparison.collected} collected` : undefined}
                  actions={<button className="button button--secondary button--small" type="button" disabled={dailyBusy} onClick={() => void recomputeToday()}>{dailyBusy ? "Recomputing…" : "Recompute now"}</button>}
                >
                  <div className="panel-stack">
                  {masterInfo?.current ? (
                    <p className="status-chip status-chip--ready">Master: {masterInfo.current.file_name}, {masterInfo.current.email_count.toLocaleString()} emails, uploaded {new Date(masterInfo.current.uploaded_at).toLocaleDateString()}</p>
                  ) : <p className="alert alert--warning">Upload your master email file in Settings to compare against existing addresses.</p>}
                  {masterInfo?.current && summary && timestampLocalDate(masterInfo.current.uploaded_at, settings.timezone) !== summary.date && <p className="alert alert--warning">Upload today's master file for the latest comparison.</p>}
                  {dailyComparison ? <>
                    {dailyComparison.emails.length ? <>
                      <label className="field"><span>Search new emails</span><input type="search" value={newEmailSearch} onChange={(event) => setNewEmailSearch(event.target.value)} placeholder="Email, country or city" /></label>
                      <div className="table-wrap"><table><thead><tr><th>Email</th><th>Country</th><th>City</th><th>Post</th></tr></thead><tbody>
                        {dailyComparison.emails.filter((email) => `${email.original_email} ${countryLabel(email.country_code)} ${email.city}`.toLowerCase().includes(newEmailSearch.toLowerCase())).map((email, index) => <tr key={`${email.original_email}-${index}`}><td>{email.original_email}</td><td>{countryLabel(email.country_code)}</td><td>{email.city || "—"}</td><td>{email.post_url ? <a href={email.post_url} target="_blank" rel="noreferrer">Open post</a> : "Link unavailable"}</td></tr>)}
                      </tbody></table></div>
                    </> : <EmptyState title="No new emails today" text="Start a search to see genuinely new email addresses here." />}
                    <div className="table-footer"><span>{dailyComparison.new} new addresses</span><div className="button-row">
                      <button className="button button--secondary button--small" type="button" disabled={!dailyComparison.emails.length} onClick={() => void copyNewEmails()}>Copy emails</button>
                      <button className="button button--primary button--small" type="button" disabled={!dailyComparison.new} onClick={() => void downloadDailySheet()}>Download today's sheet</button>
                    </div></div>
                  </> : <LoadingState />}
                  </div>
                </Panel>
              </>
            )}

            {page === "queries" && (
              <section className="card queries-card">
                <div className="section-title-row table-heading">
                  <div><h2>Query records <span className="count-badge">{queries.length}</span></h2><p className="muted">Filters are saved with each record for later use.</p></div>
                  <div className="button-row">
                    <button className="button button--secondary button--small" type="button" onClick={() => {
                      const data = ["country_code,label,query_text,enabled,notes", ...orderedQueries.map((item) => [item.country_code, item.label, item.query_text, Boolean(item.enabled), item.notes].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))].join("\r\n");
                      saveDownload("job-post-queries.csv", data, "text/csv;charset=utf-8");
                    }}>Export</button>
                    <button className="button button--secondary button--small" type="button" onClick={() => setImportOpen(true)}>Import</button>
                    <button className="button button--primary button--small" type="button" onClick={() => openEditor(null)}>＋ Add country</button>
                  </div>
                </div>
                {queries.length === 0 ? <EmptyState title="No saved queries yet" text="Add a country with its first search record, or import query records." /> : (() => {
                  const term = querySearch.trim().toLowerCase();
                  const matches = (query: QueryRecord) => !term
                    || `${query.label} ${query.query_text} ${countryLabel(query.country_code)} ${query.country_code}`.toLowerCase().includes(term);
                  const recordsOf = (code: string) => orderedQueries.filter((query) => query.country_code === code);
                  const visibleCountries = countries.filter((code) => recordsOf(code).some(matches));
                  const active = visibleCountries.includes(queryCountry) ? queryCountry : visibleCountries[0] ?? "";
                  const activeRecords = recordsOf(active);
                  const shownRecords = activeRecords.filter(matches);
                  const activeEnabled = activeRecords.filter((query) => Boolean(query.enabled)).length;
                  const profileOf = (code: string) => countryFilters.find((profile) => profile.country_code === code);
                  const profileState = (code: string) => {
                    const profile = profileOf(code);
                    if (!profile) return "none";
                    return new Date(profile.captured_at).toDateString() === new Date().toDateString() ? "fresh" : "stale";
                  };
                  const activeProfile = profileOf(active);
                  return (
                    <>
                      <div className="qx-toolbar">
                        <label className="qx-search">
                          <span aria-hidden="true">⌕</span>
                          <input type="search" value={querySearch} onChange={(event) => setQuerySearch(event.target.value)} placeholder="Search countries, cities or query text" aria-label="Search queries" />
                        </label>
                        <span className="qx-totals">{countries.length} countries · {enabledQueries.length}/{queries.length} records enabled</span>
                      </div>
                      {visibleCountries.length === 0 ? <EmptyState title="No matches" text={`Nothing matches “${querySearch}”.`} /> : (
                        <div className="qx-layout">
                          <nav className="qx-countries" aria-label="Countries">
                            {visibleCountries.map((code) => {
                              const records = recordsOf(code);
                              const enabledCount = records.filter((query) => Boolean(query.enabled)).length;
                              const state = profileState(code);
                              return (
                                <button key={code} type="button" className={`qx-country ${code === active ? "qx-country--active" : ""}`} aria-current={code === active ? "true" : undefined} onClick={() => setQueryCountry(code)}>
                                  <span className="qx-code">{code}</span>
                                  <span className="qx-country-text"><strong>{countryLabel(code)}</strong><small>{enabledCount}/{records.length} enabled</small></span>
                                  <span className={`qx-dot qx-dot--${state}`} title={state === "fresh" ? "Filters captured today" : state === "stale" ? "Filters captured earlier (stale)" : "No filters captured yet"} />
                                </button>
                              );
                            })}
                          </nav>
                          <section className="qx-detail" aria-label={`${countryLabel(active)} records`}>
                            <header className="qx-detail-head">
                              <div className="qx-detail-title">
                                <span className="qx-code qx-code--large">{active}</span>
                                <div><h3>{countryLabel(active)}</h3><p className="muted">{activeRecords.length} records · {activeEnabled} enabled</p></div>
                              </div>
                              <div className="button-row">
                                <button className="button button--secondary button--small" type="button" onClick={() => void setCountryEnabled(active, activeEnabled < activeRecords.length)}>{activeEnabled < activeRecords.length ? "Enable all" : "Disable all"}</button>
                                <button className="button button--primary button--small" type="button" onClick={() => openEditor(null, active)}>＋ Add record</button>
                              </div>
                            </header>
                            <div className={`qx-filters qx-filters--${profileState(active)}`}>
                              <div>
                                <strong>LinkedIn filters</strong>
                                <span>{activeProfile ? (activeProfile.params ? summarizeFilterParams(activeProfile.params) : activeProfile.summary) : "Not captured yet. You set them on LinkedIn when you start this country."}</span>
                                {activeProfile && <small>Captured {new Date(activeProfile.captured_at).toLocaleString()}{profileState(active) === "stale" ? " · stale, recapture before the next run" : ""}</small>}
                              </div>
                              <button className="button button--secondary button--small" type="button" disabled={activeEnabled === 0} onClick={() => recaptureCountry(active)}>{activeProfile ? "Recapture" : "Capture now"}</button>
                            </div>
                            <ol className="qx-records">
                              {shownRecords.map((record) => {
                                const index = activeRecords.findIndex((query) => query.id === record.id);
                                return (
                                  <li className={`qx-record ${!Boolean(record.enabled) ? "qx-record--disabled" : ""}`} key={record.id}>
                                    <span className="qx-order">{index + 1}</span>
                                    <div className="qx-record-text">
                                      <strong>{record.label}</strong>
                                      <code title={record.query_text}>{record.query_text}</code>
                                      {record.notes && <small>{record.notes}</small>}
                                    </div>
                                    <label className="toggle-field" title={Boolean(record.enabled) ? "Disable record" : "Enable record"}><input type="checkbox" aria-label={`${record.label} enabled`} checked={Boolean(record.enabled)} onChange={() => void toggleRecord(record)} /><span /></label>
                                    <div className="qx-actions">
                                      <button className="icon-button" type="button" disabled={index === 0} title="Move up" aria-label={`Move ${record.label} up`} onClick={() => void reorder(record, -1)}>↑</button>
                                      <button className="icon-button" type="button" disabled={index === activeRecords.length - 1} title="Move down" aria-label={`Move ${record.label} down`} onClick={() => void reorder(record, 1)}>↓</button>
                                      <button className="button button--secondary button--small" type="button" onClick={() => openEditor(record)}>Edit</button>
                                      <button className="icon-button qx-delete" type="button" title="Delete record" aria-label={`Delete ${record.label}`} onClick={() => void deleteRecord(record)}>✕</button>
                                    </div>
                                  </li>
                                );
                              })}
                            </ol>
                          </section>
                        </div>
                      )}
                    </>
                  );
                })()}
              </section>
            )}

            {page === "history" && (
              <>
                <section className="card filters-card">
                  <label className="field"><span>Period</span><select value={historyPeriod} onChange={(event) => setHistoryPeriod(event.target.value as typeof historyPeriod)}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label>
                  <label className="field"><span>Date</span><input type="date" value={historyDate} onChange={(event) => setHistoryDate(event.target.value)} /></label>
                  <label className="field"><span>Country</span><select value={historyCountry} onChange={(event) => setHistoryCountry(event.target.value)}><option value="">All countries</option>{countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}</select></label>
                  <span className="history-range-hint">{dailyHistory ? historyPeriodLabel(historyPeriod, dailyHistory.start, dailyHistory.end) : "Loading selected dates…"}</span>
                </section>
                {historyLoading ? <section className="card table-card"><LoadingState /></section> : historyError ? (
                  <section className="card table-card"><EmptyState title="Could not load this period" text={historyError} action={<button className="button button--secondary" type="button" onClick={() => void retryCurrentPage()}>Retry</button>} /></section>
                ) : !dailyHistory ? <section className="card table-card"><LoadingState /></section> : !dailyHistoryCountries.length ? (
                  <section className="card table-card"><EmptyState title="No results in this period" text="Choose another date range or country." /></section>
                ) : (
                  <>
                    <section className="metrics-grid history-metrics" aria-label="Period totals">
                      <article className="metric-card card"><span className="metric-label">Collected</span><strong>{dailyHistoryTotals.collected}</strong><small>{historyPeriodLabel(historyPeriod, dailyHistory.start, dailyHistory.end)}</small></article>
                      <article className="metric-card card"><span className="metric-label">Already in master</span><strong>{dailyHistoryTotals.already}</strong><small>Not new</small></article>
                      <article className="metric-card card"><span className="metric-label">New / unique</span><strong>{dailyHistoryTotals.newCount}</strong><small>{dailyHistoryCountries.length} countries</small></article>
                    </section>
                    <Panel
                      id="history-countries"
                      className="table-card"
                      title="By country"
                      subtitle={historyPeriodLabel(historyPeriod, dailyHistory.start, dailyHistory.end)}
                      summary={`${dailyHistoryCountries.length} countries · ${dailyHistoryTotals.newCount} new`}
                      actions={<button className="button button--secondary button--small" type="button" onClick={() => void downloadWorkbook()}>Download workbook</button>}
                    >
                      <div className="table-wrap"><table><thead><tr><th>Country</th><th>Collected</th><th>Already in master</th><th>New</th></tr></thead><tbody>
                        {dailyHistoryCountries.map((row) => <tr key={row.country_code}><td>{countryLabel(row.country_code)}</td><td className="number-cell">{row.collected}</td><td className="number-cell">{row.already}</td><td className="number-cell">{row.newCount}</td></tr>)}
                        <tr className="totals-row"><th>Total</th><th className="number-cell">{dailyHistoryTotals.collected}</th><th className="number-cell">{dailyHistoryTotals.already}</th><th className="number-cell">{dailyHistoryTotals.newCount}</th></tr>
                      </tbody></table></div>
                    </Panel>
                    <Panel id="history-chart" title="New emails by country" summary={`Top: ${countryLabel([...dailyHistoryCountries].sort((a, b) => b.newCount - a.newCount)[0].country_code)}`}>
                      <div className="chart-card">{dailyHistoryCountries.map((row) => {
                        const maximum = Math.max(...dailyHistoryCountries.map((item) => item.newCount), 1);
                        return <div className="bar-row" key={row.country_code}><span title={countryLabel(row.country_code)}>{countryLabel(row.country_code)}</span><div className="bar-track"><div className="bar-fill" style={{ width: row.newCount > 0 ? `${Math.max(2, row.newCount / maximum * 100)}%` : "0" }} /></div><strong>{row.newCount}</strong></div>;
                      })}</div>
                    </Panel>
                    <Panel id="history-days" className="table-card" title="Day by day" summary={`${dailyHistory.days.length} rows`}>
                      <div className="table-wrap"><table><thead><tr><th>Day</th><th>Country</th><th>Collected</th><th>Already in master</th><th>New</th><th>Export</th></tr></thead><tbody>
                        {dailyHistory.days.map((row, index) => <tr key={`${row.day}-${row.country_code}-${index}`}><td>{formatDisplayDate(row.day)}</td><td>{countryLabel(row.country_code)}</td><td className="number-cell">{row.collected}</td><td className="number-cell">{row.already_in_master}</td><td className="number-cell">{row.new}</td><td><button className="button button--secondary button--small" type="button" disabled={!row.new} onClick={() => void downloadHistoryDay(row.day)}>Download CSV</button></td></tr>)}
                      </tbody></table></div>
                    </Panel>
                  </>
                )}
              </>
            )}

            {page === "settings" && (
              <div className="sx-layout">
                <nav className="sx-nav" aria-label="Settings sections">
                  {SETTINGS_SECTIONS.map((section) => (
                    <button key={section.id} type="button" className={`sx-nav-item ${settingsSection === section.id ? "sx-nav-item--active" : ""}`} aria-current={settingsSection === section.id ? "page" : undefined} onClick={() => setSettingsSection(section.id)}>
                      <span className="sx-nav-icon"><Icon name={section.icon} /></span>
                      <span className="sx-nav-text"><strong>{section.title}</strong><small>{section.hint}</small></span>
                      {section.id === "limits" && riskierSettings && <span className="sx-flag" title="Some values are riskier than recommended">!</span>}
                    </button>
                  ))}
                </nav>

                <div className="sx-panel">
                  {settingsValidationMessage && <p className="alert alert--error" role="alert">{settingsValidationMessage}</p>}

                  {settingsSection === "general" && (
                    <>
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>Default start record</h2><p className="muted">Where a run begins when you press Start in the extension popup. The View page keeps its own selection.</p></header>
                        <div className="sx-fields">
                          <label className="field"><span>Starting country</span><select value={settings.starting_country ?? ""} onChange={(event) => {
                            const country = event.target.value || null;
                            const keepQuery = orderedQueries.some((query) => query.id === settings.starting_query_id && (!country || query.country_code === country));
                            setSettings({ ...settings, starting_country: country, starting_query_id: keepQuery ? settings.starting_query_id : null });
                          }}><option value="">Any country</option>{countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}</select></label>
                          <label className="field"><span>Starting record</span><select value={settings.starting_query_id ?? ""} onChange={(event) => setSettings({ ...settings, starting_query_id: event.target.value ? Number(event.target.value) : null })}><option value="">First enabled record</option>{orderedQueries.filter((query) => !settings.starting_country || query.country_code === settings.starting_country).map((query) => <option key={query.id} value={query.id}>{settings.starting_country ? query.label : `${countryLabel(query.country_code)} — ${query.label}`}</option>)}</select></label>
                        </div>
                      </section>
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>Timezone</h2><p className="muted">Decides which day a capture belongs to in History, exports and the daily workbook.</p></header>
                        <label className="field sx-narrow"><span>Timezone</span><input list="timezone-options" value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: displayTimezone(event.target.value) })} aria-label="Search timezone" /><datalist id="timezone-options">{[Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Kolkata", "Asia/Calcutta", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Zurich", "Europe/Stockholm", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Toronto", "America/Vancouver", "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland", "UTC"].filter((zone, index, all) => all.indexOf(zone) === index).map((zone) => <option key={zone} value={zone} />)}</datalist><small>This computer: {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></label>
                      </section>
                    </>
                  )}

                  {settingsSection === "general" && (
                    <>
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>This Chrome profile</h2><p className="muted">A label helps you tell profiles apart in runs and query locks.</p></header>
                        <div className="sx-inline">
                          <label className="field"><span>Profile label</span><input value={profileLabel} maxLength={120} onChange={(event) => setProfileLabel(event.target.value)} placeholder="e.g. Job search profile 1" /></label>
                          <button className="button button--secondary" type="button" onClick={() => void saveProfileLabel()}>Save label</button>
                        </div>
                        <div className="sx-row">
                          <div><strong>Profile ID</strong><code title={profileId}>{shortProfileId(profileId || "Loading…")}</code></div>
                          <button className="button button--secondary button--small" type="button" disabled={!profileId} onClick={() => void copyProfileId()}>Copy</button>
                        </div>
                      </section>
                    </>
                  )}

                  {settingsSection === "collecting" && (() => {
                    const testRecord = orderedQueries.find((query) => query.id === ruleTestRecordId) ?? orderedQueries.find((query) => Boolean(query.enabled)) ?? orderedQueries[0];
                    const customCheck = settings.post_rule_custom.trim() ? checkRule(settings.post_rule_custom, "") : null;
                    const invalidQueries = orderedQueries.filter((query) => !checkRule(query.query_text, "").valid);
                    const anyCheckOn = (settings.post_require_job_words && settings.post_job_words.length > 0) || settings.post_match_query || Boolean(settings.post_rule_custom.trim());
                    const test = rulePostSample.trim() ? evaluatePost({
                      requireJobWords: settings.post_require_job_words,
                      jobWords: settings.post_job_words,
                      matchQuery: settings.post_match_query,
                      queryText: testRecord?.query_text ?? "",
                      customRule: settings.post_rule_custom
                    }, rulePostSample) : null;
                    const defaultWords = DEFAULT_JOB_WORDS.join("|") === settings.post_job_words.join("|");
                    return (
                      <>
                        <section className="sx-card">
                          <header className="sx-card-head"><h2>Which posts are collected</h2><p className="muted">Your LinkedIn search already finds posts about the job you want. These checks make sure a post is really a job post before its emails are saved. A post must contain an email and pass every check that is on.</p></header>

                          <div className="check-block">
                            <label className="sx-switch">
                              <span><strong>Must look like a job post</strong><small>At least one of the words below must appear in the post. Recommended.</small></span>
                              <span className="toggle-field"><input type="checkbox" checked={settings.post_require_job_words} onChange={(event) => setSettings({ ...settings, post_require_job_words: event.target.checked })} /><span /></span>
                            </label>
                            {settings.post_require_job_words && (
                              <div className="check-detail">
                                <label className="field">
                                  <span>Job words</span>
                                  <textarea rows={3} value={jobWordsText} spellCheck={false} onChange={(event) => {
                                    setJobWordsText(event.target.value);
                                    setSettings({ ...settings, post_job_words: splitList(event.target.value) });
                                  }} placeholder="hiring, vacancy, immediate joiner, send your cv" />
                                  <small>Separate with commas. Each entry is a word or phrase; add * for any ending, e.g. <code>recruit*</code>.</small>
                                </label>
                                {!defaultWords && <button className="button button--text button--small" type="button" onClick={() => setSettings({ ...settings, post_job_words: [...DEFAULT_JOB_WORDS] })}>Reset to default words</button>}
                              </div>
                            )}
                          </div>

                          <div className="check-block">
                            <label className="sx-switch">
                              <span><strong>Must match the record's search query</strong><small>Stricter: every AND part of the record's query must appear in the post. Leave off if LinkedIn's results are already relevant.</small></span>
                              <span className="toggle-field"><input type="checkbox" checked={settings.post_match_query} onChange={(event) => setSettings({ ...settings, post_match_query: event.target.checked })} /><span /></span>
                            </label>
                            {settings.post_match_query && invalidQueries.length > 0 && (
                              <p className="alert alert--warning check-detail" role="status">{invalidQueries.length} record{invalidQueries.length > 1 ? "s have" : " has"} a query that can't be checked ({invalidQueries.slice(0, 3).map((query) => `${countryLabel(query.country_code)} – ${query.label}`).join(", ")}{invalidQueries.length > 3 ? "…" : ""}). This check is skipped for them until the query is fixed in Queries.</p>
                            )}
                          </div>

                          <div className="check-block">
                            <label className="field">
                              <span>Extra rule <em className="optional">optional</em></span>
                              <textarea className="rule-input" rows={2} value={settings.post_rule_custom} onChange={(event) => setSettings({ ...settings, post_rule_custom: event.target.value })} placeholder={'e.g.  "remote" OR "work from home"'} spellCheck={false} />
                              {customCheck && !customCheck.valid ? <small className="rule-error">{customCheck.error} The extra rule is skipped until this is fixed.</small> : <small>Every post must also match this, for every record. Leave empty for no extra rule.</small>}
                            </label>
                          </div>

                          {!anyCheckOn && <p className="alert alert--warning" role="status">All checks are off, so every post that contains an email will be collected.</p>}
                        </section>

                        <section className="sx-card">
                          <details className="rule-help">
                            <summary><span><strong>How to write a rule</strong><small>For the extra rule and record queries. Same style as a LinkedIn search.</small></span></summary>
                            <dl className="rule-syntax">
                              <div><dt><code>London AND hiring</code></dt><dd>Both words must be in the post. <code>London hiring</code> means the same.</dd></div>
                              <div><dt><code>React OR Angular</code></dt><dd>At least one of them.</dd></div>
                              <div><dt><code>"Data Analyst"</code></dt><dd>The exact phrase. Also use quotes for words with symbols, like <code>"C++"</code>.</dd></div>
                              <div><dt><code>( … )</code></dt><dd>Group choices: <code>("Java" OR "Kotlin") AND Pune</code>.</dd></div>
                              <div><dt><code>NOT intern</code></dt><dd>Skip posts that contain the word.</dd></div>
                              <div><dt><code>recruit*</code></dt><dd>Any word starting with it: recruit, recruiter, recruiting.</dd></div>
                            </dl>
                            <p className="muted rule-help-note">Letter case, extra spaces and LinkedIn's bold or italic letters don't matter. Words inside email addresses are ignored.</p>
                          </details>
                        </section>

                        <section className="sx-card">
                          <header className="sx-card-head"><h2>Test a post</h2><p className="muted">Paste a LinkedIn post to see whether its emails would be collected with the settings above.</p></header>
                          {settings.post_match_query && orderedQueries.length > 0 && (
                            <label className="field"><span>Record (for the search-query check)</span><select value={testRecord?.id ?? ""} onChange={(event) => setRuleTestRecordId(event.target.value ? Number(event.target.value) : "")}>{orderedQueries.map((query) => <option key={query.id} value={query.id}>{countryLabel(query.country_code)} — {query.label}</option>)}</select></label>
                          )}
                          <label className="field"><span>Post text</span><textarea rows={5} value={rulePostSample} onChange={(event) => setRulePostSample(event.target.value)} placeholder="Paste the full text of a LinkedIn post here" /></label>
                          {test && (
                            <div className={`rule-result ${test.accepted ? "rule-result--yes" : "rule-result--no"}`} role="status">
                              <strong>{test.accepted ? "✓ Emails in this post would be collected" : "✕ This post would be skipped"}</strong>
                              {test.checks.length === 0 ? <small>No checks are on.</small> : (
                                <ul className="check-results">
                                  {test.checks.map((check) => (
                                    <li key={check.id} className={check.passed === null ? "check--skipped" : check.passed ? "check--pass" : "check--fail"}>
                                      <span className="check-icon" aria-hidden="true">{check.passed === null ? "–" : check.passed ? "✓" : "✕"}</span>
                                      <div>
                                        <strong>{check.label}</strong>
                                        {check.passed === null ? <small>Skipped: {check.error}</small> : (
                                          <div className="rule-terms">
                                            {check.found.map((term) => <span key={`f-${term}`} className="rule-term rule-term--found">{term}</span>)}
                                            {check.id !== "job" && check.missing.map((term) => <span key={`m-${term}`} className="rule-term rule-term--missing">{term}</span>)}
                                            {check.id === "job" && !check.passed && <small>None of the job words were found.</small>}
                                          </div>
                                        )}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </section>
                      </>
                    );
                  })()}

                  {settingsSection === "limits" && (
                    <>
                      {riskierSettings && <p className="alert alert--warning" role="alert">Some delays are below the recommended minimums or limits are above the recommended maximums. This can increase the chance of LinkedIn account restrictions.</p>}
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>Scrolling</h2><p className="muted">How far down the LinkedIn results each record is scanned. A record stops at whichever limit it reaches first.</p></header>
                        <div className="sx-fields sx-fields--three">
                          <label className="field"><span>Scrolls per record</span><input type="number" min="1" max="50" value={settings.max_scrolls_per_query} onChange={(event) => setSettings({ ...settings, max_scrolls_per_query: Number(event.target.value) })} /><small>1–50. More scrolls find older posts.</small></label>
                          <label className="field"><span>Stop after scrolls with no new posts</span><input type="number" min="1" max="100" value={settings.stop_after_no_new_posts} onChange={(event) => setSettings({ ...settings, stop_after_no_new_posts: Number(event.target.value) })} /><small>Ends early when LinkedIn has no more results.</small></label>
                          <label className="field"><span>Posts per record</span><input type="number" min="1" max="10000" value={settings.max_posts_per_query} onChange={(event) => setSettings({ ...settings, max_posts_per_query: Number(event.target.value) })} /><small>Most posts scanned for one record.</small></label>
                        </div>
                        <div className="sx-delays">
                          <div className="sx-delays-head" aria-hidden="true"><span /><span>Minimum</span><span>Maximum</span></div>
                          <div className="sx-delay-row">
                            <div><strong>Wait between scrolls</strong><small>Recommended ≥ 2 s · allowed 0–120 s</small></div>
                            <label className="sx-unit"><input type="number" aria-label="Wait between scrolls minimum seconds" min={0} max={120} step={0.1} value={settings.scan_delay_min_ms / 1000} onChange={(event) => setSettings({ ...settings, scan_delay_min_ms: Number(event.target.value) * 1000 })} /><span>s</span></label>
                            <label className="sx-unit"><input type="number" aria-label="Wait between scrolls maximum seconds" min={0} max={120} step={0.1} value={settings.scan_delay_max_ms / 1000} onChange={(event) => setSettings({ ...settings, scan_delay_max_ms: Number(event.target.value) * 1000 })} /><span>s</span></label>
                          </div>
                        </div>
                      </section>
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>Delays</h2><p className="muted">A random delay between the minimum and maximum is used each time. Longer is safer.</p></header>
                        <div className="sx-delays">
                          <div className="sx-delays-head" aria-hidden="true"><span /><span>Minimum</span><span>Maximum</span></div>
                          {([
                            { title: "Filter action", hint: "Recommended ≥ 1.5 s · allowed 1.5–60 s", min: "action_delay_min_ms", max: "action_delay_max_ms", low: 1.5, high: 60, step: 0.1 },
                            { title: "Pause between records", hint: "Recommended ≥ 20 s · allowed 0–600 s", min: "query_pause_min_ms", max: "query_pause_max_ms", low: 0, high: 600, step: 1 }
                          ] as const).map((row) => (
                            <div className="sx-delay-row" key={row.title}>
                              <div><strong>{row.title}</strong><small>{row.hint}</small></div>
                              <label className="sx-unit"><input type="number" aria-label={`${row.title} minimum seconds`} min={row.low} max={row.high} step={row.step} value={settings[row.min] / 1000} onChange={(event) => setSettings({ ...settings, [row.min]: Number(event.target.value) * 1000 })} /><span>s</span></label>
                              <label className="sx-unit"><input type="number" aria-label={`${row.title} maximum seconds`} min={row.low} max={row.high} step={row.step} value={settings[row.max] / 1000} onChange={(event) => setSettings({ ...settings, [row.max]: Number(event.target.value) * 1000 })} /><span>s</span></label>
                            </div>
                          ))}
                        </div>
                      </section>
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>Safety limits</h2><p className="muted">A run stops when it reaches any of these. Recommended: at most 10 records per run and 10,000 posts per day.</p></header>
                        <div className="sx-fields sx-fields--three">
                          <label className="field"><span>Records per run</span><input type="number" min="1" max="500" value={settings.max_queries_per_run} onChange={(event) => setSettings({ ...settings, max_queries_per_run: Number(event.target.value) })} /></label>
                          <label className="field"><span>Posts per day</span><input type="number" min="1" max="10000" value={settings.max_posts_per_day} onChange={(event) => setSettings({ ...settings, max_posts_per_day: Number(event.target.value) })} /></label>
                          <label className="field"><span>Retries before skipping</span><input type="number" min="0" max="10" value={settings.query_retry_limit} onChange={(event) => setSettings({ ...settings, query_retry_limit: Number(event.target.value) })} /></label>
                        </div>
                      </section>
                    </>
                  )}

                  {settingsSection === "collecting" && (
                    <section className="sx-card">
                      <header className="sx-card-head"><h2>Email filtering</h2><p className="muted">Controls which captured addresses are kept and which count as new.</p></header>
                      <label className="sx-switch">
                        <span><strong>Ignore generic addresses</strong><small>Skip addresses that start with the prefixes below. Free-provider addresses such as Gmail are still kept.</small></span>
                        <span className="toggle-field"><input type="checkbox" checked={settings.ignore_generic_addresses} onChange={(event) => setSettings({ ...settings, ignore_generic_addresses: event.target.checked })} /><span /></span>
                      </label>
                      <label className="field"><span>Ignored prefixes</span><textarea rows={2} disabled={!settings.ignore_generic_addresses} value={prefixesText} onChange={(event) => { setPrefixesText(event.target.value); setSettings({ ...settings, ignored_email_prefixes: splitList(event.target.value) }); }} placeholder="noreply, no-reply, donotreply" /><small>Separate with commas.</small></label>
                      <label className="sx-switch">
                        <span><strong>Also exclude emails found on earlier days</strong><small>Earlier-day emails stay in Column A of the workbook but are left out of the new-email output.</small></span>
                        <span className="toggle-field"><input type="checkbox" checked={settings.exclude_earlier_emails} onChange={(event) => setSettings({ ...settings, exclude_earlier_emails: event.target.checked })} /><span /></span>
                      </label>
                    </section>
                  )}

                  {settingsSection === "data" && (
                    <>
                      <section className="sx-card">
                        <header className="sx-card-head sx-card-head--split">
                          <div><h2>Master email file</h2><p className="muted">Emails already in this file are not counted as new. The newest upload is used from then on.</p></div>
                          <button className="button button--secondary button--small" type="button" onClick={() => saveDownload(
                            "master-email-sample.csv",
                            "﻿Email,Name,Company\r\njane.doe@example.com,Jane Doe,Example Ltd\r\nhr@example.org,,Example Org\r\nrecruiter@example.net,Sam Lee,\r\n",
                            "text/csv;charset=utf-8"
                          )}>Download sample</button>
                        </header>
                        <ul className="sx-format">
                          <li>CSV or Excel (.xlsx) file, up to 30 MB</li>
                          <li>First row must have a column named <code>Email</code>, in any position</li>
                          <li>One email per row; other columns are ignored</li>
                          <li>Duplicates, empty rows and invalid addresses are counted and skipped</li>
                        </ul>
                        <label className={`sx-upload ${masterUploadBusy ? "sx-upload--busy" : ""}`}>
                          <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={masterUploadBusy} onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            void uploadMasterFile(file);
                            event.currentTarget.value = "";
                          }} />
                          <strong>{masterUploadBusy ? "Validating and importing the complete file…" : "Choose a CSV or XLSX file"}</strong>
                          <small>{masterUploadBusy ? "This can take a moment for large files." : "Click to browse. Previous uploads stay archived."}</small>
                        </label>
                        {masterInfo?.current && (
                          <div className="sx-master">
                            <div className="sx-master-head"><strong>{masterInfo.current.file_name}</strong><small>Uploaded {new Date(masterInfo.current.uploaded_at).toLocaleString()}</small></div>
                            <div className="sx-stats">
                              <div><strong>{masterInfo.current.email_count.toLocaleString()}</strong><small>Unique emails</small></div>
                              <div><strong>{masterInfo.current.rows_read.toLocaleString()}</strong><small>Rows read</small></div>
                              <div><strong>{masterInfo.current.duplicate_emails.toLocaleString()}</strong><small>Duplicates</small></div>
                              <div><strong>{masterInfo.current.empty_cells.toLocaleString()}</strong><small>Empty</small></div>
                              <div className={masterInfo.current.suspicious_count ? "sx-stat--warn" : ""}><strong>{masterInfo.current.suspicious_count.toLocaleString()}</strong><small>Suspicious</small></div>
                            </div>
                            {masterInfo.current.suspicious_entries.length > 0 && <details><summary>Review {masterInfo.current.suspicious_entries.length} suspicious rows</summary><ul>{masterInfo.current.suspicious_entries.map((entry) => <li key={`${entry.row}-${entry.reason}`}>Row {entry.row}: {entry.reason}</li>)}</ul></details>}
                          </div>
                        )}
                      </section>
                      <section className="sx-card">
                        <header className="sx-card-head"><h2>Upload history</h2></header>
                        {masterInfo?.imports.length ? <ul className="sx-history">{masterInfo.imports.map((item) => <li key={item.id}><span><strong>{item.file_name}</strong><small>{new Date(item.uploaded_at).toLocaleString()}</small></span><span className="sx-history-meta">{item.valid_emails.toLocaleString()} valid · {item.suspicious_count.toLocaleString()} suspicious</span></li>)}</ul> : <EmptyState title="No master file uploaded" text="Upload your reference CSV or XLSX to start comparing new emails." />}
                      </section>
                    </>
                  )}

                  {settingsSection === "data" && (
                    <section className="sx-card">
                      <header className="sx-card-head"><h2>Your data</h2><p className="muted">Everything the tracker saves, from every Chrome profile, is in one file in the project folder.</p></header>
                      <dl className="sx-facts">
                        <div><dt>Data file</dt><dd><code>data\tracker.db</code></dd></div>
                        <div><dt>Safety copies</dt><dd>One dated copy is made automatically each day before the first run and stored in <code>data\backups</code>. The newest 14 are kept; older ones are deleted.</dd></div>
                        <div><dt>Restore</dt><dd>Only needed if the data file is damaged or something was deleted by mistake: close Chrome, replace <code>data\tracker.db</code> with a copy from <code>data\backups</code>, then reopen Chrome.</dd></div>
                      </dl>
                      <div className="button-row"><button className="button button--secondary" type="button" disabled={settingsBusy} onClick={() => void runBackup()}>Make a copy now</button></div>
                    </section>
                  )}

                  {settingsSection === "advanced" && (
                    <>
                    <section className="sx-card">
                      <header className="sx-card-head"><h2>Advanced</h2><p className="muted">Saved immediately for this Chrome profile only. Leave them off unless you are troubleshooting.</p></header>
                      {([
                        { title: "Debug filters", hint: "Log filter steps in the browser console and on the LinkedIn control bar.", value: debugFilters, set: setDebugFilters, key: "debugFilters" },
                        { title: "Scan diagnostics", hint: "Store post-card and link structure details locally. After a scan error, use Copy scan logs on the LinkedIn bar.", value: debugScan, set: setDebugScan, key: "debugScan" },
                        { title: "Continue if a filter fails", hint: "May scan results that do not match your saved filters.", value: continueOnFilterFailure, set: setContinueOnFilterFailure, key: "continueOnFilterFailure" },
                        { title: "Automatic filter clicking (experimental)", hint: "Uses the legacy LinkedIn filter-pill automation instead of manual capture.", value: experimentalAutomaticFilters, set: setExperimentalAutomaticFilters, key: "experimentalAutomaticFilters" }
                      ]).map((option) => (
                        <label className="sx-switch" key={option.key}>
                          <span><strong>{option.title}</strong><small>{option.hint}</small></span>
                          <span className="toggle-field"><input type="checkbox" checked={option.value} onChange={(event) => {
                            const enabled = event.target.checked;
                            option.set(enabled);
                            void chrome.storage.local.set({ [option.key]: enabled }).catch((error: unknown) => setServiceError(formatError(error)));
                          }} /><span /></span>
                        </label>
                      ))}
                    </section>
                    <section className="sx-card">
                      <header className="sx-card-head"><h2>Connection diagnostics</h2><p className="muted">Only needed if the tracker service will not connect.</p></header>
                      <ConnectionLogControls />
                    </section>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        </ErrorBoundary>
      </main>

      {page === "settings" && (settingsDirty || settingsBusy) && (
        <div className="settings-save-bar">
          <span className={settingsDirty ? "unsaved-indicator" : "saved-indicator"}>{settingsDirty ? "Unsaved changes" : "All changes saved"}</span>
          <button className="button button--primary" type="button" disabled={!settingsDirty || settingsBusy || invalidSettings} onClick={() => void saveAppSettings(settings)}>
            {settingsBusy ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}

      {editor !== undefined && (
        <QueryEditor
          record={editor}
          defaultCountry={editorCountry}
          existingCountries={countries}
          nextPositionFor={nextPositionFor}
          countryProfiles={countryFilters}
          onCancel={() => setEditor(undefined)}
          onSave={(query) => {
            setQueryCountry(query.country_code);
            void saveQuery(query);
          }}
          onRecapture={(countryCode) => recaptureCountry(countryCode, editor)}
        />
      )}
      {importOpen && (
        <Modal title="Import query records" onClose={() => setImportOpen(false)}>
          <div className="modal-body">
            <p className="muted">Paste CSV with columns <code>country_code,label,query_text,enabled,notes</code>. Matching query text is warned about and skipped.</p>
            <textarea className="import-textarea" value={importText} onChange={(event) => setImportText(event.target.value)} rows={8} aria-label="CSV query data" placeholder={'country_code,label,query_text,enabled,notes\\nGB,London,("Data Analyst" OR "BI Analyst") AND "London" AND "hiring",true,'} />
            <label className="file-picker">Choose CSV file<input type="file" accept=".csv,text/csv" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then(setImportText).catch((error: unknown) => setServiceError(formatError(error)));
            }} /></label>
            <div className="modal-actions"><button className="button button--secondary" type="button" onClick={() => setImportOpen(false)}>Cancel</button><button className="button button--primary" type="button" disabled={!importText.trim()} onClick={() => void importQueries()}>Import</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">▤</span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

function LoadingState() {
  return <div className="loading-state" role="status"><span className="spinner" />Loading data…</div>;
}

function FilterResultRow({ result }: { result: FilterResult }) {
  const statusLabel = result.status === "applied"
    ? "Applied"
    : result.status === "not_requested"
      ? "Not requested"
      : "Not applied";
  return (
    <li className={`filter-result filter-result--${result.status}`}>
      <span className="filter-result-icon" aria-hidden="true">{result.status === "applied" ? "✓" : result.status === "not_requested" ? "—" : "!"}</span>
      <span className="filter-result-label"><strong>{result.label}</strong><small>{result.expected}</small></span>
      <span className="filter-result-status">{statusLabel}</span>
      {result.message && <span className="filter-result-message">{result.message}</span>}
    </li>
  );
}

function QueryEditor({
  record,
  defaultCountry,
  existingCountries,
  nextPositionFor,
  countryProfiles,
  onCancel,
  onSave,
  onRecapture
}: {
  record: QueryRecord | null;
  defaultCountry: string;
  existingCountries: string[];
  nextPositionFor: (countryCode: string) => number;
  countryProfiles: CountryFilterProfile[];
  onCancel: () => void;
  onSave: (query: QueryInput) => void;
  onRecapture: (countryCode: string) => void;
}) {
  const initialCountry = record?.country_code ?? defaultCountry;
  const [country, setCountry] = useState(initialCountry);
  const [label, setLabel] = useState(record?.label ?? "");
  const [queryText, setQueryText] = useState(record?.query_text ?? "");
  const [enabled, setEnabled] = useState(record ? Boolean(record.enabled) : true);
  const [position, setPosition] = useState(record?.position ?? (initialCountry ? nextPositionFor(initialCountry) : 0));
  const [notes, setNotes] = useState(record?.notes ?? "");
  const countryProfile = countryProfiles.find((profile) => profile.country_code === country.toUpperCase());
  const addingCountry = !record && !defaultCountry;
  const options = countryOptions();
  const existing = options.filter((option) => existingCountries.includes(option.code));
  const others = options.filter((option) => !existingCountries.includes(option.code));
  const unknownCurrent = country && !options.some((option) => option.code === country) ? country : "";

  return (
    <Modal title={record ? "Edit query record" : addingCountry ? "Add a country" : `Add record to ${countryLabel(defaultCountry)}`} onClose={onCancel}>
      <form className="modal-body editor-form" onSubmit={(event) => {
        event.preventDefault();
        onSave({ country_code: country.toUpperCase(), label, query_text: queryText, enabled, position, notes });
      }}>
        {addingCountry && <p className="muted">Choose the country, then add its first search record (usually a city). You can add more records to it later.</p>}
        <div className="form-grid">
          <label className="field"><span>Country</span>
            <select required value={country} onChange={(event) => {
              setCountry(event.target.value);
              if (!record) setPosition(nextPositionFor(event.target.value));
            }}>
              <option value="">Choose a country</option>
              {unknownCurrent && <option value={unknownCurrent}>{unknownCurrent}</option>}
              {existing.length > 0 && <optgroup label="Already in your queries">{existing.map((option) => <option key={option.code} value={option.code}>{option.name} ({option.code})</option>)}</optgroup>}
              <optgroup label="All countries">{others.map((option) => <option key={option.code} value={option.code}>{option.name} ({option.code})</option>)}</optgroup>
            </select>
          </label>
          <label className="field"><span>Label / city</span><input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="London" /></label>
        </div>
        <label className="field"><span>Query text</span><textarea required rows={3} value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder={'("Your job title" OR "Another title") AND "City" AND "hiring"'} spellCheck={false} />{queryText.trim() ? (() => { const check = checkRule(queryText, ""); return check.valid ? <small className="rule-ok">Used for the LinkedIn search. To also require it in every post, turn on “Must match the record's search query” in Settings → Collecting.</small> : <small className="rule-error">{check.error} Posts for this record will use the built-in checks until this is fixed.</small>; })() : <small>Use AND, OR, quotes and brackets, e.g. ("Job title" OR "Other title") AND "City" AND hiring.</small>}</label>
        <div className="form-grid">
          <label className="field"><span>Position</span><input type="number" min="0" value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>
          <label className="checkbox-field checkbox-editor"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Enabled</span></label>
        </div>
        <label className="field"><span>Notes</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="settings-divider" /><h3>Country filters</h3>
        <p className="muted">{countryProfile?.summary ?? "No country profile saved. Capture filters manually when you start a record in this country."}</p>
        {countryProfile && <small className="muted">Captured {new Date(countryProfile.captured_at).toLocaleString()}{new Date(countryProfile.captured_at).toDateString() !== new Date().toDateString() ? " · Stale" : ""}</small>}
        {record && <button className="button button--secondary button--small" type="button" onClick={() => onRecapture(country.toUpperCase())}>Edit by recapturing</button>}
        <div className="modal-actions"><button className="button button--secondary" type="button" onClick={onCancel}>Cancel</button><button className="button button--primary" type="submit">Save record</button></div>
      </form>
    </Modal>
  );
}
