import type { CaptureBatchItem, FilterResult, ScanCounters, SearchRunState } from "../api/types";
import { expectedUrlFilters } from "./search-url";
import { extractEmails, isGenericEmail, relativeDateToISO, stripEmails } from "./extraction";
import { evaluatePost } from "./post-rule";
import { DEFAULT_JOB_WORDS } from "../../../shared/post-defaults";
import { runScrollLoop } from "./scroll-loop";
import { allFiltersLabels, filterControlNames, filterValueAliases, loadMoreLabels, memberInputHints, postContentLabel, safetyPatterns, selectorSets, showResultsLabels } from "./selectors";
import { filterChipMatches, filterIsAlreadyApplied, filterOptionMatchesValue, isFilterOptionSelected, filterPillMatchesValue, findFilterPill, getActiveFilterChipTexts, getFilterPillLabel, verifyFilterChip } from "./filter-verification";
import { canUseAutomaticFilterClick } from "./filter-choice";
import { mountOnPageControlBar } from "./on-page-control-bar";
import { findExpandableTextButton } from "./post-expansion";
import { findPostCards, findPostPermalink, postCardLinkDiagnostics, postDiscoveryDiagnostics } from "./post-discovery";

type ApplyMessage = {
  type: "APPLY_SEARCH_FILTERS";
  run: SearchRunState;
};

type SearchTextMessage = { type: "GET_SEARCH_TEXT" };

type CommandMessage = {
  type: "PAUSE_SEARCH" | "RESUME_SEARCH" | "STOP_SEARCH" | "SAVE_RETRY_RESULT" | "START_SCAN" | "CHANGE_SEARCH_QUERY" | "CAPTURE_LINK_DIAGNOSTICS";
  runId: number;
  run?: SearchRunState;
  batchId?: string;
  counters?: ScanCounters;
};

type ContentMessage = ApplyMessage | SearchTextMessage | CommandMessage;

type FilterProgressMessage = {
  type: "SEARCH_PROGRESS";
  runId: number;
  status: SearchRunState["status"];
  stage: SearchRunState["stage"];
  statusText: string;
  filterResults: FilterResult[];
  filterFailure?: boolean;
  error?: string;
};

const actionState = {
  runId: 0,
  run: null as SearchRunState | null,
  paused: false,
  stopped: false,
  processing: false,
  scanning: false,
  retrySavedBatchId: "",
  resume: null as (() => void) | null,
  observer: null as MutationObserver | null
};
const waitAborters = new Set<() => void>();
const filterLogStorageKey = "latestFilterApplicationLog";
type FilterLogEntry = {
  timestamp: string;
  runId: number;
  queryId: number;
  event: string;
};
let filterLogEntries: FilterLogEntry[] = [];
let filterLogWrite: Promise<void> = Promise.resolve();
let scanLogEntries: FilterLogEntry[] = [];
let scanLogWrite: Promise<void> = Promise.resolve();
let scanLogFlushTimer: number | undefined;
const scanLogStorageKey = "latestPostScanDiagnosticLog";

/**
 * Decides whether a post with emails should be collected, using the checks from
 * Settings → Collecting: hiring words, the record's search query, and an extra rule.
 * Runs saved before these settings existed use the default hiring-word check.
 */
function postPassesRule(run: SearchRunState, postText: string): boolean {
  const result = evaluatePost({
    requireJobWords: run.postRequireJobWords ?? true,
    jobWords: run.postJobWords ?? DEFAULT_JOB_WORDS,
    matchQuery: run.postMatchQuery ?? false,
    queryText: run.queryText,
    customRule: run.postRuleCustom ?? ""
  }, stripEmails(postText));
  for (const check of result.checks) {
    if (check.passed === null) appendScanLog(run, `Post rule ignored (${check.label}): ${check.error}`);
    else if (!check.passed) appendScanLog(run, `Post skipped: ${check.label.toLowerCase()} check failed.`);
  }
  return result.accepted;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function visibleText(element: Element): string {
  return [
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("title") ?? "",
    element.textContent ?? ""
  ].join(" ").trim();
}

function safetyReason(): string | null {
  if (/\/(login|checkpoint|challenge)(\/|$)/i.test(location.pathname)) {
    return "LinkedIn login or security-check page detected. The run stopped; complete any verification manually before continuing.";
  }
  const body = document.querySelector(selectorSets.visibleBody)?.innerText ?? "";
  const match = safetyPatterns.find((pattern) => pattern.test(body));
  return match
    ? "LinkedIn displayed a security check, captcha, rate-limit or restriction notice. The run stopped and will not attempt to bypass it."
    : null;
}

function sendProgress(message: FilterProgressMessage): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function sendScanProgress(run: SearchRunState, status = run.status, error?: string): Promise<void> {
  return chrome.runtime.sendMessage({
    type: "SEARCH_PROGRESS",
    runId: run.runId,
    status,
    stage: run.stage,
    statusText: run.statusText,
    filterResults: run.filterResults,
    counters: run.counters,
    pendingSave: run.pendingSave ?? false,
    processedPostIds: run.processedPostIds,
    ...(error ? { error } : {})
  }).then((response: { ok?: boolean } | undefined) => {
    if (response?.ok === false) {
      actionState.stopped = true;
      actionState.paused = false;
      actionState.resume?.();
    }
  }).catch(() => {
    actionState.stopped = true;
    actionState.paused = false;
    actionState.resume?.();
  });
}

function stopForSafety(run: SearchRunState, reason: string, results: FilterResult[]): void {
  actionState.stopped = true;
  actionState.paused = false;
  actionState.resume?.();
  for (const abort of waitAborters) abort();
  actionState.observer?.disconnect();
  sendProgress({
    type: "SEARCH_PROGRESS",
    runId: run.runId,
    status: "error",
    stage: "error",
    statusText: "Stopped for LinkedIn security notice",
    filterResults: results,
    error: reason
  });
}

async function waitUntil<T>(
  find: () => T | null,
  run: SearchRunState,
  timeoutMs = 12_000
): Promise<T | null> {
  const immediate = find();
  if (immediate) return immediate;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeout);
      waitAborters.delete(abort);
      resolve(value);
    };
    const abort = () => finish(null);
    const observer = new MutationObserver(() => {
      const safety = safetyReason();
      if (safety) {
        stopForSafety(run, safety, run.filterResults);
        finish(null);
        return;
      }
      const found = find();
      if (found) finish(found);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    waitAborters.add(abort);
    const timeout = window.setTimeout(() => finish(find()), timeoutMs);
  });
}

