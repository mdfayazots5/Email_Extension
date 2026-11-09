import type { CaptureBatchItem, CountryFilterProfile, FilterResult, ScanCounters, SearchRunState } from "./src/api/types";
import { ApiError, api, getProfileIdentity, RUN_STORAGE_KEY, serviceFetch } from "./src/api/client";
import { buildLinkedInSearchUrl, buildLinkedInSearchUrlFromParams, captureLinkedInFilterParams, filterNavigationStatus, filterParameterNames } from "./src/search/search-url";
import { resumeRunStatus, transitionRun } from "./src/search/run-state";
import { canStartAfterFallbackNavigation, canUseAutomaticFilterClick, resolveFilterChoice } from "./src/search/filter-choice";
import { retryTransientSave, saveBatchWithSafetyCopy } from "./src/search/safe-batch-save";
import { countryQueries, nextEnabledQueryInCountry, orderedEnabledQueries, reachedDailyPostLimit, shouldRetryQuery } from "./src/search/query-chain";
import { countryLabel } from "./src/ui/display";

type StartMessage = {
  type: "START_SEARCH";
  run: Omit<SearchRunState, "tabId" | "filterResults" | "stage" | "statusText">;
};

type PopupStartMessage = { type: "START_FROM_POPUP" };
type OnPageMessage =
  | { type: "GET_ONPAGE_DATA" }
  | { type: "START_SELECTED_RECORD"; queryId: number; countryCode?: string; continueNext: boolean }
  | { type: "OPEN_TRACKER_VIEW" };

type FilterChoiceMessage = {
  type: "FILTER_CHOICE";
  runId: number;
  choice: "capture" | "saved" | "skip" | "continue";
};

type CountryBoundaryMessage = { type: "COUNTRY_BOUNDARY_ACTION"; runId: number; action: "continue" | "skip" };

type ActionMessage = {
  type: "PAUSE_SEARCH" | "RESUME_SEARCH" | "STOP_SEARCH" | "DISCARD_RUN" | "RETRY_SAVE";
  runId: number;
};

type ContentProgress = {
  type: "SEARCH_PROGRESS";
  runId: number;
  status: SearchRunState["status"];
  stage: SearchRunState["stage"];
  statusText: string;
  filterResults: FilterResult[];
  filterFailure?: boolean;
  counters?: ScanCounters;
  pendingSave?: boolean;
  processedPostIds?: string[];
  error?: string;
};

type SaveBatchMessage = {
  type: "SAVE_BATCH";
  runId: number;
  batchId: string;
  captures: CaptureBatchItem[];
  counters: ScanCounters;
  processedPostIds: string[];
};

type WorkerMessage = StartMessage | PopupStartMessage | OnPageMessage | FilterChoiceMessage | CountryBoundaryMessage | ActionMessage | ContentProgress | SaveBatchMessage;

const launchingTabs = new Set<number>();
const saveDiagnosticLogKey = "latestSaveDiagnosticLog";

async function appendSaveDiagnostic(run: SearchRunState, event: string): Promise<void> {
  const stored = await chrome.storage.local.get(saveDiagnosticLogKey);
  const entries = Array.isArray(stored[saveDiagnosticLogKey])
    ? stored[saveDiagnosticLogKey] as Array<{ timestamp?: string; runId?: number; queryId?: number; event?: string }>
    : [];
  entries.push({
    timestamp: new Date().toISOString(),
    runId: run.runId,
    queryId: run.queryId,
    event
  });
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  await chrome.storage.local.set({ [saveDiagnosticLogKey]: entries });
}

async function readRun(): Promise<SearchRunState | null> {
  const result = await chrome.storage.local.get(RUN_STORAGE_KEY);
  const run = result[RUN_STORAGE_KEY] as SearchRunState | undefined;
  if (!run) return null;
  return {
    ...run,
    counters: run.counters ?? {
      scrollCount: 0,
      postsScanned: 0,
      emailsFound: 0,
      newEmails: 0,
      duplicateEmails: 0,
      ignoredEmails: 0,
      queryStatus: "pending"
    },
    recentCaptures: run.recentCaptures ?? [],
    processedPostIds: run.processedPostIds ?? [],
    countryCode: run.countryCode ?? "",
    cityLabel: run.cityLabel ?? "",
    scanDelayMinMs: run.scanDelayMinMs ?? 2000,
    scanDelayMaxMs: run.scanDelayMaxMs ?? 4000,
    maxScrolls: Math.min(run.maxScrolls ?? 50, 50),
    maxPosts: run.maxPosts ?? 300,
    stopAfterNoNewPosts: run.stopAfterNoNewPosts ?? 3,
    ignoreGenericAddresses: run.ignoreGenericAddresses ?? true,
    ignoredEmailPrefixes: run.ignoredEmailPrefixes ?? ["noreply", "no-reply", "donotreply"],
    postRequireJobWords: run.postRequireJobWords,
    postJobWords: run.postJobWords,
    postMatchQuery: run.postMatchQuery,
    postRuleCustom: run.postRuleCustom ?? "",
    profileId: run.profileId ?? "",
    profileLabel: run.profileLabel ?? "Chrome profile",
    queryResults: run.queryResults ?? [],
    queriesAttempted: run.queriesAttempted ?? 1,
    retryLimit: run.retryLimit ?? 2,
    queryPauseMinMs: run.queryPauseMinMs ?? 20_000,
    queryPauseMaxMs: run.queryPauseMaxMs ?? 40_000,
    maxQueriesPerRun: run.maxQueriesPerRun ?? 10,
    maxPostsPerDay: run.maxPostsPerDay === 1_000 ? 10_000 : run.maxPostsPerDay ?? 10_000,
    dailyPostsScanned: run.dailyPostsScanned ?? 0,
    currentQueryRetries: run.currentQueryRetries ?? 0,
    waitingForNextQuery: run.waitingForNextQuery ?? false,
    countryQueryIds: run.countryQueryIds ?? [],
    countryQueryIndex: run.countryQueryIndex ?? 0,
    capturedFilterParams: run.capturedFilterParams ?? "",
    filterSummary: run.filterSummary ?? "",
    filterFallback: run.filterFallback ?? false,
    filtersConfigured: run.filtersConfigured ?? false,
    currentRecordNumber: run.currentRecordNumber ?? 1,
    debugScan: run.debugScan ?? false,
    experimentalAutomaticFilters: run.experimentalAutomaticFilters ?? false
  };
}

async function storeRun(run: SearchRunState): Promise<void> {
  await chrome.storage.local.set({ [RUN_STORAGE_KEY]: run });
}

