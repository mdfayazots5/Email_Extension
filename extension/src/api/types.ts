export type QueryRecord = {
  id: number;
  country_code: string;
  label: string;
  query_text: string;
  position: number;
  enabled: number | boolean;
  notes: string;
  created_at: string;
  updated_at: string;
  date_posted?: string | null;
  sort_by?: string | null;
  content_type?: string | null;
  from_member?: string | null;
  other_note?: string | null;
};

export type QueryInput = Pick<
  QueryRecord,
  "country_code" | "label" | "query_text" | "position" | "enabled" | "notes"
>;

export type QueryFilters = {
  date_posted: string;
  sort_by: string;
  content_type: string;
  from_member: string;
  other_note: string;
};

export type DailySummary = {
  date: string;
  timezone: string;
  countries: Array<{ country_code: string; new: number; duplicates: number }>;
  queries_completed: number;
  posts_scanned: number;
  last_saved_at: string | null;
};

export type HistorySummary = {
  period: "day" | "week" | "month";
  date: string;
  start: string;
  end: string;
  countries: Array<{ country_code: string; new: number; duplicates: number }>;
};

export type DailyComparisonSummary = {
  date: string;
  collected: number;
  already_in_master: number;
  new: number;
  recomputed_at: string;
  emails: Array<{ original_email: string; country_code: string; city: string; post_url: string; ordinal: number }>;
};

export type MasterIssue = { row: number; reason: string };
export type MasterStatus = {
  current: null | {
    id: number;
    file_name: string;
    uploaded_at: string;
    rows_read: number;
    valid_emails: number;
    empty_cells: number;
    duplicate_emails: number;
    suspicious_count: number;
    email_count: number;
    suspicious_entries: MasterIssue[];
  };
  imports: Array<{
    id: number;
    file_name: string;
    uploaded_at: string;
    rows_read: number;
    valid_emails: number;
    empty_cells: number;
    duplicate_emails: number;
    suspicious_count: number;
  }>;
};

export type DailyHistory = {
  period: "day" | "week" | "month";
  date: string;
  start: string;
  end: string;
  days: Array<{ day: string; country_code: string; collected: number; already_in_master: number; new: number }>;
};

export type AppSettings = {
  starting_country: string | null;
  starting_query_id: number | null;
  timezone: string;
  data_retention_days: number | null;
  action_delay_min_ms: number;
  action_delay_max_ms: number;
  scan_delay_min_ms: number;
  scan_delay_max_ms: number;
  max_scrolls_per_query: number;
  max_posts_per_query: number;
  stop_after_no_new_posts: number;
  query_pause_min_ms: number;
  query_pause_max_ms: number;
  max_queries_per_run: number;
  max_posts_per_day: number;
  /** Searches (records) the extension may open per day in one Chrome profile; 0 = no limit. */
  max_searches_per_day: number;
  /** Hours Start stays blocked after LinkedIn shows a warning; 0 = no rest. */
  rest_hours_after_warning: number;
  query_retry_limit: number;
  ignore_generic_addresses: boolean;
  ignored_email_prefixes: string[];
  exclude_earlier_emails: boolean;
  /** Post must contain at least one of post_job_words. */
  post_require_job_words: boolean;
  post_job_words: string[];
  /** Post must also match the record's search query. */
  post_match_query: boolean;
  /** Optional extra rule every post must match. */
  post_rule_custom: string;
};

export type ScanCounters = {
  /** Posts with emails that did not match the post rule. */
  skippedByRule?: number;
  scrollCount: number;
  postsScanned: number;
  emailsFound: number;
  newEmails: number;
  duplicateEmails: number;
  ignoredEmails: number;
  queryStatus: "pending" | "scanning" | "completed";
};

export type SavedCapture = {
  email: string;
  post_url: string;
  seen_at: string;
};

export type CaptureBatchItem = {
  country_code: string;
  city: string;
  post_url: string;
  post_date: string | null;
  post_date_text: string;
  author_name: string;
  post_text: string;
  ignored_emails: number;
  emails: Array<{ email: string; original: string }>;
};

export type FilterResult = {
  key: "date_posted" | "sort_by" | "content_type" | "from_member";
  label: string;
  expected: string;
  status: "applied" | "not_applied" | "not_requested";
  message?: string;
};

export type CountryFilterProfile = {
  country_code: string;
  params: string;
  summary: string;
  captured_at: string;
  profile_id: string;
};

export type SearchRunState = {
  runId: number;
  queryId: number;
  queryText: string;
  continueNext: boolean;
  /** Keep going through every country (after the start record) with the same captured filters. */
  runAllCountries?: boolean;
  status: "running" | "paused" | "awaiting_filters" | "country_completed" | "stopped" | "error" | "query_completed" | "completed";
  stage: "opening" | "awaiting_filters" | "applying" | "ready" | "scanning" | "error" | "stopped" | "completed";
  statusText: string;
  tabId?: number;
  filters: QueryFilters;
  searchUrl: string;
  filterResults: FilterResult[];
  error?: string;
  delayMinMs: number;
  delayMaxMs: number;
  scanDelayMinMs: number;
  scanDelayMaxMs: number;
  maxScrolls: number;
  maxPosts: number;
  stopAfterNoNewPosts: number;
  ignoreGenericAddresses: boolean;
  ignoredEmailPrefixes: string[];
  postRequireJobWords?: boolean;
  postJobWords?: string[];
  postMatchQuery?: boolean;
  postRuleCustom?: string;
  counters: ScanCounters;
  recentCaptures: SavedCapture[];
  pendingSave?: boolean;
  processedPostIds: string[];
  countryCode: string;
  cityLabel: string;
  profileId: string;
  profileLabel: string;
  queryResults: Array<{ queryId: number; label: string; status: "completed" | "skipped" | "error"; error?: string }>;
  queriesAttempted: number;
  retryLimit: number;
  queryPauseMinMs: number;
  queryPauseMaxMs: number;
  maxQueriesPerRun: number;
  maxPostsPerDay: number;
  maxSearchesPerDay?: number;
  dailyPostsScanned: number;
  currentQueryRetries: number;
  waitingForNextQuery: boolean;
  debugFilters?: boolean;
  debugScan?: boolean;
  continueOnFilterFailure?: boolean;
  countryQueryIds?: number[];
  countryQueryIndex?: number;
  capturedFilterParams?: string;
  filterSummary?: string;
  filterFallback?: boolean;
  filtersConfigured?: boolean;
  filtersConfirmedForRecord?: boolean;
  currentRecordNumber?: number;
  experimentalAutomaticFilters?: boolean;
  nextCountryCode?: string;
  nextCountryRecords?: number;
};