async function waitForReady(run: SearchRunState): Promise<boolean> {
  const ready = await waitUntil(() => document.querySelector(selectorSets.pageReady), run, 20_000);
  if (!ready || actionState.stopped) return false;
  return true;
}

async function changeSearchQueryAndScan(run: SearchRunState): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(selectorSets.searchInput);
  if (!input) throw new Error("LinkedIn search box is unavailable; filters were not changed.");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, run.queryText);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: run.queryText, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.focus();
  if (input.form) {
    input.form.requestSubmit();
  } else {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
  const queryChanged = await waitUntil(
    () => new URL(location.href).searchParams.get("keywords") === run.queryText ? true : null,
    run,
    15_000
  );
  if (!queryChanged) throw new Error(`LinkedIn did not switch the search to ${run.cityLabel}. The current filter selection was left unchanged.`);
  if (!await waitForReady(run)) throw new Error(`LinkedIn did not finish loading ${run.cityLabel}.`);
  run.status = "running";
  run.stage = "ready";
  run.statusText = `Filters reused · ${run.cityLabel}`;
  await scanResults(run);
}

function findOption(expected: string, aliases: string[] = []): HTMLElement | null {
  const overlays = [...document.querySelectorAll<HTMLElement>(selectorSets.overlays)].filter(visible);
  const root: ParentNode = overlays.length ? overlays[overlays.length - 1] : document;
  const candidates = [...root.querySelectorAll<HTMLElement>(selectorSets.options)].filter(visible);
  return candidates.find((element) => filterOptionMatchesValue(element, expected, aliases)) ?? null;
}

function activeChipTexts(): string[] {
  return getActiveFilterChipTexts(document, visible);
}

function resultFingerprint(): string {
  const results = [...document.querySelectorAll<HTMLElement>(selectorSets.resultLists)].find(visible);
  if (!results) return "";
  const cards = postCards();
  return `${location.href}|${cards.length}|${cards.slice(0, 3).map((card) => card.innerText.slice(0, 240)).join("|")}|${results.innerText.slice(0, 500)}`;
}

function showResultsButton(): HTMLElement | null {
  const labels = showResultsLabels.map(normalize);
  return [...document.querySelectorAll<HTMLElement>(selectorSets.controls)]
    .filter(visible)
    .find((element) => {
      const actual = normalize(element.innerText || element.getAttribute("aria-label") || "");
      return labels.some((label) => actual === label || actual.startsWith(`${label} `));
    }) ?? null;
}

function findVisibleTextControl(labels: readonly string[]): HTMLElement | null {
  const wanted = labels.map(normalize);
  return [...document.querySelectorAll<HTMLElement>(selectorSets.controls)]
    .filter(visible)
    .find((element) => wanted.includes(normalize(element.innerText))) ?? null;
}

function accessibleFilterLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>(selectorSets.filterPills)]
    .filter(visible)
    .map((element) => getFilterPillLabel(element) ?? "(missing aria-label)")
    .filter((label) => label !== "(missing aria-label)");
}

function persistFilterLog(): Promise<void> {
  const snapshot = [...filterLogEntries];
  filterLogWrite = filterLogWrite.then(async () => {
    await chrome.storage.local.set({ [filterLogStorageKey]: snapshot });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown storage error";
    console.error("[Email Extension] Could not save filter diagnostics:", message);
    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: actionState.runId,
      status: "error",
      stage: "error",
      statusText: "Could not save filter diagnostics",
      filterResults: actionState.run?.filterResults ?? [],
      error: "Filter diagnostics could not be saved to this Chrome profile."
    });
  });
  return filterLogWrite;
}

function appendFilterLog(run: SearchRunState, event: string): void {
  filterLogEntries.push({
    timestamp: new Date().toISOString(),
    runId: run.runId,
    queryId: run.queryId,
    event
  });
  if (filterLogEntries.length > 200) filterLogEntries.splice(0, filterLogEntries.length - 200);
  void persistFilterLog();
}

function filterDiagnostic(run: SearchRunState, message: string): void {
  appendFilterLog(run, message);
  if (!run.debugFilters) return;
  console.info(`[Email Extension] ${message}`);
  sendProgress({
    type: "SEARCH_PROGRESS",
    runId: run.runId,
    status: run.status,
    stage: "applying",
    statusText: message,
    filterResults: run.filterResults
  });
}