function progressData(run: SearchRunState) {
  return {
    stage: run.stage,
    statusText: run.statusText,
    queryText: run.queryText,
    searchUrl: run.searchUrl,
    filters: run.filters,
    filterResults: run.filterResults,
    counters: run.counters,
    processedPostIds: run.processedPostIds,
    pendingSave: run.pendingSave ?? false,
    error: run.error ?? null,
    queryId: run.queryId,
    countryCode: run.countryCode,
    cityLabel: run.cityLabel,
    profileId: run.profileId,
    profileLabel: run.profileLabel,
    queryResults: run.queryResults,
    queriesAttempted: run.queriesAttempted,
    retryLimit: run.retryLimit,
    queryPauseMinMs: run.queryPauseMinMs,
    queryPauseMaxMs: run.queryPauseMaxMs,
    maxQueriesPerRun: run.maxQueriesPerRun,
    maxPostsPerDay: run.maxPostsPerDay,
    dailyPostsScanned: run.dailyPostsScanned,
    currentQueryRetries: run.currentQueryRetries,
    delayMinMs: run.delayMinMs,
    delayMaxMs: run.delayMaxMs,
    scanDelayMinMs: run.scanDelayMinMs,
    scanDelayMaxMs: run.scanDelayMaxMs,
    maxScrolls: run.maxScrolls,
    maxPosts: run.maxPosts,
    stopAfterNoNewPosts: run.stopAfterNoNewPosts,
    ignoreGenericAddresses: run.ignoreGenericAddresses,
    ignoredEmailPrefixes: run.ignoredEmailPrefixes,
    postRequireJobWords: run.postRequireJobWords,
    postJobWords: run.postJobWords,
    postMatchQuery: run.postMatchQuery,
    postRuleCustom: run.postRuleCustom,
    queryStatus: run.counters.queryStatus,
    waitingForNextQuery: run.waitingForNextQuery,
    countryQueryIds: run.countryQueryIds,
    countryQueryIndex: run.countryQueryIndex,
    capturedFilterParams: run.capturedFilterParams,
    filterSummary: run.filterSummary,
    filterFallback: run.filterFallback,
    filtersConfigured: run.filtersConfigured,
    currentRecordNumber: run.currentRecordNumber,
    debugScan: run.debugScan ?? false,
    experimentalAutomaticFilters: run.experimentalAutomaticFilters,
    nextCountryCode: run.nextCountryCode,
    nextCountryRecords: run.nextCountryRecords
  };
}

async function patchRun(run: SearchRunState, ended = false): Promise<void> {
  const response = await serviceFetch(`/runs/${run.runId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: run.status,
      current_query_id: run.queryId,
      continue_next: run.continueNext,
      progress_json: progressData(run),
      ...(ended ? { ended_at: new Date().toISOString() } : {})
    })
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Could not save run progress (${response.status}): ${message}`);
  }
}

async function publish(run: SearchRunState): Promise<void> {
  await storeRun(run);
  try {
    await chrome.runtime.sendMessage({ type: "RUN_STATE", run });
  } catch {
    // The side panel may be closed; the persisted run remains available when it reopens.
  }
}

function isLinkedIn(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "www.linkedin.com";
  } catch {
    return false;
  }
}

async function searchTextMatches(tab: chrome.tabs.Tab, queryText: string): Promise<boolean> {
  if (tab.id === undefined || !tab.url) return false;
  const url = new URL(tab.url);
  if (url.hostname !== "www.linkedin.com" || !url.pathname.startsWith("/search/results/content/")) return false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_SEARCH_TEXT" }) as
      | { ok?: boolean; queryText?: string }
      | undefined;
    if (response?.ok && typeof response.queryText === "string" && response.queryText) {
      return response.queryText.trim() === queryText;
    }
  } catch {
    // Before injection, the current URL remains the reliable query source.
  }
  return url.searchParams.get("keywords") === queryText;
}

async function sendToContent(tabId: number, message: unknown): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function applyInTab(tabId: number, run: SearchRunState): Promise<void> {
  if (!canUseAutomaticFilterClick(run.experimentalAutomaticFilters === true)) return;
  if (launchingTabs.has(tabId)) return;
  launchingTabs.add(tabId);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await readRun();
      if (!current || current.runId !== run.runId || current.status !== "running") return;
      if (await sendToContent(tabId, { type: "APPLY_SEARCH_FILTERS", run: current })) return;
      await new Promise((resolve) => setTimeout(resolve, 350 + attempt * 250));
    }
    const current = await readRun();
    if (!current || current.runId !== run.runId) return;
    current.status = "error";
    current.stage = "error";
    current.statusText = "Search page did not respond";
    current.error = "The LinkedIn search page did not respond. Reload it and start the search again.";
    await publish(current);
    await patchRun(current, true);
  } finally {
    launchingTabs.delete(tabId);
  }
}

