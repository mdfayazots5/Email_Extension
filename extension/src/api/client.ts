import type {
  AppSettings,
  CaptureBatchItem,
  CountryFilterProfile,
  DailyComparisonSummary,
  DailyHistory,
  DailySummary,
  HistorySummary,
  QueryFilters,
  QueryInput,
  QueryRecord,
  SavedCapture,
  MasterStatus,
  SearchRunState
} from "./types";
import { recordConnectionLog } from "./connection-logs";

const API_BASE = "http://127.0.0.1:4317";

export type ApiErrorKind = "offline" | "unauthorized" | "validation" | "http";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface TokenStore {
  get(): Promise<string>;
  /** Starts the service if needed and returns a fresh token. Optional for tests and manual tokens. */
  refresh?(): Promise<string>;
}

export const NATIVE_HOST_NAME = "com.jobposttracker.service";
export const HOST_NOT_INSTALLED_MESSAGE =
  "One-time setup needed: run native-host\\install.ps1 from the project folder, then restart Chrome.";

type EnsureResponse = { ok: true; token: string; started: boolean } | { ok: false; error: string };

let ensureInFlight: Promise<string> | null = null;

/**
 * Asks the native host to start the local service (if it is not already running)
 * and returns its token. Concurrent callers share one request.
 */
export function ensureService(): Promise<string> {
  ensureInFlight ??= (async () => {
    let response: EnsureResponse | undefined;
    try {
      response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "ensure" }) as EnsureResponse | undefined;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      await recordConnectionLog("native_host_failed", { error_message: text.slice(0, 200) });
      if (/not found|not registered|forbidden/i.test(text)) throw new ApiError(HOST_NOT_INSTALLED_MESSAGE, "offline");
      throw new ApiError(`Could not start the tracker service: ${text}`, "offline");
    }
    if (!response || !response.ok) {
      const text = response && !response.ok ? response.error : "No response from the native host.";
      await recordConnectionLog("native_host_failed", { error_message: text.slice(0, 200) });
      throw new ApiError(text, "offline");
    }
    await chrome.storage.local.set({ serviceToken: response.token });
    await recordConnectionLog("native_host_ready", { service_started: response.started });
    return response.token;
  })().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

export class ChromeTokenStore implements TokenStore {
  async get(): Promise<string> {
    const result = await chrome.storage.local.get("serviceToken");
    return typeof result.serviceToken === "string" ? result.serviceToken : "";
  }

  refresh(): Promise<string> {
    return ensureService();
  }
}

/** Token for code outside TrackerApi; starts the service through the native host when none is saved. */
export async function serviceToken(): Promise<string> {
  const saved = await new ChromeTokenStore().get();
  return saved || ensureService();
}