function flushScanLog(run: SearchRunState): Promise<void> {
  if (scanLogFlushTimer !== undefined) {
    window.clearTimeout(scanLogFlushTimer);
    scanLogFlushTimer = undefined;
  }
  const snapshot = [...scanLogEntries];
  scanLogWrite = scanLogWrite.then(async () => {
    await chrome.storage.local.set({ [scanLogStorageKey]: snapshot });
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : "Unknown storage error";
    console.error("[Email Extension] Could not save post-scan diagnostics:", detail);
    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: run.runId,
      status: "error",
      stage: "error",
      statusText: "Could not save post-scan diagnostics",
      filterResults: run.filterResults,
      error: "Post-scan diagnostics could not be saved to this Chrome profile."
    });
  });
  return scanLogWrite;
}

function appendScanLog(run: SearchRunState, event: string, always = false): void {
  if (!run.debugScan && !always) return;
  scanLogEntries.push({
    timestamp: new Date().toISOString(),
    runId: run.runId,
    queryId: run.queryId,
    event
  });
  if (scanLogEntries.length > 500) scanLogEntries.splice(0, scanLogEntries.length - 500);
  if (scanLogFlushTimer !== undefined) window.clearTimeout(scanLogFlushTimer);
  scanLogFlushTimer = window.setTimeout(() => {
    scanLogFlushTimer = undefined;
    void flushScanLog(run);
  }, 300);
}

async function delayForAction(run: SearchRunState): Promise<void> {
  const delay = run.delayMinMs + Math.random() * Math.max(0, run.delayMaxMs - run.delayMinMs);
  await new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      waitAborters.delete(finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, delay);
    waitAborters.add(finish);
  });
}

function delayForScan(run: SearchRunState): Promise<void> {
  const delay = run.scanDelayMinMs + Math.random() * Math.max(0, run.scanDelayMaxMs - run.scanDelayMinMs);
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      waitAborters.delete(finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, delay);
    waitAborters.add(finish);
  });
}

async function checkpoint(run: SearchRunState): Promise<boolean> {
  while (actionState.paused && !actionState.stopped) {
    await new Promise<void>((resolve) => { actionState.resume = resolve; });
  }
  actionState.resume = null;
  const reason = safetyReason();
  if (reason) stopForSafety(run, reason, run.filterResults);
  return !actionState.stopped;
}

function postCards(): HTMLElement[] {
  return findPostCards(document);
}

function permalinkFor(post: HTMLElement): string {
  return findPostPermalink(post);
}

function postId(post: HTMLElement): string {
  return post.getAttribute("data-urn")
    || post.getAttribute("data-id")
    || permalinkFor(post)
    || `text:${post.textContent?.trim().slice(0, 180) ?? ""}`;
}

function postDate(post: HTMLElement): { iso: string | null; original: string } {
  const dateElement = post.querySelector<HTMLElement>(selectorSets.postDates);
  const displayText = visibleText(dateElement ?? post);
  const dateValue = dateElement?.getAttribute("datetime") ?? displayText;
  return {
    iso: relativeDateToISO(dateValue),
    original: (displayText || dateValue).slice(0, 120)
  };
}

async function expandPost(post: HTMLElement, run: SearchRunState): Promise<"not_found" | "expanded" | "no_change"> {
  const expand = findExpandableTextButton(post);
  if (!expand || !visible(expand)) return "not_found";
  const content = post.querySelector<HTMLElement>(selectorSets.postText) ?? post;
  const previousLength = content.textContent?.length ?? 0;
  expand.click();
  const expanded = await waitUntil(
    () => !expand.isConnected || !visible(expand) || (content.textContent?.length ?? 0) > previousLength
      ? true
      : null,
    run,
    2000
  );
  return expanded ? "expanded" : "no_change";
}

async function loadMoreResults(): Promise<void> {
  const buttons = [...document.querySelectorAll<HTMLElement>(selectorSets.loadMoreButtons)].filter(visible);
  const loadMore = buttons.find((button) => {
    const label = normalize(visibleText(button));
    return loadMoreLabels.some((target) => label.includes(normalize(target)));
  });
  loadMore?.click();
}

async function saveCaptureBatch(run: SearchRunState, captures: CaptureBatchItem[]): Promise<boolean> {
  if (!captures.length) return true;
  const batchId = crypto.randomUUID();
  appendScanLog(
    run,
    `Saving capture batch: captures=${captures.length}; emailMatches=${captures.reduce((count, capture) => count + capture.emails.length, 0)}.`,
    true
  );
  const result = await chrome.runtime.sendMessage({
    type: "SAVE_BATCH",
    runId: run.runId,
    batchId,
    captures,
    counters: run.counters,
    processedPostIds: run.processedPostIds
  }) as {
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
  };
  if (result?.ok && result.counters) {
    appendScanLog(run, `Capture batch saved: captures=${captures.length}.`, true);
    run.counters = result.counters;
    run.pendingSave = false;
    run.error = undefined;
    sendScanProgress(run);
    return true;
  }

  appendScanLog(
    run,
    `Capture batch save failed: endpoint=POST /emails/save-batch; kind=${result?.saveDiagnostic?.errorKind ?? "unknown"}; httpStatus=${result?.saveDiagnostic?.httpStatus ?? "unknown"}; errorName=${result?.saveDiagnostic?.errorName ?? "unknown"}; serviceCode=${result?.saveDiagnostic?.serviceCode ?? "none"}; serviceExtendedCode=${result?.saveDiagnostic?.serviceExtendedCode ?? "none"}; serviceErrorName=${result?.saveDiagnostic?.serviceErrorName ?? "none"}; serviceRequestId=${result?.saveDiagnostic?.serviceRequestId ?? "none"}; serviceEndpoint=${result?.saveDiagnostic?.serviceEndpoint ?? "unknown"}; validation=${result?.saveDiagnostic?.serviceValidation ?? "none"}; retryable=${result?.retryable ?? "unknown"}.`,
    true
  );
  await flushScanLog(run);
  actionState.paused = result?.retryable !== false;
  actionState.stopped = result?.retryable === false;
  run.status = result?.retryable === false ? "error" : "paused";
  run.stage = result?.retryable === false ? "error" : run.stage;
  run.pendingSave = result?.retryable !== false;
  run.error = result?.error ?? "The service could not save this batch.";
  run.statusText = result?.retryable === false ? "Safety copy failed · run stopped" : "Save failed · batch kept for retry";
  sendScanProgress(run, run.status, run.error);
  if (result?.retryable === false) return false;
  const resumed = await checkpoint(run);
  if (!resumed || actionState.retrySavedBatchId !== batchId) return false;
  actionState.retrySavedBatchId = "";
  run.pendingSave = false;
  return true;
}