async function openSearch(run: SearchRunState): Promise<void> {
  if (run.tabId !== undefined) {
    const existing = await chrome.tabs.get(run.tabId).catch(() => undefined);
    if (existing) {
      if (await searchTextMatches(existing, run.queryText)) {
        run.tabId = existing.id;
        await storeRun(run);
        await applyInTab(existing.id!, run);
        return;
      }
      await chrome.tabs.update(existing.id!, { url: run.searchUrl, active: true });
      return;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab: chrome.tabs.Tab;

  if (isLinkedIn(active?.url)) {
    tab = active;
    if (tab.id === undefined) throw new Error("Could not identify the active LinkedIn tab.");
    run.tabId = tab.id;
    await storeRun(run);
    if (await searchTextMatches(tab, run.queryText)) {
      await chrome.tabs.update(tab.id, { active: true });
      await applyInTab(tab.id, run);
      return;
    }
    await chrome.tabs.update(tab.id, { url: run.searchUrl, active: true });
  } else {
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
    if (tab.id === undefined) throw new Error("Could not create the LinkedIn search tab.");
    run.tabId = tab.id;
    await storeRun(run);
    await chrome.tabs.update(tab.id, { url: run.searchUrl });
  }
}

async function handleStart(message: StartMessage): Promise<{ ok: boolean; error?: string }> {
  const previous = await readRun();
  if (previous && ["running", "paused", "awaiting_filters", "country_completed"].includes(previous.status)) {
    const messageText = "Another search run is already active. Pause or stop it before starting a new one.";
    await serviceFetch(`/runs/${message.run.runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "error", ended_at: new Date().toISOString(), progress_json: { stage: "error", statusText: messageText } })
    }).catch(() => undefined);
    return { ok: false, error: messageText };
  }

  const run: SearchRunState = {
    ...message.run,
    filterResults: [],
    stage: message.run.experimentalAutomaticFilters ? "opening" : "awaiting_filters",
    statusText: message.run.experimentalAutomaticFilters ? "Opening search" : `Set filters for ${message.run.countryCode}`,
    status: message.run.experimentalAutomaticFilters ? "running" : "awaiting_filters"
  };
  try {
    await api.acquireQueryLock(run.queryId, run.runId, run.profileId, run.profileLabel);
    await publish(run);
    await patchRun(run);
    await openSearch(run);
    return { ok: true };
  } catch (error) {
    run.status = "error";
    run.stage = "error";
    run.statusText = "Could not open search";
    run.error = error instanceof Error ? error.message : "Unable to open the LinkedIn search.";
    await publish(run);
    await patchRun(run, true);
    return { ok: false, error: run.error };
  }
}

async function handlePopupStart(
  selectedQueryId?: number,
  continueNextOverride?: boolean,
  selectedCountryCode?: string
): Promise<{ ok: boolean; error?: string }> {
  const previous = await readRun();
  if (previous && ["running", "paused", "awaiting_filters", "country_completed"].includes(previous.status)) {
    return { ok: false, error: "A run is already active. Open View to resume or stop it." };
  }
  const profile = await getProfileIdentity();
  const [queries, settings, today, stored] = await Promise.all([
    api.queries(),
    api.settings(),
    api.today(),
    chrome.storage.local.get(["selectedQueryId", "continueNext", "debugFilters", "debugScan", "continueOnFilterFailure", "experimentalAutomaticFilters"])
  ]);
  const ordered = queries
    .filter((query) => Boolean(query.enabled))
    .sort((left, right) =>
      left.country_code.localeCompare(right.country_code)
      || left.position - right.position
      || left.id - right.id
    );
  const savedSelection = Number(stored.selectedQueryId);
  const explicitSelection = ordered.find((query) => query.id === selectedQueryId);
  if (selectedQueryId !== undefined && !explicitSelection) {
    return { ok: false, error: "The selected record is unavailable or disabled. Refresh the control bar and choose an enabled record." };
  }
  const selected = explicitSelection
    && (!selectedCountryCode || explicitSelection.country_code === selectedCountryCode)
    ? explicitSelection
    : ordered.find((query) => query.country_code === selectedCountryCode)
    ?? ordered.find((query) => query.id === savedSelection)
    ?? ordered.find((query) => query.id === settings.starting_query_id)
    ?? ordered.find((query) => query.country_code === settings.starting_country)
    ?? ordered[0];
  if (!selected) return { ok: false, error: "No enabled saved queries. Add or enable one in the tracker first." };
  const filters = {
    date_posted: selected.date_posted ?? "any",
    sort_by: selected.sort_by ?? "relevance",
    content_type: selected.content_type ?? "all",
    from_member: selected.from_member ?? "",
    other_note: selected.other_note ?? ""
  };
  const experimentalAutomaticFilters = stored.experimentalAutomaticFilters === true;
  const searchUrl = experimentalAutomaticFilters
    ? buildLinkedInSearchUrl(selected.query_text, filters)
    : buildLinkedInSearchUrl(selected.query_text, {
      date_posted: "any", sort_by: "relevance", content_type: "all", from_member: "", other_note: ""
    });
  const continueNext = continueNextOverride ?? (typeof stored.continueNext === "boolean" ? stored.continueNext : true);
  const sameCountryQueries = countryQueries(ordered, selected.country_code);
  await chrome.storage.local.set({ selectedQueryId: selected.id, selectedCountryCode: selected.country_code, continueNext });
  const counters = {
    scrollCount: 0,
    postsScanned: 0,
    emailsFound: 0,
    newEmails: 0,
    duplicateEmails: 0,
    ignoredEmails: 0,
    queryStatus: "pending" as const
  };
  const run = {
    runId: 0,
    queryId: selected.id,
    queryText: selected.query_text,
    continueNext,
    status: experimentalAutomaticFilters ? "running" as const : "awaiting_filters" as const,
    stage: experimentalAutomaticFilters ? "opening" as const : "awaiting_filters" as const,
    statusText: experimentalAutomaticFilters ? "Opening search" : `Set filters for ${selected.country_code}`,
    filters,
    searchUrl,
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
    counters,
    recentCaptures: [],
    processedPostIds: [],
    countryCode: selected.country_code,
    cityLabel: selected.label,
    profileId: profile.id,
    profileLabel: profile.label,
    queryResults: [],
    queriesAttempted: 1,
    retryLimit: settings.query_retry_limit,
    queryPauseMinMs: settings.query_pause_min_ms,
    queryPauseMaxMs: settings.query_pause_max_ms,
    maxQueriesPerRun: settings.max_queries_per_run,
    maxPostsPerDay: settings.max_posts_per_day,
    dailyPostsScanned: today.posts_scanned,
    currentQueryRetries: 0,
    waitingForNextQuery: false,
    debugFilters: stored.debugFilters === true,
    debugScan: stored.debugScan === true,
    continueOnFilterFailure: stored.continueOnFilterFailure === true,
    countryQueryIds: sameCountryQueries.map((query) => query.id),
    countryQueryIndex: sameCountryQueries.findIndex((query) => query.id === selected.id),
    currentRecordNumber: sameCountryQueries.findIndex((query) => query.id === selected.id) + 1,
    capturedFilterParams: "",
    filterSummary: "",
    filterFallback: false,
    filtersConfigured: false,
    experimentalAutomaticFilters
  };
  const created = await api.createRun({
    current_query_id: selected.id,
    continue_next: continueNext,
    profile_id: profile.id,
    profile_label: profile.label,
    progress_json: {
      ...run,
      stage: run.stage,
      statusText: run.statusText,
      filterResults: []
    }
  });
  const result = await handleStart({
    type: "START_SEARCH",
    run: { ...run, runId: created.id }
  });
  return result;
}

async function startScan(run: SearchRunState, tabId: number): Promise<void> {
  run.tabId = tabId;
  run.status = "running";
  run.stage = "ready";
  run.statusText = run.filterFallback
    ? `Filters reused · ${run.cityLabel}`
    : `Filters captured: ${run.filterSummary || "Filters skipped"}`;
  run.error = undefined;
  await publish(run);
  await patchRun(run);
  if (!await sendToContent(tabId, { type: "START_SCAN", runId: run.runId, run })) {
    run.status = "error";
    run.stage = "error";
    run.statusText = "LinkedIn page did not respond";
    run.error = "Could not start scanning on the LinkedIn page. Reload it and try again.";
    await publish(run);
    await patchRun(run, true);
  }
}

async function changeKeywordsKeepingCurrentFilters(run: SearchRunState, tabId: number): Promise<void> {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "CHANGE_SEARCH_QUERY",
    runId: run.runId,
    run
  }) as { ok?: boolean; error?: string } | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "Could not change the search while preserving LinkedIn's selected filters.");
  }
}

async function recordFilterCaptureDebug(run: SearchRunState, params: string): Promise<void> {
  const stored = await chrome.storage.local.get("latestFilterApplicationLog");
  const previous = Array.isArray(stored.latestFilterApplicationLog) ? stored.latestFilterApplicationLog : [];
  const names = filterParameterNames(params);
  const entry = {
    timestamp: new Date().toISOString(),
    runId: run.runId,
    queryId: run.queryId,
    event: `Manually captured filter query parameters: ${names.length ? names.join(", ") : "(none found)"}.`
  };
  await chrome.storage.local.set({ latestFilterApplicationLog: [...previous, entry].slice(-200) });
}

async function handleFilterChoice(runId: number, choice: FilterChoiceMessage["choice"], tabId?: number): Promise<void> {
  const run = await readRun();
  if (!run || run.runId !== runId || run.status !== "awaiting_filters") {
    throw new Error("This run is no longer waiting for filter input.");
  }
  const targetTabId = tabId ?? run.tabId;
  if (targetTabId === undefined || (run.tabId !== undefined && run.tabId !== targetTabId)) {
    throw new Error("The LinkedIn search tab for this run is unavailable.");
  }
  await api.acquireQueryLock(run.queryId, run.runId, run.profileId, run.profileLabel);
  const tab = await chrome.tabs.get(targetTabId);
  if (!tab.url || !tab.url.startsWith("https://www.linkedin.com/search/results/content/")) {
    throw new Error("Open the LinkedIn Posts results page and set the filters there.");
  }

  let savedProfile: CountryFilterProfile | undefined;
  if (choice === "saved") {
    const profiles = await api.countryFilters();
    savedProfile = profiles.find((item) => item.country_code === run.countryCode);
  }
  const capturedParams = choice === "capture" || (choice === "continue" && !run.filterFallback)
    ? captureLinkedInFilterParams(tab.url)
    : "";
  const decision = resolveFilterChoice(
    choice,
    capturedParams,
    run.filterFallback === true,
    run.filterSummary ?? "",
    savedProfile
  );
  const { params, summary, fallback } = decision;
  if (choice === "capture" || (choice === "continue" && !run.filterFallback)) {
    await recordFilterCaptureDebug(run, params);
  }
  if (decision.saveProfile) {
    const profile = await api.saveCountryFilters(run.countryCode, { params, summary });
    await chrome.runtime.sendMessage({ type: "FILTER_PROFILE_UPDATED", profile }).catch(() => undefined);
  }

  run.capturedFilterParams = params;
  run.filterSummary = summary;
  run.filterFallback = fallback;
  run.filtersConfigured = true;
  run.filtersConfirmedForRecord = false;
  run.searchUrl = buildLinkedInSearchUrlFromParams(run.queryText, params);
  run.status = "running";
  run.error = undefined;

  const currentKeywords = new URL(tab.url).searchParams.get("keywords");
  run.filtersConfirmedForRecord = fallback && choice !== "skip" && currentKeywords !== run.queryText;
  if (fallback && choice !== "skip") {
    run.filtersConfirmedForRecord = true;
    if (currentKeywords === run.queryText) {
      await startScan(run, targetTabId);
      return;
    }
    run.stage = "scanning";
    run.statusText = `Searching ${run.cityLabel} while reusing this tab's selected filters`;
    await publish(run);
    await patchRun(run);
    await changeKeywordsKeepingCurrentFilters(run, targetTabId);
    return;
  }
  const mustNavigate = choice === "skip"
    || (params.length > 0 && filterNavigationStatus(tab.url, params, false) !== "present")
    || currentKeywords !== run.queryText;
  if (mustNavigate) {
    run.stage = "opening";
    run.statusText = fallback
      ? "Reusing the manually selected filters"
      : `Opening ${run.cityLabel} with captured filters`;
    await publish(run);
    await patchRun(run);
    await chrome.tabs.update(targetTabId, { url: run.searchUrl, active: true });
    return;
  }
  await startScan(run, targetTabId);
}

async function nextCountry(run: SearchRunState, skipCurrentNext: boolean): Promise<void> {
  if (reachedDailyPostLimit(run.dailyPostsScanned, run.maxPostsPerDay)) {
    await finishRun(run, "completed", `Daily safety limit reached (${run.maxPostsPerDay} posts).`);
    return;
  }
  if (run.queriesAttempted >= run.maxQueriesPerRun) {
    await finishRun(run, "completed", `Run safety limit reached (${run.maxQueriesPerRun} queries).`);
    return;
  }
  const records = orderedEnabledQueries(await api.queries());
  const countries = [...new Set(records.map((record) => record.country_code))]
    .sort((left, right) => countryLabel(left).localeCompare(countryLabel(right)));
  const currentIndex = countries.indexOf(run.countryCode);
  const targetCountry = countries[currentIndex + (skipCurrentNext ? 2 : 1)];
  if (!targetCountry) {
    run.status = "completed";
    run.stage = "completed";
    run.statusText = skipCurrentNext ? "Country skipped · no more countries" : "All countries completed";
    run.countryQueryIds = [];
    await api.releaseQueryLock(run.queryId, run.runId).catch(() => undefined);
    await publish(run);
    await patchRun(run, true);
    return;
  }

  const recordsInCountry = countryQueries(records, targetCountry);
  const first = recordsInCountry[0];
  if (!first) throw new Error(`No enabled records remain for ${targetCountry}.`);
  run.queryId = first.id;
  run.queryText = first.query_text;
  run.countryCode = first.country_code;
  run.cityLabel = first.label;
  run.countryQueryIds = recordsInCountry.map((record) => record.id);
  run.countryQueryIndex = 0;
  run.currentRecordNumber = 1;
  run.queriesAttempted++;
  run.counters = {
    scrollCount: 0, postsScanned: 0, emailsFound: 0,
    newEmails: 0, duplicateEmails: 0, ignoredEmails: 0, queryStatus: "pending"
  };
  run.processedPostIds = [];
  run.filterResults = [];
  run.capturedFilterParams = "";
  run.filterSummary = "";
  run.filterFallback = false;
  run.filtersConfigured = false;
  run.filtersConfirmedForRecord = false;
  run.nextCountryCode = undefined;
  run.nextCountryRecords = undefined;
  if (run.experimentalAutomaticFilters) {
    run.filters = {
      date_posted: first.date_posted ?? "any",
      sort_by: first.sort_by ?? "relevance",
      content_type: first.content_type ?? "all",
      from_member: first.from_member ?? "",
      other_note: first.other_note ?? ""
    };
    run.status = "running";
    run.stage = "opening";
    run.statusText = `Opening ${run.cityLabel}`;
    run.searchUrl = buildLinkedInSearchUrl(first.query_text, run.filters);
  } else {
    run.status = "awaiting_filters";
    run.stage = "awaiting_filters";
    run.statusText = `Set filters for ${run.countryCode}`;
    run.searchUrl = buildLinkedInSearchUrlFromParams(run.queryText, "");
  }
  await api.acquireQueryLock(run.queryId, run.runId, run.profileId, run.profileLabel);
  await publish(run);
  await patchRun(run);
  if (run.tabId === undefined) throw new Error("LinkedIn tab is unavailable. Resume the run to reopen it.");
  await chrome.tabs.update(run.tabId, { url: run.searchUrl, active: true });
}

async function handleAction(action: ActionMessage["type"], runId: number): Promise<void> {
  const run = await readRun();
  if (!run || run.runId !== runId) return;

  if (action === "PAUSE_SEARCH") {
    if (run.status !== "running" && run.status !== "awaiting_filters") return;
    const awaitingFilters = run.status === "awaiting_filters";
    run.status = awaitingFilters ? "paused" : transitionRun(run.status, "pause");
    run.statusText = awaitingFilters ? "Paused · Set filters" : "Paused";
    await publish(run);
    if (!awaitingFilters && run.tabId !== undefined) await sendToContent(run.tabId, { type: action, runId });
    await patchRun(run);
    return;
  }

  if (action === "STOP_SEARCH") {
    if (run.status === "stopped" || run.status === "error") return;
    run.status = transitionRun(run.status, "stop");
    run.stage = "stopped";
    run.statusText = "Stopped";
    await publish(run);
    if (run.tabId !== undefined) await sendToContent(run.tabId, { type: action, runId });
    await patchRun(run, true);
    return;
  }

  if (action === "DISCARD_RUN") {
    if (run.status === "running") throw new Error("Pause the run before discarding it.");
    if (run.pendingSave) throw new Error("Retry the unsent batch before discarding the run.");
    run.status = "stopped";
    run.stage = "stopped";
    run.statusText = "Run discarded";
    await patchRun(run, true);
    await chrome.storage.local.remove(RUN_STORAGE_KEY);
    await chrome.runtime.sendMessage({ type: "RUN_DISCARDED", runId }).catch(() => undefined);
    return;
  }

  if (action === "RESUME_SEARCH") {
    if (run.status !== "paused") return;
    if (run.pendingSave) throw new Error("Retry the unsent batch before resuming the scan.");
    if (run.stage === "awaiting_filters") {
      run.status = resumeRunStatus(run.status, run.stage);
      run.statusText = run.filterSummary?.includes("URL filters unavailable")
        ? "Filters were not in the URL. Set the filters again, then click Continue."
        : `Set filters for ${run.countryCode}`;
      await publish(run);
      await patchRun(run);
      return;
    }
    const wasWaitingForNextQuery = run.waitingForNextQuery;
    if (!wasWaitingForNextQuery) {
      await api.acquireQueryLock(run.queryId, run.runId, run.profileId, run.profileLabel);
    }
    run.status = transitionRun(run.status, "resume");
    run.error = undefined;
    run.statusText = wasWaitingForNextQuery
      ? "Resuming query chain"
      : run.stage === "ready" ? "Ready to scan" : "Resuming search";
    await publish(run);
    await patchRun(run);
    if (wasWaitingForNextQuery) {
      void advanceChain(run.runId);
      return;
    }
    let tab = run.tabId === undefined ? undefined : await chrome.tabs.get(run.tabId).catch(() => undefined);
    if (!tab) {
      tab = await chrome.tabs.create({ url: "about:blank", active: true });
      if (tab.id === undefined) throw new Error("Could not reopen the LinkedIn search tab.");
      run.tabId = tab.id;
      run.stage = "opening";
      run.statusText = "Opening search";
      await publish(run);
      await storeRun(run);
      await chrome.tabs.update(tab.id, { url: run.searchUrl });
    } else {
      const sent = await sendToContent(tab.id!, { type: action, runId });
      if (!sent) {
        run.stage = "opening";
        run.statusText = "Reopening search";
        await publish(run);
        await chrome.tabs.update(tab.id!, { url: run.searchUrl });
      }
    }
  }
}

function pendingBatchKey(runId: number): string {
  return `pendingEmailBatch:${runId}`;
}

const advancingRuns = new Set<number>();

async function finishRun(run: SearchRunState, status: "completed" | "error", message: string, error?: string): Promise<void> {
  run.status = status;
  run.stage = status === "error" ? "error" : "completed";
  run.statusText = message;
  run.error = error;
  run.waitingForNextQuery = false;
  await api.releaseQueryLock(run.queryId, run.runId).catch(() => undefined);
  await publish(run);
  await patchRun(run, true);
}

async function waitForNextQuery(runId: number, milliseconds: number): Promise<boolean> {
  const endAt = Date.now() + milliseconds;
  while (Date.now() < endAt) {
    const current = await readRun();
    if (!current || current.runId !== runId || current.status === "stopped" || current.status === "error") return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, endAt - Date.now())));
  }
  return true;
}