/** fetch() against the service with the saved token; starts the service and retries once if needed. */
export async function serviceFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const attempt = (token: string) => fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` }
  });
  try {
    const response = await attempt(await serviceToken());
    if (response.status !== 401) return response;
  } catch {
    // Service not running; start it below.
  }
  return attempt(await ensureService());
}

export class TrackerApi {
  constructor(
    private readonly tokenStore: TokenStore = new ChromeTokenStore(),
    private readonly fetcher: typeof fetch = fetch.bind(globalThis),
    private readonly baseUrl = API_BASE
  ) {}

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    let token = await this.tokenStore.get();
    if (!token && this.tokenStore.refresh) token = await this.tokenStore.refresh();
    try {
      return await this.send<T>(pathname, init, token);
    } catch (error: unknown) {
      // Service not running (Chrome restarted, PC rebooted) or token changed:
      // let the native host start it, then retry once.
      const recoverable = error instanceof ApiError && (error.kind === "offline" || error.kind === "unauthorized");
      if (!recoverable || !this.tokenStore.refresh) throw error;
      token = await this.tokenStore.refresh();
      return await this.send<T>(pathname, init, token);
    }
  }

  private async send<T>(pathname: string, init: RequestInit, token: string): Promise<T> {
    const isConnectionCheck = pathname === "/health";
    const startedAt = Date.now();
    if (isConnectionCheck) {
      await recordConnectionLog("request_started", {
        method: init.method ?? "GET",
        endpoint: pathname,
        token_present: Boolean(token)
      });
    }
    if (!token) {
      if (isConnectionCheck) await recordConnectionLog("request_failed", { reason: "token_missing" });
      throw new ApiError("The tracker service is not connected yet.", "unauthorized", 401);
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers
        }
      });
    } catch (error: unknown) {
      if (isConnectionCheck) {
        await recordConnectionLog("request_failed", {
          reason: "network_or_cors_error",
          error_name: error instanceof Error ? error.name : "UnknownError",
          error_message: error instanceof Error ? error.message.slice(0, 200) : "Unknown fetch error",
          duration_ms: Date.now() - startedAt
        });
      }
      throw new ApiError(
        "Could not reach the tracker service.",
        "offline"
      );
    }

    if (!response.ok) {
      if (isConnectionCheck) {
        await recordConnectionLog("request_failed", {
          reason: response.status === 401 ? "unauthorized" : "http_error",
          status: response.status,
          duration_ms: Date.now() - startedAt
        });
      }
      let body: { error?: string; details?: unknown } = {};
      try {
        body = await response.json() as typeof body;
      } catch {
        // Keep a useful status message when an intermediary returns non-JSON.
      }
      if (response.status === 401) {
        throw new ApiError("The tracker service rejected the saved token.", "unauthorized", 401);
      }
      if (response.status === 400) {
        throw new ApiError(body.error ?? "Some fields are invalid. Review the form and try again.", "validation", 400, body.details);
      }
      throw new ApiError(body.error ?? `Service request failed (${response.status}).`, "http", response.status, body.details);
    }
    if (isConnectionCheck) {
      await recordConnectionLog("request_succeeded", {
        status: response.status,
        duration_ms: Date.now() - startedAt
      });
    }
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("spreadsheetml")) return await response.blob() as T;
    if (contentType.includes("text/")) return await response.text() as T;
    return await response.json() as T;
  }

  health() {
    return this.request<{ status: string; database: string; timezone: string }>("/health");
  }

  masterStatus() {
    return this.request<MasterStatus>("/master/status");
  }

  uploadMaster(file: File) {
    return this.request<{
      file_name: string;
      uploaded_at: string;
      rows_read: number;
      valid_emails: number;
      empty_cells: number;
      duplicate_emails: number;
      suspicious_count: number;
      suspicious_entries: Array<{ row: number; reason: string }>;
    }>("/master/import", {
      method: "POST",
      body: file,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name)
      }
    });
  }

  daily(date: string) {
    return this.request<DailyComparisonSummary>(`/daily?date=${encodeURIComponent(date)}`);
  }

  recomputeDaily(date: string) {
    return this.request<DailyComparisonSummary>(`/daily/recompute?date=${encodeURIComponent(date)}`, { method: "POST" });
  }

  dailyHistory(period: "day" | "week" | "month", date: string, country?: string) {
    const params = new URLSearchParams({ period, date });
    if (country) params.set("country", country);
    return this.request<DailyHistory>(`/daily/history?${params.toString()}`);
  }

  uniqueWorkbook() {
    return this.request<Blob>("/export/unique-xlsx");
  }

  uniqueCsv(date: string, country?: string) {
    const params = new URLSearchParams({ date });
    if (country) params.set("country", country);
    return this.request<string>(`/export/unique-csv?${params}`);
  }

  queries() {
    return this.request<QueryRecord[]>("/queries");
  }

  countryFilters() {
    return this.request<CountryFilterProfile[]>("/country-filters");
  }

  saveCountryFilters(countryCode: string, input: { params: string; summary: string }) {
    return this.request<CountryFilterProfile>(`/country-filters/${encodeURIComponent(countryCode)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  createQuery(input: QueryInput) {
    return this.request<QueryRecord>("/queries", { method: "POST", body: JSON.stringify(input) });
  }

  updateQuery(id: number, input: Partial<QueryInput>) {
    return this.request<QueryRecord>(`/queries/${id}`, { method: "PUT", body: JSON.stringify(input) });
  }

  createRun(input: {
    current_query_id: number;
    continue_next: boolean;
    progress_json: Record<string, unknown>;
    profile_label: string;
    profile_id: string;
  }) {
    return this.request<{ id: number; status: string; current_query_id: number }>("/runs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  activeRun(profileId: string) {
    return this.request<{
      id: number;
      status: string;
      current_query_id: number | null;
      continue_next: number;
      progress_json: string;
      profile_label: string;
      profile_id: string;
    } | null>(`/runs/active?profile_id=${encodeURIComponent(profileId)}`);
  }

  acquireQueryLock(queryId: number, runId: number, profileId: string, profileLabel: string) {
    return this.request<{ locked: boolean; expires_at: string }>(`/queries/${queryId}/lock`, {
      method: "POST",
      body: JSON.stringify({ run_id: runId, profile_id: profileId, profile_label: profileLabel })
    });
  }

  releaseQueryLock(queryId: number, runId: number) {
    return this.request<void>(`/queries/${queryId}/lock?run_id=${runId}`, { method: "DELETE" });
  }

  getRun(id: number) {
    return this.request<{
      id: number;
      status: string;
      current_query_id: number | null;
      continue_next: number;
      progress_json: string;
      profile_label: string;
    }>(`/runs/${id}`);
  }

  recentCaptures(runId: number) {
    return this.request<SavedCapture[]>(`/runs/${runId}/recent-captures`);
  }

  saveBatch(input: {
    batch_id: string;
    run_id: number;
    query_id: number;
    captures: CaptureBatchItem[];
  }) {
    return this.request<{ new: number; duplicates: number; ignored: number; captures_saved: number }>("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  updateRun(id: number, input: {
    ended_at?: string | null;
    status?: "running" | "paused" | "awaiting_filters" | "country_completed" | "stopped" | "completed" | "query_completed" | "blocked" | "error";
    current_query_id?: number | null;
    continue_next?: boolean;
    progress_json?: Record<string, unknown>;
    profile_label?: string;
  }) {
    return this.request(`/runs/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  deleteQuery(id: number) {
    return this.request<void>(`/queries/${id}`, { method: "DELETE" });
  }

  saveFilters(id: number, filters: QueryFilters) {
    return this.request<QueryFilters>(`/queries/${id}/filters`, {
      method: "PUT",
      body: JSON.stringify(filters)
    });
  }

  today() {
    return this.request<DailySummary>("/summary/today");
  }

  history(period: "day" | "week" | "month", date: string, country?: string) {
    const params = new URLSearchParams({ period, date });
    if (country) params.set("country", country);
    return this.request<HistorySummary>(`/summary/history?${params}`);
  }

  export(
    format: "csv" | "tsv",
    date: string,
    period: "day" | "week" | "month" = "day",
    country?: string
  ) {
    const params = new URLSearchParams({ date, period });
    if (country) params.set("country", country);
    return this.request<string>(`/export/${format}?${params}`);
  }

  settings() {
    return this.request<AppSettings>("/settings");
  }

  saveSettings(settings: Partial<AppSettings>) {
    return this.request<AppSettings>("/settings", { method: "PUT", body: JSON.stringify(settings) });
  }

  backup() {
    return this.request<{ backup: string }>("/backup", { method: "POST" });
  }
}

export const api = new TrackerApi();

export const RUN_STORAGE_KEY = "activeSearchRun";

export async function readSavedRun(): Promise<SearchRunState | null> {
  const result = await chrome.storage.local.get(RUN_STORAGE_KEY);
  return (result[RUN_STORAGE_KEY] as SearchRunState | undefined) ?? null;
}

export async function getProfileIdentity(): Promise<{ id: string; label: string }> {
  const stored = await chrome.storage.local.get(["profileId", "profileLabel"]);
  const id = typeof stored.profileId === "string" && stored.profileId
    ? stored.profileId
    : crypto.randomUUID();
  const label = typeof stored.profileLabel === "string" && stored.profileLabel.trim()
    ? stored.profileLabel.trim()
    : "Chrome profile";
  if (stored.profileId !== id) await chrome.storage.local.set({ profileId: id });
  return { id, label };
}