function createPostCapture(run: SearchRunState, post: HTMLElement, postText: string, extracted: ReturnType<typeof extractEmails>): CaptureBatchItem {
  const date = postDate(post);
  const author = post.querySelector<HTMLElement>(selectorSets.postAuthors)?.innerText.trim() ?? "";
  const allowed = run.ignoreGenericAddresses
    ? extracted.filter((email) => !isGenericEmail(email.normalized, run.ignoredEmailPrefixes))
    : extracted;
  return {
    country_code: "",
    city: "",
    post_url: permalinkFor(post),
    post_date: date.iso,
    post_date_text: date.original,
    author_name: author.slice(0, 300),
    post_text: postText,
    ignored_emails: extracted.length - allowed.length,
    emails: allowed.map((email) => ({ email: email.normalized, original: email.original }))
  };
}

async function scanResults(run: SearchRunState): Promise<void> {
  if (actionState.scanning || actionState.stopped || run.stage !== "ready") return;
  const safety = safetyReason();
  if (safety) {
    stopForSafety(run, safety, run.filterResults);
    return;
  }
  run.maxScrolls = Math.min(run.maxScrolls, 50);
  actionState.scanning = true;
  actionState.run = run;
  run.stage = "scanning";
  run.status = "running";
  run.counters.queryStatus = "scanning";
  run.statusText = "Scanning LinkedIn posts";
  const city = run.queryText.toLocaleLowerCase().includes(run.cityLabel.toLocaleLowerCase())
    ? run.cityLabel
    : "";
  const batch: CaptureBatchItem[] = [];
  let stopDetected = false;

  try {
    sendScanProgress(run);
    scanLogEntries = [];
    if (run.debugScan) {
      await chrome.storage.local.remove(scanLogStorageKey);
    }
    appendScanLog(run, `Post scan started for query ${run.queryId}; waiting up to 8 seconds for post cards.`);
    await waitUntil(() => postCards().length > 0 ? true : null, run, 8000);
    const discovery = postDiscoveryDiagnostics(document);
    appendScanLog(run, `Initial post discovery: ${JSON.stringify(discovery)}.`);
    if (discovery.matchedCards === 0) {
      run.status = "error";
      run.stage = "error";
      run.statusText = "No LinkedIn posts detected";
      run.error = `No post cards matched the current selectors. Found ${discovery.expandButtons} expandable-text buttons.`;
      appendScanLog(run, "Scan stopped before scrolling because no post cards were recognized.");
      await flushScanLog(run);
      sendScanProgress(run, "error", run.error);
      return;
    }
    appendScanLog(run, `Initial post link diagnostics: ${JSON.stringify(postCardLinkDiagnostics(document))}.`);
    await flushScanLog(run);
    const result = await runScrollLoop<HTMLElement>({
        getPosts: postCards,
        getPostId: postId,
        expandPost: async (post) => {
          const result = await expandPost(post, run);
          appendScanLog(run, `Post expansion check: ${result}; remaining expandable button ${findExpandableTextButton(post) ? "present" : "absent"}.`);
        },
        processPost: async (post) => {
          const postText = (post.querySelector<HTMLElement>(selectorSets.postText)?.innerText ?? post.innerText).slice(0, 20_000);
          const extracted = extractEmails(postText);
          run.counters.emailsFound += extracted.length;
          if (!extracted.length) {
            appendScanLog(run, "Post skipped: no email address found.");
          } else if (!postPassesRule(run, postText)) {
            run.counters.skippedByRule = (run.counters.skippedByRule ?? 0) + 1;
          } else {
            const capture = createPostCapture(run, post, postText, extracted);
            capture.country_code = run.countryCode;
            capture.city = city;
            appendScanLog(run, `Post processed: email matches ${capture.emails.length}; permalink ${capture.post_url ? "found" : "missing"}.`);
            if (!capture.post_url) appendScanLog(run, "Post has no permalink; scanning and saving with an empty Post link value.");
            batch.push(capture);
          }
          run.processedPostIds.push(postId(post));
        },
        afterPost: async () => {
          run.statusText = `Posts scanned ${run.counters.postsScanned}`;
          if (batch.length >= 10 && !await saveCaptureBatch(run, batch.splice(0, 10))) stopDetected = true;
        },
        scroll: () => window.scrollBy({ top: Math.max(350, Math.round(window.innerHeight * 0.65)), behavior: "smooth" }),
        afterScroll: async () => {
          const processed = new Set(run.processedPostIds);
          await waitUntil(() => postCards().some((post) => !processed.has(postId(post))) ? true : null, run, 6000);
          appendScanLog(run, `Post discovery after scroll ${run.counters.scrollCount + 1}: ${JSON.stringify(postDiscoveryDiagnostics(document))}.`);
        },
        loadMore: loadMoreResults,
        waitDelay: () => delayForScan(run),
        checkpoint: async () => {
          if (!await checkpoint(run)) return "stop";
          return "continue";
        },
        onProgress: async (scrollCount, postsScanned) => {
          run.counters.scrollCount = scrollCount;
          run.counters.postsScanned = postsScanned;
          run.statusText = `Scrolling (${scrollCount}/${run.maxScrolls}) · Posts scanned ${postsScanned}`;
          await sendScanProgress(run);
        }
      }, {
        maxScrolls: run.maxScrolls,
        maxPosts: run.maxPosts,
        stopAfterNoNewPosts: run.stopAfterNoNewPosts,
        initialPostsScanned: run.counters.postsScanned,
        initialScrollCount: run.counters.scrollCount,
        processedPostIds: run.processedPostIds
      });
      run.counters.postsScanned = result.postsScanned;
      run.counters.scrollCount = result.scrollCount;
      appendScanLog(run, `Scan loop ended: postsScanned=${result.postsScanned}; scrollCount=${result.scrollCount}; stopped=${result.stopped}.`);
      if (batch.length && !stopDetected && !await saveCaptureBatch(run, batch.splice(0))) stopDetected = true;
      if (result.stopped || actionState.stopped || stopDetected) return;

      if (result.postsScanned === 0) {
        run.status = "error";
        run.stage = "error";
        run.statusText = "No posts were scanned";
        run.error = "LinkedIn showed no unprocessed posts to scan.";
        appendScanLog(run, "Scan refused to report success because zero posts were processed.");
        await flushScanLog(run);
        sendScanProgress(run, "error", run.error);
        return;
      }

      run.stage = "completed";
      run.statusText = "Query completed";
      run.counters.queryStatus = "completed";
      appendScanLog(run, `Query completed successfully with ${result.postsScanned} posts scanned.`);
      await flushScanLog(run);
      sendScanProgress(run, "running");
  } catch (error) {
    run.status = "error";
    run.stage = "error";
    run.statusText = "Scanning stopped";
    run.error = error instanceof Error ? error.message : "An unexpected scanning error occurred.";
    appendScanLog(run, `Scan error: ${run.error}`);
    await flushScanLog(run);
    sendScanProgress(run, "error", run.error);
  } finally {
    actionState.scanning = false;
  }
}