async function advanceChain(runId: number): Promise<void> {
  if (advancingRuns.has(runId)) return;
  advancingRuns.add(runId);
  try {
    let run = await readRun();
    if (!run || run.runId !== runId || run.status !== "running") return;
    await api.releaseQueryLock(run.queryId, run.runId);
    if (!run.continueNext) {
      await finishRun(run, "completed", "Record completed · continue-through-country is off");
      return;
    }
    if (reachedDailyPostLimit(run.dailyPostsScanned, run.maxPostsPerDay)) {
      await finishRun(run, "completed", `Daily safety limit reached (${run.maxPostsPerDay} posts).`);
      return;
    }
    if (run.queriesAttempted >= run.maxQueriesPerRun) {
      await finishRun(run, "completed", `Run safety limit reached (${run.maxQueriesPerRun} queries).`);
      return;
    }
    run.waitingForNextQuery = true;
    run.statusText = "Record completed · waiting before the next record";
    await publish(run);
    await patchRun(run);
    const pause = run.queryPauseMinMs + Math.random() * Math.max(0, run.queryPauseMaxMs - run.queryPauseMinMs);
    if (!await waitForNextQuery(runId, pause)) return;
    run = await readRun();
    if (!run || run.runId !== runId || run.status !== "running") return;
    run.waitingForNextQuery = false;

    const records = await api.queries();
    let cursorId = run.queryId;
    let candidate = nextEnabledQueryInCountry(records, cursorId, run.countryCode);
    while (candidate) {
      try {
        await api.acquireQueryLock(candidate.id, run.runId, run.profileId, run.profileLabel);
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        run.queryResults.push({
          queryId: candidate.id,
          label: `${candidate.country_code} · ${candidate.label}`,
          status: "skipped",
          error: "Locked by another Chrome profile or disabled."
        });
        await publish(run);
        await patchRun(run);
        cursorId = candidate.id;
        candidate = nextEnabledQueryInCountry(records, cursorId, run.countryCode);
      }
    }
    if (!candidate) {
      const ordered = orderedEnabledQueries(records);
      const countryCodes = [...new Set(ordered.map((record) => record.country_code))]
        .sort((left, right) => countryLabel(left).localeCompare(countryLabel(right)));
      const countryIndex = countryCodes.indexOf(run.countryCode);
      const nextCountryCode = countryCodes[countryIndex + 1];
      const nextCount = nextCountryCode
        ? countryQueries(ordered, nextCountryCode).length
        : 0;
      run.nextCountryCode = nextCountryCode;
      run.nextCountryRecords = nextCount;
      run.status = "country_completed";
      run.stage = "completed";
      run.waitingForNextQuery = false;
      const finished = run.queryResults.filter((result) => run.countryQueryIds?.includes(result.queryId)).length;
      run.statusText = `Country finished: ${countryLabel(run.countryCode)} - ${finished}/${run.countryQueryIds?.length ?? finished} records.`
        + (nextCountryCode ? ` Next: ${countryLabel(nextCountryCode)} (${nextCount} records).` : " No next country.");
      await publish(run);
      await patchRun(run);
      return;
    }
    const orderedCountryRecords = countryQueries(records, run.countryCode);
    const candidateIndex = orderedCountryRecords.findIndex((record) => record.id === candidate.id);
    run.queryId = candidate.id;
    run.queryText = candidate.query_text;
    run.cityLabel = candidate.label;
    run.countryQueryIndex = candidateIndex;
    run.currentRecordNumber = candidateIndex + 1;
    run.counters = {
      scrollCount: 0, postsScanned: 0, emailsFound: 0,
      newEmails: 0, duplicateEmails: 0, ignoredEmails: 0, queryStatus: "pending"
    };
    run.filterResults = [];
    run.processedPostIds = [];
    run.currentQueryRetries = 0;
    run.error = undefined;
    run.queriesAttempted++;
    run.waitingForNextQuery = false;
    run.filtersConfirmedForRecord = run.filterFallback === true;
    if (run.experimentalAutomaticFilters) {
      run.filters = {
        date_posted: candidate.date_posted ?? "any",
        sort_by: candidate.sort_by ?? "relevance",
        content_type: candidate.content_type ?? "all",
        from_member: candidate.from_member ?? "",
        other_note: candidate.other_note ?? ""
      };
    }
    run.status = "running";
    run.stage = run.filterFallback ? "scanning" : "opening";
    run.searchUrl = run.experimentalAutomaticFilters
      ? buildLinkedInSearchUrl(candidate.query_text, run.filters)
      : buildLinkedInSearchUrlFromParams(candidate.query_text, run.capturedFilterParams ?? "");
    run.statusText = run.filterFallback
      ? `Reusing the manually selected LinkedIn filters for ${candidate.label}`
      : `Record ${candidateIndex + 1} of ${orderedCountryRecords.length}`;
    await publish(run);
    await patchRun(run);
    if (run.tabId === undefined) {
      await finishRun(run, "error", "LinkedIn tab is unavailable", "Open a LinkedIn Posts tab and resume the run.");
      return;
    }
    if (run.filterFallback) {
      await changeKeywordsKeepingCurrentFilters(run, run.tabId);
      return;
    }
    await chrome.tabs.update(run.tabId, { url: run.searchUrl, active: true });
  } catch (error) {
    const run = await readRun();
    if (run && run.runId === runId && run.status !== "stopped") {
      await finishRun(run, "error", "Could not continue to the next query", error instanceof Error ? error.message : "Service error.");
    }
  } finally {
    advancingRuns.delete(runId);
  }
}

