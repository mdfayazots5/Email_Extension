import { z } from "zod";
import { dateSchema } from "./date-utils.js";

const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/);
export const queryInput = z.object({
  country_code: countryCode,
  label: z.string().trim().min(1).max(120),
  query_text: z.string().trim().min(1).max(2000),
  position: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  notes: z.string().max(4000).default("")
}).strict();

export const queryUpdate = queryInput.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided"
);

export const filtersInput = z.object({
  date_posted: z.string().trim().min(1).max(80),
  sort_by: z.string().trim().min(1).max(80),
  content_type: z.string().trim().min(1).max(80),
  from_member: z.string().max(500).default(""),
  other_note: z.string().max(2000).default("")
}).strict();

export const countryFilterInput = z.object({
  params: z.string().max(10000),
  summary: z.string().trim().min(1).max(500)
}).strict();

export const runInput = z.object({
  current_query_id: z.number().int().positive().nullable().default(null),
  continue_next: z.boolean().default(true),
  progress_json: z.record(z.string(), z.unknown()).default({}),
  profile_label: z.string().trim().max(120).default(""),
  profile_id: z.string().trim().min(1).max(120).default("default-profile")
}).strict();

export const runUpdate = z.object({
  ended_at: z.string().datetime().nullable().optional(),
  status: z.enum(["running", "paused", "awaiting_filters", "country_completed", "stopped", "completed", "query_completed", "blocked", "error"]).optional(),
  current_query_id: z.number().int().positive().nullable().optional(),
  continue_next: z.boolean().optional(),
  progress_json: z.record(z.string(), z.unknown()).optional(),
  profile_label: z.string().trim().max(120).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

const emailValue = z.string().max(320).refine(
  (value) => z.string().email().safeParse(value.trim()).success,
  "Expected a valid email address"
);

const capturePostUrl = z.string().max(2048).refine((value) => {
  if (value === "") return true;
  try {
    const parsed = new URL(value);
    return parsed.hostname === "www.linkedin.com";
  } catch {
    return false;
  }
}, "Expected an empty value or a valid LinkedIn post URL");

const emailCapture = z.object({
  country_code: countryCode,
  city: z.string().trim().max(200).default(""),
  post_url: capturePostUrl,
  post_date: dateSchema.nullable().default(null),
  post_date_text: z.string().max(120).default(""),
  author_name: z.string().trim().max(300).default(""),
  post_text: z.string().max(20_000).default(""),
  ignored_emails: z.number().int().min(0).max(100).default(0),
  emails: z.array(z.object({
    email: emailValue,
    original: z.string().trim().min(1).max(320)
  }).strict()).max(100)
}).strict();

const legacyEmailBatchInput = z.object({
  run_id: z.number().int().positive(),
  query_id: z.number().int().positive(),
  country_code: countryCode,
  city: z.string().trim().max(200).default(""),
  post_url: z.string().url().max(2048),
  post_date: dateSchema.nullable().default(null),
  source: z.string().trim().min(1).max(80).default("linkedin_post"),
  review_status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  emails: z.array(emailValue).min(1).max(500)
}).strict();

const captureEmailBatchInput = z.object({
  batch_id: z.string().uuid(),
  run_id: z.number().int().positive(),
  query_id: z.number().int().positive(),
  source: z.string().trim().min(1).max(80).default("linkedin_post"),
  review_status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  captures: z.array(emailCapture).min(1).max(10)
}).strict();

export const emailBatchInput = z.union([captureEmailBatchInput, legacyEmailBatchInput]);

export const summaryQuery = z.object({
  period: z.enum(["day", "week", "month"]),
  date: dateSchema,
  country: countryCode.optional()
}).strict();

export const exportQuery = z.object({
  date: dateSchema,
  period: z.enum(["day", "week", "month"]).optional(),
  country: countryCode.optional()
}).strict();

export const settingsUpdate = z.object({
  starting_country: countryCode.nullable().optional(),
  starting_query_id: z.number().int().positive().nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  data_retention_days: z.number().int().min(0).max(36500).nullable().optional(),
  action_delay_min_ms: z.number().int().min(0).max(60000).optional(),
  action_delay_max_ms: z.number().int().min(0).max(60000).optional(),
  scan_delay_min_ms: z.number().int().min(0).max(120000).optional(),
  scan_delay_max_ms: z.number().int().min(0).max(120000).optional(),
  max_scrolls_per_query: z.number().int().min(1).max(50).optional(),
  max_posts_per_query: z.number().int().min(1).max(10000).optional(),
  stop_after_no_new_posts: z.number().int().min(1).max(100).optional(),
  query_pause_min_ms: z.number().int().min(0).max(600000).optional(),
  query_pause_max_ms: z.number().int().min(0).max(600000).optional(),
  max_queries_per_run: z.number().int().min(1).max(500).optional(),
  max_posts_per_day: z.number().int().min(1).max(10000).optional(),
  max_searches_per_day: z.number().int().min(0).max(500).optional(),
  rest_hours_after_warning: z.number().int().min(0).max(168).optional(),
  query_retry_limit: z.number().int().min(0).max(10).optional(),
  ignore_generic_addresses: z.boolean().optional(),
  ignored_email_prefixes: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  exclude_earlier_emails: z.boolean().optional(),
  post_require_job_words: z.boolean().optional(),
  post_job_words: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  post_match_query: z.boolean().optional(),
  post_rule_custom: z.string().max(2000).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one setting must be provided");

export const queryLockInput = z.object({
  run_id: z.number().int().positive(),
  profile_id: z.string().trim().min(1).max(120),
  profile_label: z.string().trim().max(120).default("")
}).strict();