async function selectFilter(
  run: SearchRunState,
  key: FilterResult["key"],
  value: string,
  index: number,
  total: number
): Promise<FilterResult> {
  const label = filterControlNames[key][0];
  const aliases = filterValueAliases[value] ?? [value];
  if (key === "from_member" && !value.trim()) {
    return { key, label, expected: "Any member", status: "not_requested" };
  }
  if (key === "date_posted" && value === "any") {
    return { key, label, expected: "Any time", status: "applied", message: "No date restriction requested." };
  }
  if (key === "content_type" && value === "all") {
    return { key, label, expected: "All content", status: "applied", message: "No content-type restriction requested." };
  }

  const current = activeChipTexts();
  const currentPill = findFilterPill(document, key, visible);
  if (filterIsAlreadyApplied(key, value, currentPill, current)) {
    filterDiagnostic(run, `Verified ${label}`);
    return {
      key,
      label,
      expected: value,
      status: "applied",
      message: filterPillMatchesValue(key, value, currentPill)
        ? "Matching sort value is shown on the filter control."
        : "Matching active filter is visible."
    };
  }

  if (["date_posted", "sort_by"].includes(key)) {
    const urlKey = key === "date_posted" ? "datePosted" : "sortBy";
    const urlValue = expectedUrlFilters(run.filters)[urlKey];
    if (urlValue && new URL(location.href).searchParams.get(urlKey) === urlValue) {
      const chipResult = verifyFilterChip(key, label, value, current);
      if (chipResult.status === "applied") return chipResult;
    }
  }

  sendProgress({
    type: "SEARCH_PROGRESS",
    runId: run.runId,
    status: "running",
    stage: "applying",
    statusText: `Applying filters (${index}/${total})`,
    filterResults: run.filterResults
  });
  if (!await checkpoint(run)) {
    return { key, label, expected: value, status: "not_applied", message: "Stopped before this filter was applied." };
  }

  filterDiagnostic(run, `Looking for the ${label} filter pill. Accessible filter labels: ${accessibleFilterLabels().join(", ") || "none"}.`);
  let control = await waitUntil(() => findFilterPill(document, key, visible), run, 2500);
  if (!control) {
    const allFilters = findVisibleTextControl(allFiltersLabels);
    if (allFilters) {
      filterDiagnostic(run, "Opened All filters");
      allFilters.click();
      control = await waitUntil(() => findFilterPill(document, key, visible), run, 5000);
      filterDiagnostic(run, `After opening All filters, accessible filter labels: ${accessibleFilterLabels().join(", ") || "none"}.`);
    } else {
      filterDiagnostic(run, `All filters control was not found. Accessible filter labels: ${accessibleFilterLabels().join(", ") || "none"}.`);
    }
  }
  if (!control) {
    const foundLabels = accessibleFilterLabels();
    const message = `Filter “${label}” was not found. Accessible filter labels found: ${foundLabels.join(", ") || "none"}.`;
    filterDiagnostic(run, message);
    return { key, label, expected: value, status: "not_applied", message };
  }
  if (!await checkpoint(run)) {
    return { key, label, expected: value, status: "not_applied", message: "Stopped before this filter was applied." };
  }
  filterDiagnostic(run, `Opened ${label}`);
  filterDiagnostic(run, `Located filter pill with accessible label "${getFilterPillLabel(control) ?? "missing"}".`);
  control.click();
  const opened = await waitUntil(() => {
    const overlays = [...document.querySelectorAll<HTMLElement>(selectorSets.overlays)].filter(visible);
    const option = findOption(value, aliases);
    return overlays.length || option ? true : null;
  }, run, 8000);
  if (!opened) {
    const message = `The ${label} dropdown did not appear. Accessible filter labels found: ${accessibleFilterLabels().join(", ") || "none"}.`;
    filterDiagnostic(run, message);
    return { key, label, expected: value, status: "not_applied", message };
  }
  if (!await checkpoint(run)) {
    return { key, label, expected: value, status: "not_applied", message: "Stopped before this filter was applied." };
  }

  if (key === "from_member") {
    const input = await waitUntil(
      () => {
        const overlays = [...document.querySelectorAll<HTMLElement>(selectorSets.overlays)].filter(visible);
        const overlayInputs = overlays.flatMap((overlay) =>
          [...overlay.querySelectorAll<HTMLInputElement>(selectorSets.textboxes)]
        );
        return overlayInputs.find((element) => visible(element) && element.type !== "hidden")
          ?? [...document.querySelectorAll<HTMLInputElement>(selectorSets.textboxes)]
            .find((element) => visible(element)
              && element.type !== "hidden"
              && memberInputHints.some((hint) => `${element.getAttribute("aria-label")} ${element.placeholder}`.toLocaleLowerCase().includes(hint)))
          ?? null;
      },
      run,
      4000
    );
    if (!input) {
      const message = `Member search field was not found. Accessible filter labels found: ${accessibleFilterLabels().join(", ") || "none"}.`;
      filterDiagnostic(run, message);
      return { key, label, expected: value, status: "not_applied", message };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value.trim());
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value.trim(), inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    filterDiagnostic(run, `Searching member “${value.trim()}”`);
    const memberOption = await waitUntil(
      () => findOption(value.trim()) ?? findOption(`People matching ${value.trim()}`),
      run,
      5000
    );
    if (!memberOption) {
      const message = `No matching member option appeared in LinkedIn. Accessible filter labels found: ${accessibleFilterLabels().join(", ") || "none"}.`;
      filterDiagnostic(run, message);
      return { key, label, expected: value, status: "not_applied", message };
    }
    filterDiagnostic(run, `Option “${memberOption.innerText.trim()}” found`);
    if (!await checkpoint(run)) {
      return { key, label, expected: value, status: "not_applied", message: "Stopped before selecting the member." };
    }
    memberOption.click();
    filterDiagnostic(run, `Selected member option “${memberOption.innerText.trim()}”`);
  } else {
    const option = await waitUntil(() => findOption(value, aliases), run, 5000);
    if (!option) {
      const message = `LinkedIn option “${aliases[0]}” was not found. Accessible filter labels found: ${accessibleFilterLabels().join(", ") || "none"}.`;
      filterDiagnostic(run, message);
      return { key, label, expected: value, status: "not_applied", message };
    }
    filterDiagnostic(run, `Option “${option.innerText.trim()}” found`);
    if (!await checkpoint(run)) {
      return { key, label, expected: value, status: "not_applied", message: "Stopped before selecting this filter." };
    }
    option.click();
    filterDiagnostic(run, `Selected option “${option.innerText.trim()}”`);
    if (option.getAttribute("role") === "radio") {
      const selected = isFilterOptionSelected(option)
        || await waitUntil(() => isFilterOptionSelected(option) ? true : null, run, 2000);
      filterDiagnostic(run, `Radio option selection state: ${isFilterOptionSelected(option) ? "checked" : "not checked"}.`);
      if (!selected) {
        return {
          key,
          label,
          expected: value,
          status: "not_applied",
          message: `LinkedIn did not mark the “${option.getAttribute("aria-label") || option.innerText.trim()}” option as selected.`
        };
      }
    }
  }

  const showResults = await waitUntil(() => showResultsButton(), run, 5000);
  if (!showResults) {
    const message = `LinkedIn did not show a Show results or Apply button. Accessible filter labels found: ${accessibleFilterLabels().join(", ") || "none"}.`;
    filterDiagnostic(run, message);
    return { key, label, expected: value, status: "not_applied", message };
  }
  const beforeResults = resultFingerprint();
  let sawBusy = Boolean(document.querySelector(selectorSets.busyIndicators));
  showResults.click();
  filterDiagnostic(run, "Clicked Show results");
  const reloaded = await waitUntil(() => {
    const busy = document.querySelector(selectorSets.busyIndicators);
    if (busy) {
      sawBusy = true;
      return null;
    }
    return resultFingerprint() !== beforeResults || sawBusy ? true : null;
  }, run, 10_000);
  if (!reloaded) {
    return { key, label, expected: value, status: "not_applied", message: "The LinkedIn results did not reload after Show results." };
  }
  const verified = await waitUntil(() => {
    const chips = activeChipTexts();
    const currentPill = findFilterPill(document, key, visible);
    return filterChipMatches(value, chips) || filterPillMatchesValue(key, value, currentPill)
      ? chips
      : null;
  }, run, 5000);
  if (verified) {
    filterDiagnostic(run, `Verified ${label}`);
    return { key, label, expected: value, status: "applied", message: "Matching active filter is visible." };
  }
  return { key, label, expected: value, status: "not_applied", message: "Filter selection was made, but a matching active filter chip was not visible." };
}