async function handleQueryFailure(run: SearchRunState, error: string): Promise<void> {
  if (/login|security|captcha|rate.?limit|restricted/i.test(error)) {
    await finishRun(run, "error", "Stopped for LinkedIn security notice", error);
    return;
  }
  if (shouldRetryQuery(run.currentQueryRetries, run.retryLimit)) {
    run.currentQueryRetries++;
    run.status = "running";
    run.stage = "opening";
    run.statusText = `Query failed · retry ${run.currentQueryRetries} of ${run.retryLimit}`;
    run.error = error;
    await publish(run);
    await patchRun(run);
    if (run.tabId !== undefined) await chrome.tabs.reload(run.tabId);
    return;
  }
  run.queryResults.push({
    queryId: run.queryId,
    label: `${run.countryCode} · ${run.cityLabel}`,
    status: "error",
    error
  });
  run.waitingForNextQuery = true;
  run.status = "running";
  run.statusText = `Skipped failed query after ${run.retryLimit} retries`;
  await publish(run);
  await patchRun(run);
  void advanceChain(run.runId);
}

async function handleSaveBatch(
  message: SaveBatchMessage,
  resumeAfterSave = false,
  allowFinished = false
): Promise<{
  ok: boolean;
  error?: string;
  counters?: ScanCounters;
  retryable?: boolean;
  saveDiagnostic?: {
    errorKind: string;
    httpStatus: number | null;
    errorName: string;
    serviceCode?: string;
    serviceErrorName?: string;
    serviceRequestId?: string;
    serviceEndpoint?: string;
    serviceExtendedCode?: number;
    serviceValidation?: string;
  };
}> {
  const run = await readRun();
  if (!run || run.runId !== message.runId || (!allowFinished && (run.status === "stopped" || run.status === "error"))) {
    return { ok: false, error: "This run is no longer active." };
  }
  const pending = {
    batchId: message.batchId,
    runId: run.runId,
    queryId: run.queryId,
    captures: message.captures,
    counters: message.counters,
    processedPostIds: message.processedPostIds
  };
  run.counters = {
    ...run.counters,
    scrollCount: message.counters.scrollCount,
    postsScanned: message.counters.postsScanned,
    emailsFound: message.counters.emailsFound,
    ignoredEmails: message.counters.ignoredEmails,
    queryStatus: message.counters.queryStatus
  };
  run.processedPostIds = message.processedPostIds;
  const previousCounters = { ...run.counters };
  const outcome = await saveBatchWithSafetyCopy(
    pending,
    {
      save: async (batch) => { await chrome.storage.local.set({ [pendingBatchKey(run.runId)]: batch }); },
      remove: async () => { await chrome.storage.local.remove(pendingBatchKey(run.runId)); }
    },
    (batch) => retryTransientSave(
      () => api.saveBatch({
        batch_id: batch.batchId,
        run_id: batch.runId,
        query_id: batch.queryId,
        captures: batch.captures
      }),
      (error) => error instanceof ApiError && (
        error.kind === "offline" || (error.kind === "http" && (error.status ?? 0) >= 500)
      )
    ),
    async (result) => {
    run.counters = {
      ...run.counters,
      newEmails: run.counters.newEmails + result.new,
      duplicateEmails: run.counters.duplicateEmails + result.duplicates,
      ignoredEmails: run.counters.ignoredEmails + result.ignored
    };
    run.pendingSave = false;
    run.error = undefined;
    if (resumeAfterSave && run.status === "paused") {
      run.status = "running";
      run.stage = "scanning";
    }
    run.statusText = `Saved batch · New ${run.counters.newEmails} · Duplicate ${run.counters.duplicateEmails}`;
    await storeRun(run);
    await patchRun(run);
    }
  );
  if (outcome.ok) {
    await appendSaveDiagnostic(run, `Batch save succeeded: captures=${message.captures.length}.`);
    await publish(run);
    return { ok: true, counters: run.counters };
  } else {
    const diagnostic = getSaveDiagnostic(outcome.error);
    await appendSaveDiagnostic(
      run,
      `Batch save failed: endpoint=POST /emails/save-batch; kind=${diagnostic.errorKind}; httpStatus=${diagnostic.httpStatus ?? "none"}; serviceCode=${diagnostic.serviceCode ?? "none"}; serviceExtendedCode=${diagnostic.serviceExtendedCode ?? "none"}; serviceErrorName=${diagnostic.serviceErrorName ?? diagnostic.errorName}; serviceRequestId=${diagnostic.serviceRequestId ?? "none"}; serviceEndpoint=${diagnostic.serviceEndpoint ?? "unknown"}; validation=${diagnostic.serviceValidation ?? "none"}; safetyCopySaved=${outcome.safetyCopySaved}.`
    );
    run.counters = previousCounters;
    if (!outcome.safetyCopySaved) {
      run.status = "error";
      run.stage = "error";
      run.pendingSave = false;
      run.error = `The safety copy could not be saved (${outcome.error.message}). The batch was not sent to the service; scanning stopped.`;
      run.statusText = "Safety copy failed · run stopped";
      await publish(run);
      try {
        await patchRun(run, true);
      } catch (persistError) {
        run.error += ` Run status could not be persisted: ${persistError instanceof Error ? persistError.message : "service unavailable"}`;
        await publish(run);
      }
      if (run.tabId !== undefined) await sendToContent(run.tabId, { type: "STOP_SEARCH", runId: run.runId });
      return {
        ok: false,
        error: run.error,
        counters: run.counters,
        retryable: false,
        saveDiagnostic: getSaveDiagnostic(outcome.error)
      };
    }
    if (run.status !== "stopped" && run.status !== "error") {
      run.status = "paused";
      run.stage = "scanning";
    }
    run.pendingSave = true;
    run.error = outcome.error.message;
    run.statusText = "Save failed · batch kept for retry";
    await publish(run);
    try {
      await patchRun(run);
    } catch (persistError) {
      console.error("Could not persist paused save state:", persistError);
    }
    if (run.status === "paused" && run.tabId !== undefined) {
      await sendToContent(run.tabId, { type: "PAUSE_SEARCH", runId: run.runId });
    }
    return {
      ok: false,
      error: run.error,
      counters: run.counters,
      retryable: true,
      saveDiagnostic: getSaveDiagnostic(outcome.error)
    };
  }
}

