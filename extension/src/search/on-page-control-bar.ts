import type { CountryFilterProfile, QueryRecord, SearchRunState } from "../api/types";
import { countryLabel } from "../ui/display";
import { countryQueries } from "./query-chain";
import { summarizeFilterParams } from "./search-url";

type BarResponse = {
  ok?: boolean;
  queries?: QueryRecord[];
  countryFilters?: CountryFilterProfile[];
  run?: SearchRunState | null;
  defaultQueryId?: number | null;
  error?: string;
  opened?: "sidePanel" | "tab";
};

type BarPosition = { left: number; top: number; collapsed?: boolean };
type FilterChoice = "capture" | "saved" | "skip" | "continue";

const positionKey = "linkedinControlBarPosition";

export function mountOnPageControlBar(): void {
  if (document.getElementById("job-post-email-tracker-control")) return;

  const host = document.createElement("div");
  host.id = "job-post-email-tracker-control";
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; display: block; position: fixed; z-index: 2147483647; top: 16px; right: 16px; color-scheme: light dark; }
      * { box-sizing: border-box; }
      .shell { width: min(420px, calc(100vw - 16px)); border: 1px solid #aeb7d2; border-radius: 10px; background: #fff; color: #172033; box-shadow: 0 6px 20px #10182830; font: 11px/1.3 system-ui, sans-serif; }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 7px 0; }
      .drag { cursor: move; font-weight: 700; user-select: none; }
      .row { display: grid; grid-template-columns: minmax(86px, .8fr) minmax(105px, 1.2fr) 48px 48px; align-items: end; gap: 5px; padding: 5px 7px 3px; }
      label { display: grid; gap: 2px; min-width: 0; font-size: 10px; font-weight: 600; }
      select, button { min-width: 0; min-height: 27px; border: 1px solid #aab2c5; border-radius: 6px; background: #fff; color: inherit; font: inherit; padding: 3px 5px; }
      button { cursor: pointer; font-weight: 650; white-space: nowrap; }
      button.primary { border-color: #4149b8; background: #4149b8; color: #fff; }
      button.danger { border-color: #ad3441; color: #8d2330; }
      button:disabled { border-color: #c4cad5; background: #e6e9ef; color: #5b6473; cursor: not-allowed; opacity: 1; }
      button:focus-visible, select:focus-visible, input:focus-visible, .drag:focus-visible { outline: 3px solid #f0aa31; outline-offset: 2px; }
      .panel { margin: 2px 8px 8px; padding: 8px; border: 1px solid #c8cdec; border-radius: 8px; background: #f4f5ff; }
      .panel strong, .panel p { display: block; margin: 0 0 5px; }
      .panel-actions { display: flex; flex-wrap: wrap; gap: 5px; }
      .status { display: block; min-height: 22px; padding: 3px 8px 5px; overflow: hidden; font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .error { color: #9c2532; }
      .refresh { margin-left: 8px; min-height: 26px; }
      .copy-scan-log { margin: 0 8px 7px; min-height: 25px; }
      .hidden { display: none !important; }
      @media (prefers-color-scheme: dark) {
        .shell { background: #171b28; color: #eef1fa; border-color: #535b75; }
        select, button { background: #22283a; color: #eef1fa; border-color: #626c89; }
        .panel { background: #20253a; border-color: #535b75; }
        button.primary { background: #7278ed; border-color: #7278ed; color: #101326; }
        button.danger { color: #ff9da5; }
        button:disabled { background: #303647; color: #bbc2d0; border-color: #50586b; }
        .error { color: #ff9da5; }
      }
      @media (max-width: 560px) {
        :host { right: 8px; top: 8px; }
        .shell { width: calc(100vw - 16px); }
      }
    </style>
    <section class="shell" aria-label="Email Extension controls">
      <div class="head"><span class="drag" tabindex="0" aria-label="Drag tracker control bar" title="Drag to move">Email Extension</span><button class="collapse" type="button" aria-label="Collapse control bar" aria-expanded="true" title="Collapse">−</button></div>
      <div class="body">
        <div class="row">
          <label>Country<select class="country" aria-label="Choose a country"><option value="">Loading countries…</option></select></label>
          <label>Record<select class="record" aria-label="Choose a record in this country"><option value="">Choose a country first</option></select></label>
          <button class="primary start" type="button" aria-label="Start selected record">Start</button>
          <button class="danger stop" type="button" aria-label="Stop current run" disabled>Stop</button>
        </div>
        <small class="status" role="status" aria-live="polite">Loading saved records…</small>
        <button class="retry-save hidden" type="button">Retry pending save</button>
        <section class="panel hidden" aria-live="polite">
          <strong class="panel-title"></strong><p class="panel-copy"></p>
          <div class="panel-actions">
            <button class="panel-continue primary" type="button">Continue</button>
            <button class="panel-saved hidden" type="button">Use saved filters</button>
            <button class="panel-skip" type="button">Skip filters</button>
            <button class="panel-stop danger" type="button">Stop</button>
            <button class="panel-country primary hidden" type="button"></button>
            <button class="panel-skip-country hidden" type="button">Skip country</button>
          </div>
        </section>
        <button class="capture-link-state hidden" type="button">Capture link state</button>
        <button class="copy-scan-log hidden" type="button">Copy save logs</button>
        <button class="refresh hidden" type="button">Retry</button>
      </div>
    </section>`;

  const shell = root.querySelector<HTMLElement>(".shell")!;
  const body = root.querySelector<HTMLElement>(".body")!;
  const countrySelect = root.querySelector<HTMLSelectElement>(".country")!;
  const select = root.querySelector<HTMLSelectElement>(".record")!;
  const start = root.querySelector<HTMLButtonElement>(".start")!;
  const stop = root.querySelector<HTMLButtonElement>(".stop")!;
  const status = root.querySelector<HTMLElement>(".status")!;
  const retrySave = root.querySelector<HTMLButtonElement>(".retry-save")!;
  const copyScanLog = root.querySelector<HTMLButtonElement>(".copy-scan-log")!;
  const captureLinkState = root.querySelector<HTMLButtonElement>(".capture-link-state")!;
  const retry = root.querySelector<HTMLButtonElement>(".refresh")!;
  const collapse = root.querySelector<HTMLButtonElement>(".collapse")!;
  const panel = root.querySelector<HTMLElement>(".panel")!;
  const panelTitle = root.querySelector<HTMLElement>(".panel-title")!;
  const panelCopy = root.querySelector<HTMLElement>(".panel-copy")!;
  const continueFilters = root.querySelector<HTMLButtonElement>(".panel-continue")!;
  const useSavedFilters = root.querySelector<HTMLButtonElement>(".panel-saved")!;
  const skipFilters = root.querySelector<HTMLButtonElement>(".panel-skip")!;
  const panelStop = root.querySelector<HTMLButtonElement>(".panel-stop")!;
  const continueCountry = root.querySelector<HTMLButtonElement>(".panel-country")!;
  const skipCountry = root.querySelector<HTMLButtonElement>(".panel-skip-country")!;
  let queries: QueryRecord[] = [];
  let countryFilters: CountryFilterProfile[] = [];
  let run: SearchRunState | null = null;
  let position: BarPosition | null = null;
  let preferredQueryId = "";
  let preferredCountryCode = "";
  let loading = false;
  const showError = (message: string) => {
    status.textContent = message;
    status.classList.add("error");
    retry.classList.remove("hidden");
  };

  const render = () => {
    const selected = queries.find((query) => query.id === Number(select.value));
    const profile = countryFilters.find((item) => item.country_code === countrySelect.value);
    const active = run?.status === "running" || run?.status === "paused" || run?.status === "awaiting_filters" || run?.status === "country_completed";
    start.disabled = loading || !selected || Boolean(active);
    stop.disabled = !active;
    countrySelect.disabled = Boolean(active);
    select.disabled = Boolean(active);
    if (run) {
      const runCountryCode = run.countryCode;
      const failure = run.error ? ` · ${run.error}` : "";
      status.textContent = `${run.statusText}${failure}`;
      const filterSummary = profile?.params ? summarizeFilterParams(profile.params) : profile?.summary;
      status.title = `${status.textContent}${filterSummary ? ` · Filters: ${filterSummary}` : ""}`;
      status.classList.toggle("error", run.status === "error" || Boolean(run.error));
      retry.classList.add("hidden");
      retrySave.classList.toggle("hidden", !run.pendingSave);
      copyScanLog.classList.toggle("hidden", !(run.pendingSave || (run.debugScan && run.status === "error")));
      captureLinkState.classList.toggle("hidden", !(run.status === "error" && run.debugScan));
      panel.classList.toggle("hidden", run.status !== "awaiting_filters" && run.status !== "country_completed");
      if (run.status === "awaiting_filters") {
        panelTitle.textContent = run.filterFallback
          ? `Set filters for ${countryLabel(run.countryCode)}`
          : `Set filters for ${countryLabel(run.countryCode)}`;
        panelCopy.textContent = run.filterFallback
          ? `LinkedIn does not expose these filters in the URL. Choose them on this first record, then Continue. The extension will reuse this LinkedIn page's filter selection for the rest of ${countryLabel(run.countryCode)} by changing only the search text. This fallback is limited to the current LinkedIn tab.`
          : run.statusText.startsWith("Filters were lost.")
            ? "Filters were lost. Set the filters again, then click Continue."
          : "Set your filters on LinkedIn now (Date posted, Sort by, Content type, From member), then click Continue.";
        continueFilters.classList.remove("hidden");
        continueFilters.textContent = "Continue";
        useSavedFilters.classList.toggle("hidden", !countryFilters.some((item) => item.country_code === runCountryCode && Boolean(item.params)));
        skipFilters.classList.remove("hidden");
        panelStop.classList.remove("hidden");
        continueCountry.classList.add("hidden");
        skipCountry.classList.add("hidden");
      } else if (run.status === "country_completed") {
        panelTitle.textContent = "Country finished";
        panelCopy.textContent = run.statusText;
        continueFilters.classList.add("hidden");
        useSavedFilters.classList.add("hidden");
        skipFilters.classList.add("hidden");
        panelStop.classList.remove("hidden");
        continueCountry.classList.toggle("hidden", !run.nextCountryCode);
        continueCountry.textContent = `Set filters & continue with ${run.nextCountryCode ? countryLabel(run.nextCountryCode) : ""}`;
        skipCountry.classList.toggle("hidden", !run.nextCountryCode);
      }
    } else if (!loading && !status.classList.contains("error")) {
      status.textContent = "Ready";
      status.title = profile?.summary ?? "";
      panel.classList.add("hidden");
      retrySave.classList.add("hidden");
      copyScanLog.classList.add("hidden");
    }
  };

  const renderRecords = () => {
    const selectedId = preferredQueryId || select.value;
    const countryCode = countrySelect.value;
    select.replaceChildren(new Option("Choose a starting record", ""));
    for (const query of countryQueries(queries, countryCode)) {
      select.append(new Option(`${query.position + 1} – ${query.label}`, String(query.id)));
    }
    if ([...select.options].some((option) => option.value === selectedId)) select.value = selectedId;
    else if (select.options.length > 1) select.selectedIndex = 1;
    preferredQueryId = select.value;
    render();
  };

  const renderQueries = () => {
    const enabled = queries.filter((query) => Boolean(query.enabled));
    const countries = [...new Set(enabled.map((query) => query.country_code))]
      .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)));
    const selected = enabled.find((query) => String(query.id) === preferredQueryId);
    if (!countries.includes(preferredCountryCode)) preferredCountryCode = selected?.country_code ?? countries[0] ?? "";
    countrySelect.replaceChildren(new Option("Choose a country", ""));
    for (const country of countries) countrySelect.append(new Option(countryLabel(country), country));
    countrySelect.value = preferredCountryCode;
    renderRecords();
  };

  const refresh = async () => {
    loading = true;
    status.classList.remove("error");
    status.textContent = "Loading saved records…";
    retry.classList.add("hidden");
    start.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_ONPAGE_DATA" }) as BarResponse | undefined;
      if (!response?.ok) throw new Error(response?.error || "Could not load records.");
      queries = response.queries ?? [];
      countryFilters = response.countryFilters ?? [];
      run = response.run ?? null;
      if (run && ["running", "paused", "awaiting_filters", "country_completed"].includes(run.status)) {
        preferredCountryCode = run.countryCode;
        preferredQueryId = String(run.queryId);
      }
      if (!preferredQueryId && response.defaultQueryId) preferredQueryId = String(response.defaultQueryId);
      renderQueries();
      if (!queries.some((query) => Boolean(query.enabled))) {
        status.textContent = "No enabled records. Enable or add a record in the tracker.";
      }
    } catch (error) {
      run = null;
      const detail = error instanceof Error ? error.message : "Could not reach the service.";
      showError(`Service offline / Add token in Setup. ${detail}`);
    } finally {
      loading = false;
      render();
    }
  };

  countrySelect.addEventListener("change", () => {
    preferredCountryCode = countrySelect.value;
    preferredQueryId = "";
    void chrome.storage.local.set({ selectedCountryCode: preferredCountryCode, selectedQueryId: null }).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : "Could not save the selected country.");
    });
    renderRecords();
  });
  select.addEventListener("change", () => {
    preferredQueryId = select.value;
    void chrome.storage.local.set({ selectedQueryId: Number(select.value) || null }).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : "Could not save the selected record.");
    });
    render();
  });
  retry.addEventListener("click", () => void refresh());
  start.addEventListener("click", async () => {
    if (!select.value) return;
    loading = true;
    status.classList.remove("error");
    status.textContent = "Starting selected record…";
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_SELECTED_RECORD",
        queryId: Number(select.value),
        countryCode: countrySelect.value,
        continueNext: true
      }) as BarResponse | undefined;
      if (!response?.ok) throw new Error(response?.error || "Could not start this record.");
      await refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not start this record.");
    } finally {
      loading = false;
      render();
    }
  });
  const chooseFilters = async (choice: FilterChoice) => {
    if (!run) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "FILTER_CHOICE", runId: run.runId, choice }) as { ok?: boolean; error?: string };
      if (!response?.ok) showError(response?.error || "Could not continue with these filters.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not continue with these filters.");
    }
  };
  continueFilters.addEventListener("click", () => void chooseFilters(run?.filterFallback ? "continue" : "capture"));
  useSavedFilters.addEventListener("click", () => void chooseFilters("saved"));
  skipFilters.addEventListener("click", () => void chooseFilters("skip"));
  panelStop.addEventListener("click", async () => {
    if (!run) return;
    const response = await chrome.runtime.sendMessage({ type: "STOP_SEARCH", runId: run.runId }) as { ok?: boolean; error?: string };
    if (!response?.ok) showError(response?.error || "Could not stop the run.");
  });
  continueCountry.addEventListener("click", async () => {
    if (!run) return;
    const response = await chrome.runtime.sendMessage({ type: "COUNTRY_BOUNDARY_ACTION", runId: run.runId, action: "continue" }) as { ok?: boolean; error?: string };
    if (!response?.ok) showError(response?.error || "Could not continue to the next country.");
  });
  skipCountry.addEventListener("click", async () => {
    if (!run) return;
    const response = await chrome.runtime.sendMessage({ type: "COUNTRY_BOUNDARY_ACTION", runId: run.runId, action: "skip" }) as { ok?: boolean; error?: string };
    if (!response?.ok) showError(response?.error || "Could not skip this country.");
  });
  retrySave.addEventListener("click", async () => {
    if (!run?.pendingSave) return;
    retrySave.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "RETRY_SAVE",
        runId: run.runId
      }) as { ok?: boolean; error?: string };
      if (!response?.ok) showError(response?.error || "Could not retry the pending save.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not retry the pending save.");
    } finally {
      retrySave.disabled = false;
    }
  });
  copyScanLog.addEventListener("click", async () => {
    try {
      const stored = await chrome.storage.local.get(["latestSaveDiagnosticLog", "latestPostScanDiagnosticLog"]);
      const saveEntries = Array.isArray(stored.latestSaveDiagnosticLog) ? stored.latestSaveDiagnosticLog : [];
      const scanEntries = Array.isArray(stored.latestPostScanDiagnosticLog) ? stored.latestPostScanDiagnosticLog : [];
      const entries = [...scanEntries, ...saveEntries].sort((left, right) =>
        String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))
      );
      if (entries.length === 0) {
        showError("No save diagnostic log is available. Retry the pending save, then copy logs again.");
        return;
      }
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
      status.textContent = `Copied ${entries.length} save diagnostic entries.`;
      status.title = "Save diagnostics copied to clipboard.";
      status.classList.remove("error");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not copy scan diagnostics.");
    }
  });
  captureLinkState.addEventListener("click", async () => {
    if (!run) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CAPTURE_LINK_DIAGNOSTICS",
        runId: run.runId
      }) as { ok?: boolean; error?: string };
      if (!response?.ok) {
        showError(response?.error || "Could not capture current post-link state.");
        return;
      }
      status.textContent = "Captured current post-link state. Click Copy scan logs to copy it.";
      status.classList.remove("error");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not capture current post-link state.");
    }
  });
  stop.addEventListener("click", async () => {
    if (!run) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "STOP_SEARCH", runId: run.runId }) as { ok?: boolean; error?: string };
      if (!response?.ok) showError(response?.error || "Could not stop the run.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not stop the run.");
    }
  });
  collapse.addEventListener("click", () => {
    body.classList.toggle("hidden");
    const collapsed = body.classList.contains("hidden");
    collapse.textContent = collapsed ? "+" : "−";
    collapse.setAttribute("aria-label", collapsed ? "Expand control bar" : "Collapse control bar");
    collapse.setAttribute("aria-expanded", String(!collapsed));
    if (position) position.collapsed = collapsed;
    void chrome.storage.local.set({ [positionKey]: position }).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : "Could not save the control-bar state.");
    });
    if (!collapsed) void refresh();
  });

  const drag = root.querySelector<HTMLElement>(".drag")!;
  drag.addEventListener("keydown", (event) => {
    const offsets: Record<string, [number, number]> = {
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0]
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const bounds = host.getBoundingClientRect();
    const current = position ?? { left: bounds.left, top: bounds.top };
    position = {
      ...current,
      left: Math.max(0, Math.min(window.innerWidth - shell.offsetWidth, current.left + offset[0])),
      top: Math.max(0, Math.min(window.innerHeight - 40, current.top + offset[1]))
    };
    host.style.left = `${position.left}px`;
    host.style.top = `${position.top}px`;
    host.style.right = "auto";
    void chrome.storage.local.set({ [positionKey]: position }).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : "Could not save the control-bar position.");
    });
  });
  drag.addEventListener("pointerdown", (event) => {
    if (!position) {
      const bounds = host.getBoundingClientRect();
      position = { left: bounds.left, top: bounds.top };
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = position.left;
    const originY = position.top;
    drag.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const left = Math.max(0, Math.min(window.innerWidth - shell.offsetWidth, originX + moveEvent.clientX - startX));
      const top = Math.max(0, Math.min(window.innerHeight - 40, originY + moveEvent.clientY - startY));
      position = { ...position!, left, top };
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.style.right = "auto";
    };
    const up = () => {
      drag.removeEventListener("pointermove", move);
      drag.removeEventListener("pointerup", up);
      void chrome.storage.local.set({ [positionKey]: position }).catch((error: unknown) => {
        showError(error instanceof Error ? error.message : "Could not save the control-bar position.");
      });
    };
    drag.addEventListener("pointermove", move);
    drag.addEventListener("pointerup", up, { once: true });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.activeSearchRun) {
      run = changes.activeSearchRun.newValue as SearchRunState | null;
      if (run && ["running", "paused", "awaiting_filters", "country_completed"].includes(run.status)) {
        preferredCountryCode = run.countryCode;
        preferredQueryId = String(run.queryId);
        countrySelect.value = preferredCountryCode;
        renderRecords();
      } else {
        render();
      }
    }
    if (changes.selectedCountryCode && typeof changes.selectedCountryCode.newValue === "string") {
      preferredCountryCode = changes.selectedCountryCode.newValue;
      renderQueries();
    }
    if (changes.selectedQueryId && typeof changes.selectedQueryId.newValue === "number") {
      preferredQueryId = String(changes.selectedQueryId.newValue);
      renderRecords();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "RUN_STATE") {
      run = message.run as SearchRunState;
      if (run && ["running", "paused", "awaiting_filters", "country_completed"].includes(run.status)) {
        preferredCountryCode = run.countryCode;
        preferredQueryId = String(run.queryId);
        countrySelect.value = preferredCountryCode;
        renderRecords();
      } else {
        render();
      }
    } else if (message?.type === "FILTER_PROFILE_UPDATED") {
      const profile = message.profile as CountryFilterProfile;
      countryFilters = [...countryFilters.filter((item) => item.country_code !== profile.country_code), profile];
      render();
    }
  });

  void chrome.storage.local.get([positionKey, "selectedQueryId", "selectedCountryCode"]).then((stored) => {
    const saved = stored[positionKey] as BarPosition | undefined;
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      position = saved;
      host.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, saved.left))}px`;
      host.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, saved.top))}px`;
      host.style.right = "auto";
      if (saved.collapsed) collapse.click();
    }
    if (typeof stored.selectedQueryId === "number") preferredQueryId = String(stored.selectedQueryId);
    if (typeof stored.selectedCountryCode === "string") preferredCountryCode = stored.selectedCountryCode;
    void refresh();
  }).catch((error: unknown) => showError(error instanceof Error ? error.message : "Could not load control-bar preferences."));
}