async function applyFilterWithRetry(
  run: SearchRunState,
  key: FilterResult["key"],
  value: string,
  index: number,
  total: number
): Promise<FilterResult> {
  appendFilterLog(run, `Applying filter ${key} with saved value "${value}" (attempt 1).`);
  let result = await selectFilter(run, key, value, index, total);
  if (result.status === "not_applied" && !actionState.stopped) {
    appendFilterLog(run, `${result.label} not applied on attempt 1: ${result.message}`);
    filterDiagnostic(run, `${result.label} not applied; retrying once`);
    result = await selectFilter(run, key, value, index, total);
  }
  appendFilterLog(run, `${result.label} result: ${result.status}${result.message ? ` — ${result.message}` : ""}`);
  return result;
}

async function applyFilters(run: SearchRunState): Promise<void> {
  if (!canUseAutomaticFilterClick(run.experimentalAutomaticFilters === true)) {
    run.status = "awaiting_filters";
    run.stage = "awaiting_filters";
    run.statusText = `Set filters for ${run.countryCode}`;
    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: run.runId,
      status: "awaiting_filters",
      stage: "awaiting_filters",
      statusText: run.statusText,
      filterResults: run.filterResults
    });
    return;
  }
  if (actionState.processing) return;
  actionState.processing = true;
  actionState.run = run;
  actionState.runId = run.runId;
  actionState.paused = false;
  actionState.stopped = false;
  filterLogEntries = [];
  appendFilterLog(run, `Filter application started for query ${run.queryId}.`);
  run.stage = "applying";
  try {
    const safety = safetyReason();
    if (safety) {
      stopForSafety(run, safety, []);
      return;
    }

    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: run.runId,
      status: "running",
      stage: "applying",
      statusText: "Waiting for LinkedIn search page",
      filterResults: []
    });
    const pageReady = await waitForReady(run);
    if (!pageReady) {
      if (!actionState.stopped) {
        run.status = "error";
        run.stage = "error";
        run.statusText = "LinkedIn search page did not become ready";
        run.error = "The LinkedIn Posts search page did not become ready before the timeout.";
        sendProgress({
          type: "SEARCH_PROGRESS",
          runId: run.runId,
          status: "error",
          stage: "error",
          statusText: run.statusText,
          filterResults: [],
          error: run.error
        });
      }
      return;
    }
    if (!await checkpoint(run)) return;

    if (!location.pathname.startsWith("/search/results/content/")) {
      const message = `Expected the LinkedIn Posts results page; current path is ${location.pathname || "(empty)"}.`;
      run.status = "error";
      run.stage = "error";
      run.statusText = "Posts search is not active";
      run.error = message;
      sendProgress({
        type: "SEARCH_PROGRESS",
        runId: run.runId,
        status: "error",
        stage: "error",
        statusText: run.statusText,
        filterResults: [],
        filterFailure: true,
        error: message
      });
      return;
    }
    const postsTab = document.querySelector<HTMLElement>(selectorSets.postsTab);
    if (postsTab?.getAttribute("aria-pressed") === "false" || postsTab?.getAttribute("aria-selected") === "false") {
      postsTab.click();
      const activated = await waitUntil(
        () => postsTab.getAttribute("aria-pressed") === "true" || postsTab.getAttribute("aria-selected") === "true" ? true : null,
        run,
        5000
      );
      if (!activated) {
        const message = `${postContentLabel} was not activated.`;
        run.status = "error";
        run.stage = "error";
        run.statusText = "Posts search is not active";
        run.error = message;
        sendProgress({
          type: "SEARCH_PROGRESS",
          runId: run.runId,
          status: "error",
          stage: "error",
          statusText: run.statusText,
          filterResults: [],
          filterFailure: true,
          error: message
        });
        return;
      }
    }
    filterDiagnostic(run, "Posts results page verified");

    const tasks: Array<{ key: FilterResult["key"]; value: string }> = [
      { key: "date_posted", value: run.filters.date_posted },
      { key: "sort_by", value: run.filters.sort_by },
      { key: "content_type", value: run.filters.content_type },
      { key: "from_member", value: run.filters.from_member }
    ];
    const results: FilterResult[] = [];
    for (const [index, task] of tasks.entries()) {
      if (!await checkpoint(run)) return;
      const result = await applyFilterWithRetry(run, task.key, task.value, index + 1, tasks.length);
      results.push(result);
      run.filterResults = results;
      run.stage = "applying";
      run.statusText = `Applying filters (${index + 1}/${tasks.length})`;
      sendProgress({
        type: "SEARCH_PROGRESS",
        runId: run.runId,
        status: "running",
        stage: "applying",
        statusText: run.statusText,
        filterResults: results
      });
      if (actionState.stopped) return;
      await delayForAction(run);
    }

    const failed = results.filter((result) => result.status === "not_applied");
    const mayContinue = failed.length > 0 && run.continueOnFilterFailure === true;
    run.stage = failed.length && !mayContinue ? "error" : "ready";
    run.statusText = failed.length
      ? mayContinue
        ? `Continuing despite failed filter${failed.length === 1 ? "" : "s"}: ${failed.map((result) => result.label).join(", ")}`
        : `${failed.length} filter${failed.length === 1 ? "" : "s"} could not be applied: ${failed.map((result) => result.label).join(", ")}`
      : "Ready to scan";
    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: run.runId,
      status: failed.length && !mayContinue ? "error" : "running",
      stage: run.stage,
      statusText: run.statusText,
      filterResults: results,
      filterFailure: failed.length > 0 && !mayContinue,
      ...(failed.length && !mayContinue ? { error: failed.map((result) => `${result.label}: ${result.message}`).join(" ") } : {})
    });
    appendFilterLog(run, `Filter application finished: ${results.map((result) => `${result.label}=${result.status}`).join("; ")}.`);
    await filterLogWrite;
    actionState.observer?.disconnect();
    actionState.observer = new MutationObserver(() => {
      const reason = safetyReason();
      if (reason && actionState.run) stopForSafety(actionState.run, reason, actionState.run.filterResults);
    });
    actionState.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    if (!failed.length || mayContinue) void scanResults(run);
  } finally {
    if (!filterLogEntries.some((entry) => entry.event.startsWith("Filter application finished:"))) {
      appendFilterLog(run, "Filter application ended before all filters completed.");
    }
    await filterLogWrite;
    actionState.processing = false;
  }
}

chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
  if (message.type === "GET_SEARCH_TEXT") {
    const input = document.querySelector<HTMLInputElement>(selectorSets.searchInput);
    sendResponse({
      ok: true,
      queryText: input?.value.trim() || new URL(location.href).searchParams.get("keywords") || ""
    });
    return false;
  }
  if (message.type === "APPLY_SEARCH_FILTERS") {
    message.run.counters ??= {
      scrollCount: 0,
      postsScanned: 0,
      emailsFound: 0,
      newEmails: 0,
      duplicateEmails: 0,
      ignoredEmails: 0,
      queryStatus: "pending"
    };
    message.run.processedPostIds ??= [];
    message.run.recentCaptures ??= [];
    message.run.cityLabel ??= "";
    message.run.countryCode ??= "";
    void applyFilters(message.run);
    sendResponse({ ok: true, runId: message.run.runId });
    return false;
  }
  if (message.type === "START_SCAN") {
    actionState.runId = message.runId;
    actionState.run = message.run ?? actionState.run;
    if (!actionState.run) {
      sendResponse({ ok: false });
      return false;
    }
    actionState.run.status = "running";
    actionState.run.stage = "ready";
    actionState.stopped = false;
    actionState.paused = false;
    void scanResults(actionState.run);
    sendResponse({ ok: true, runId: message.runId });
    return false;
  }
  if (message.type === "CHANGE_SEARCH_QUERY") {
    actionState.runId = message.runId;
    actionState.run = message.run ?? actionState.run;
    if (!actionState.run) {
      sendResponse({ ok: false, error: "Run state is unavailable." });
      return false;
    }
    actionState.stopped = false;
    actionState.paused = false;
    sendResponse({ ok: true, runId: message.runId });
    void changeSearchQueryAndScan(actionState.run).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "Could not change the LinkedIn search.";
      sendProgress({
        type: "SEARCH_PROGRESS",
        runId: actionState.runId,
        status: "error",
        stage: "error",
        statusText: "Could not continue to the next record",
        filterResults: actionState.run?.filterResults ?? [],
        error: detail
      });
    });
    return false;
  }
  if (message.type === "CAPTURE_LINK_DIAGNOSTICS") {
    const run = actionState.run;
    if (!run || run.runId !== message.runId || !run.debugScan) {
      sendResponse({ ok: false, error: "Scan diagnostics are unavailable for this run." });
      return false;
    }
    appendScanLog(run, `Manual post-link snapshot: ${JSON.stringify(postCardLinkDiagnostics(document))}.`);
    void flushScanLog(run).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.runId !== actionState.runId || !actionState.run) {
    sendResponse({ ok: false });
    return false;
  }

  if (message.type === "PAUSE_SEARCH") {
    actionState.paused = true;
    actionState.run.status = "paused";
    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: actionState.runId,
      status: "paused",
      stage: actionState.run.stage,
      statusText: "Paused",
      filterResults: actionState.run.filterResults
    });
  } else if (message.type === "RESUME_SEARCH") {
    actionState.paused = false;
    actionState.run.status = "running";
    actionState.run.pendingSave = false;
    actionState.run.error = undefined;
    if (message.counters) actionState.run.counters = message.counters;
    actionState.resume?.();
    if (actionState.run.stage === "awaiting_filters") {
      sendScanProgress(actionState.run, "awaiting_filters");
    } else if (actionState.run.stage !== "ready" && !actionState.processing) void applyFilters(actionState.run);
    else if (actionState.run.stage === "ready" && !actionState.scanning) void scanResults(actionState.run);
    else sendScanProgress(actionState.run, "running");
  } else if (message.type === "SAVE_RETRY_RESULT") {
    if (message.batchId) actionState.retrySavedBatchId = message.batchId;
    actionState.run.pendingSave = false;
    actionState.run.error = undefined;
    if (message.counters) actionState.run.counters = message.counters;
  } else if (message.type === "STOP_SEARCH") {
    actionState.stopped = true;
    actionState.paused = false;
    actionState.run.status = "stopped";
    actionState.run.stage = "stopped";
    actionState.resume?.();
    for (const abort of waitAborters) abort();
    actionState.observer?.disconnect();
    sendProgress({
      type: "SEARCH_PROGRESS",
      runId: actionState.runId,
      status: "stopped",
      stage: "stopped",
      statusText: "Stopped",
      filterResults: actionState.run.filterResults
    });
  }
  sendResponse({ ok: true, runId: actionState.runId });
  return false;
});

mountOnPageControlBar();