function getSaveDiagnostic(error: Error): {
  errorKind: string;
  httpStatus: number | null;
  errorName: string;
  serviceCode?: string;
  serviceErrorName?: string;
  serviceRequestId?: string;
  serviceEndpoint?: string;
  serviceExtendedCode?: number;
  serviceValidation?: string;
} {
  if (error instanceof ApiError) {
    const details = typeof error.details === "object" && error.details !== null
      ? error.details as Record<string, unknown>
      : {};
    const diagnostic = typeof details.diagnostic === "object" && details.diagnostic !== null
      ? details.diagnostic as Record<string, unknown>
      : {};
    const validationIssues = Array.isArray(error.details)
      ? error.details.slice(0, 10).flatMap((issue) => {
        if (typeof issue !== "object" || issue === null) return [];
        const item = issue as Record<string, unknown>;
        const path = Array.isArray(item.path)
          ? item.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number").join(".")
          : "";
        const code = typeof item.code === "string" ? item.code : "invalid";
        return [`${path || "(request)"} (${code})`];
      }).join("; ")
      : "";
    return {
      errorKind: error.kind,
      httpStatus: error.status ?? null,
      errorName: error.name,
      ...(typeof diagnostic.sqliteCode === "string" && diagnostic.sqliteCode ? { serviceCode: diagnostic.sqliteCode } : {}),
      ...(typeof diagnostic.errorName === "string" ? { serviceErrorName: diagnostic.errorName } : {}),
      ...(typeof diagnostic.requestId === "string" ? { serviceRequestId: diagnostic.requestId } : {}),
      ...(typeof diagnostic.method === "string" && typeof diagnostic.path === "string"
        ? { serviceEndpoint: `${diagnostic.method} ${diagnostic.path}` }
        : {}),
      ...(typeof diagnostic.sqliteExtendedCode === "number" ? { serviceExtendedCode: diagnostic.sqliteExtendedCode } : {}),
      ...(validationIssues ? { serviceValidation: validationIssues } : {})
    };
  }
  return { errorKind: "unexpected", httpStatus: null, errorName: error.name || "Error" };
}

async function retryPendingSave(runId: number): Promise<{ ok: boolean; error?: string }> {
  const run = await readRun();
  if (!run || run.runId !== runId || !["paused", "stopped", "error"].includes(run.status)) {
    return { ok: false, error: "This run has no retryable paused save." };
  }
  const key = pendingBatchKey(runId);
  const stored = await chrome.storage.local.get(key);
  const pending = stored[key] as SaveBatchMessage | undefined;
  if (!pending) return { ok: false, error: "No unsent batch is available to retry." };
  const resumeAfterSave = run.status === "paused";
  const result = await handleSaveBatch(pending, resumeAfterSave, true);
  if (!result.ok || !result.counters) return { ok: false, error: result.error };
  const current = await readRun();
  if (resumeAfterSave && current?.status === "running" && current.tabId !== undefined) {
    await sendToContent(current.tabId, {
      type: "SAVE_RETRY_RESULT",
      runId,
      batchId: pending.batchId,
      counters: result.counters
    });
    await sendToContent(current.tabId, { type: "RESUME_SEARCH", runId, counters: result.counters });
  }
  return { ok: true };
}

async function handleProgress(message: ContentProgress): Promise<void> {
  const run = await readRun();
  if (!run || run.runId !== message.runId || ["stopped", "error", "completed"].includes(run.status)) return;
  if (run.status === "paused" && message.status === "running") return;
  const previousCounters = { ...run.counters };
  const queryCompleted = message.stage === "completed";
  const queryFailed = message.stage === "error";
  if (queryFailed && /No post cards matched|No posts were scanned|(?:did not expose|none exposed a usable) post permalink/.test(message.error ?? "")) {
    run.status = "error";
    run.stage = "error";
    run.statusText = message.statusText;
    run.error = message.error;
    await finishRun(run, "error", message.statusText, message.error);
    return;
  }
  run.status = queryFailed ? "running" : message.status;
  run.stage = message.stage;
  run.statusText = message.statusText;
  run.filterResults = message.filterResults;
  if (message.counters) run.counters = message.counters;
  if (message.counters) {
    run.dailyPostsScanned += Math.max(0, message.counters.postsScanned - previousCounters.postsScanned);
  }
  if (message.pendingSave !== undefined) run.pendingSave = message.pendingSave;
  if (message.processedPostIds) run.processedPostIds = message.processedPostIds;
  run.error = message.error;
  if (message.filterFailure) {
    await finishRun(run, "error", message.statusText, message.error ?? message.statusText);
    return;
  }
  if (queryCompleted) {
    run.status = "running";
    run.counters.queryStatus = "completed";
    run.statusText = "Query completed";
    run.waitingForNextQuery = true;
    if (!run.queryResults.some((result) => result.queryId === run.queryId && result.status === "completed")) {
      run.queryResults.push({ queryId: run.queryId, label: `${run.countryCode} · ${run.cityLabel}`, status: "completed" });
    }
  }
  if (queryFailed) {
    run.stage = "opening";
    run.statusText = message.statusText;
    run.error = message.error;
  }
  await publish(run);
  const scrollCheckpointDue = run.counters.scrollCount !== previousCounters.scrollCount;
  const postCheckpointDue = run.counters.postsScanned > 0 && run.counters.postsScanned % 10 === 0;
  const scanCheckpointDue = message.stage !== "scanning"
    || run.status !== "running"
    || queryCompleted
    || scrollCheckpointDue
    || postCheckpointDue;
  if (scanCheckpointDue) {
    await patchRun(run, run.status === "stopped" || run.status === "error" || run.status === "completed");
    if (message.counters && run.status === "running" && (scrollCheckpointDue || postCheckpointDue || queryCompleted)) {
      const daily = await api.today();
      run.dailyPostsScanned = daily.posts_scanned;
      await storeRun(run);
    }
  }
  if (reachedDailyPostLimit(run.dailyPostsScanned, run.maxPostsPerDay)) {
    if (run.tabId !== undefined) await sendToContent(run.tabId, { type: "STOP_SEARCH", runId: run.runId });
    await finishRun(run, "completed", `Daily safety limit reached (${run.maxPostsPerDay} posts).`);
    return;
  }
  if (queryFailed && run.error) {
    void handleQueryFailure(run, run.error);
    return;
  }
  if (queryCompleted) void advanceChain(run.runId);
}

let messageQueue = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = messageQueue.then(task);
  messageQueue = result.then(() => undefined, () => undefined);
  return result;
}

chrome.runtime.onMessage.addListener((message: WorkerMessage, sender, sendResponse) => {
  if (message.type === "START_FROM_POPUP") {
    void enqueue(handlePopupStart).then(sendResponse).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to start collection." });
    });
    return true;
  }
  if (message.type === "START_SEARCH") {
    void enqueue(() => handleStart(message)).then(sendResponse).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to start search." });
    });
    return true;
  }
  if (message.type === "GET_ONPAGE_DATA") {
    void Promise.all([api.queries(), readRun(), api.settings(), api.countryFilters()]).then(([queries, run, settings, countryFilters]) => {
      sendResponse({ ok: true, queries, run, defaultQueryId: settings.starting_query_id, countryFilters });
    }).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Could not load saved records." });
    });
    return true;
  }
  if (message.type === "START_SELECTED_RECORD") {
    void enqueue(() => handlePopupStart(message.queryId, message.continueNext, message.countryCode)).then(sendResponse).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to start the selected record." });
    });
    return true;
  }
  if (message.type === "FILTER_CHOICE") {
    void enqueue(() => handleFilterChoice(message.runId, message.choice, sender.tab?.id)).then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to apply the filter choice." });
    });
    return true;
  }
  if (message.type === "COUNTRY_BOUNDARY_ACTION") {
    void enqueue(async () => {
      const run = await readRun();
      if (!run || run.runId !== message.runId || run.status !== "country_completed") {
        throw new Error("The country boundary is no longer awaiting an action.");
      }
      if (message.action === "continue") await nextCountry(run, false);
      else await nextCountry(run, true);
    }).then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to continue the country flow." });
    });
    return true;
  }
  if (message.type === "OPEN_TRACKER_VIEW") {
    void (async () => {
      const tabId = sender.tab?.id;
      if (tabId === undefined) throw new Error("Could not identify the LinkedIn tab.");
      try {
        if (!chrome.sidePanel?.open) throw new Error("Side panel API is unavailable.");
        await chrome.sidePanel.open({ tabId });
        sendResponse({ ok: true, opened: "sidePanel" });
      } catch {
        await chrome.tabs.create({ url: chrome.runtime.getURL("index.html?page=view"), active: true });
        sendResponse({ ok: true, opened: "tab" });
      }
    })().catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Could not open the tracker view." });
    });
    return true;
  }
  if (message.type === "RETRY_SAVE") {
    void enqueue(() => retryPendingSave(message.runId)).then(sendResponse).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to retry the pending save." });
    });
    return true;
  }
  if (message.type === "SAVE_BATCH") {
    void enqueue(() => handleSaveBatch(message)).then(sendResponse).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to save the batch." });
    });
    return true;
  }
  if (message.type === "PAUSE_SEARCH" || message.type === "RESUME_SEARCH" || message.type === "STOP_SEARCH" || message.type === "DISCARD_RUN") {
    void enqueue(() => handleAction(message.type, message.runId)).then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unable to update run." });
    });
    return true;
  }
  if (message.type === "SEARCH_PROGRESS") {
    void enqueue(() => handleProgress(message)).then(() => {
      sendResponse({ ok: true });
    }).catch((error: unknown) => {
      console.error("Could not persist search progress:", error);
      void readRun().then(async (run) => {
        if (!run || run.runId !== message.runId) return;
        run.status = "error";
        run.stage = "error";
        run.statusText = "Could not save search progress";
        run.error = error instanceof Error ? error.message : "The service could not save run progress.";
        await publish(run);
        if (run.tabId !== undefined) await sendToContent(run.tabId, { type: "STOP_SEARCH", runId: run.runId });
      }).catch((persistError: unknown) => console.error("Could not stop after a persistence error:", persistError));
      void chrome.runtime.sendMessage({
        type: "RUN_PERSIST_ERROR",
        runId: message.runId,
        error: error instanceof Error ? error.message : "Could not save run progress."
      }).catch(() => undefined);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Could not save run progress."
      });
    });
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const tabUrl = tab.url;
  if ((changeInfo.status !== "complete" && !changeInfo.url) || !tabUrl) return;
  void readRun().then(async (run) => {
    if (!run || run.tabId !== tabId || run.status !== "running") return;
    const url = new URL(tabUrl);
    if (url.hostname === "www.linkedin.com" && /\/(login|checkpoint|challenge)(\/|$)/i.test(url.pathname)) {
      run.status = "error";
      run.stage = "error";
      run.statusText = "LinkedIn login or security check detected";
      run.error = "LinkedIn redirected to a login or security-check page. The run stopped; resolve it manually.";
      await publish(run);
      await patchRun(run, true);
      return;
    }
    if (!tabUrl.startsWith("https://www.linkedin.com/search/results/content/")) return;
    if (run.filterFallback && run.stage === "scanning" && url.searchParams.get("keywords") === run.queryText) {
      await startScan(run, tabId);
      return;
    }
    if (run.stage !== "opening") return;
    if (run.experimentalAutomaticFilters) {
      await applyInTab(tabId, run);
      return;
    }
    if (!run.filtersConfigured) return;
    const filterStatus = filterNavigationStatus(tabUrl, run.capturedFilterParams ?? "", run.filterFallback === true);
    if (filterStatus === "confirm") {
      if (canStartAfterFallbackNavigation(run.filterFallback === true, run.filtersConfirmedForRecord === true)) {
        run.filtersConfirmedForRecord = false;
        await startScan(run, tabId);
        return;
      }
      run.status = "awaiting_filters";
      run.stage = "awaiting_filters";
      run.statusText = "Filters were not in the URL. Confirm they are still applied, then click Continue.";
      await publish(run);
      await patchRun(run);
      return;
    }
    if (filterStatus === "lost") {
      run.status = "awaiting_filters";
      run.stage = "awaiting_filters";
      run.statusText = "Filters were lost. Set the filters again, then click Continue.";
      run.error = undefined;
      await publish(run);
      await patchRun(run);
      return;
    }
    await startScan(run, tabId);
  }).catch((error: unknown) => console.error("Unable to resume filter setup:", error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void readRun().then(async (run) => {
    if (!run || run.tabId !== tabId || !["running", "awaiting_filters"].includes(run.status)) return;
    run.status = "paused";
    run.stage = run.stage === "awaiting_filters" ? "awaiting_filters" : "opening";
    run.statusText = run.stage === "awaiting_filters"
      ? "Search tab closed. Resume to set filters again."
      : "Search tab closed. Resume to reopen the search.";
    await publish(run);
    await patchRun(run);
  }).catch((error: unknown) => console.error("Unable to save closed-tab status:", error));
});

async function recoverInterruptedRun(): Promise<void> {
  let run = await readRun();
  if (!run) {
    const profile = await getProfileIdentity();
    const persisted = await api.activeRun(profile.id).catch(() => null);
    if (persisted) {
      const progress = JSON.parse(persisted.progress_json || "{}") as Partial<SearchRunState>;
      const queryId = persisted.current_query_id;
      if (queryId && progress.queryText && progress.searchUrl && progress.filters && progress.counters) {
        const recovered: SearchRunState = {
          ...progress,
          runId: persisted.id,
          queryId,
          queryText: progress.queryText,
          continueNext: Boolean(persisted.continue_next),
          status: persisted.status === "awaiting_filters" || persisted.status === "country_completed"
            ? persisted.status
            : "running",
          stage: progress.stage ?? "opening",
          statusText: progress.statusText ?? "Recovered interrupted run",
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
          profileLabel: persisted.profile_label || profile.label,
          queryResults: progress.queryResults ?? [],
          queriesAttempted: progress.queriesAttempted ?? 1,
          retryLimit: progress.retryLimit ?? 2,
          queryPauseMinMs: progress.queryPauseMinMs ?? 20_000,
          queryPauseMaxMs: progress.queryPauseMaxMs ?? 40_000,
          maxQueriesPerRun: progress.maxQueriesPerRun ?? 10,
          maxPostsPerDay: progress.maxPostsPerDay ?? 10_000,
          dailyPostsScanned: progress.dailyPostsScanned ?? 0,
          currentQueryRetries: progress.currentQueryRetries ?? 0,
          waitingForNextQuery: progress.waitingForNextQuery ?? false
        };
        run = recovered;
        await storeRun(recovered);
      }
    }
  }
  if (!run) return;
  if (run.status === "awaiting_filters" || run.status === "country_completed") {
    await publish(run);
    return;
  }
  if (run.status !== "running") return;
  if (run.stage === "completed" || run.counters.queryStatus === "completed") {
    run.waitingForNextQuery = true;
  }
  run.status = "paused";
  run.statusText = "Paused after browser or extension restart. Select Resume to continue.";
  await publish(run);
  await patchRun(run);
  if (run.tabId !== undefined) await sendToContent(run.tabId, { type: "PAUSE_SEARCH", runId: run.runId });
}

void recoverInterruptedRun().catch((error: unknown) => {
  console.error("Unable to recover the previous search run:", error);
});
