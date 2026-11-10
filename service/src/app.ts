import { mkdir, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { csvCell, tsvCell } from "./csv.js";
import { dateSchema, localDate, periodRange } from "./date-utils.js";
import { tokenMatches } from "./token.js";
import { buildDailyWorkbookFromDb, dailyCsv, recomputeDailyComparison, writeDailyComparison } from "./daily-comparison.js";
import { importMasterFile, masterStatus } from "./master-import.js";
import { normalizeForComparison } from "../../shared/email-normalization.ts";
import { DEFAULT_JOB_WORDS } from "../../shared/post-defaults.ts";
import { countryFilePart, countryName } from "../../shared/country-names.ts";
import {
  emailBatchInput,
  exportQuery,
  filtersInput,
  countryFilterInput,
  queryInput,
  queryUpdate,
  runInput,
  runUpdate,
  summaryQuery,
  settingsUpdate,
  queryLockInput
} from "./validation.js";

type AppOptions = {
  db: DatabaseSync;
  token: string;
  timezone: string;
  backupDirectory: string;
  masterDirectory?: string;
  exportDirectory?: string;
  extensionIds?: string[];
  now?: () => Date;
};

type EmailRow = {
  original_email: string;
  country_code: string;
  city: string;
  post_url: string;
  post_date: string | null;
  first_seen_at: string;
  first_seen_day: string;
};

function jsonError(response: Response, status: number, error: string, details?: unknown) {
  response.status(status).json({ error, ...(details === undefined ? {} : { details }) });
}

function requiredId(request: Request): number {
  const parsed = z.coerce.number().int().positive().safeParse(request.params.id);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

function requireQuery(db: DatabaseSync, id: number): void {
  if (!db.prepare("SELECT 1 FROM queries WHERE id = ?").get(id)) {
    throw Object.assign(new Error("Query not found"), { status: 404 });
  }
}

function requireRun(db: DatabaseSync, id: number): void {
  if (!db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id)) {
    throw Object.assign(new Error("Run not found"), { status: 404 });
  }
}

function emailRows(db: DatabaseSync, day: string, country?: string): EmailRow[] {
  const countryClause = country ? " AND country_code = ?" : "";
  return db.prepare(`
    SELECT original_email, country_code, city, post_url, post_date, first_seen_at, first_seen_day
    FROM emails WHERE first_seen_day = ?${countryClause} ORDER BY first_seen_at, id
  `).all(...(country ? [day, country] : [day])) as unknown as EmailRow[];
}

function rangedEmailRows(db: DatabaseSync, start: string, end: string, country?: string): EmailRow[] {
  const countryClause = country ? " AND country_code = ?" : "";
  return db.prepare(`
    SELECT original_email, country_code, city, post_url, post_date, first_seen_at, first_seen_day
    FROM emails WHERE first_seen_day >= ? AND first_seen_day < ?${countryClause}
    ORDER BY first_seen_day, first_seen_at, id
  `).all(...(country ? [start, end, country] : [start, end])) as unknown as EmailRow[];
}

function readAppSettings(db: DatabaseSync, timezone: string) {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const values = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  return {
    starting_country: values.starting_country || null,
    starting_query_id: values.starting_query_id ? Number(values.starting_query_id) : null,
    timezone: values.timezone || timezone,
    data_retention_days: values.data_retention_days === undefined || values.data_retention_days === ""
      ? null
      : Number(values.data_retention_days),
    action_delay_min_ms: Number(values.action_delay_min_ms ?? 1500),
    action_delay_max_ms: Number(values.action_delay_max_ms ?? 3000),
    scan_delay_min_ms: Number(values.scan_delay_min_ms ?? 6000),
    scan_delay_max_ms: Number(values.scan_delay_max_ms ?? 12_000),
    max_scrolls_per_query: Number(values.max_scrolls_per_query ?? 15),
    max_posts_per_query: Number(values.max_posts_per_query ?? 150),
    stop_after_no_new_posts: Number(values.stop_after_no_new_posts ?? 3),
    query_pause_min_ms: Number(values.query_pause_min_ms ?? 120_000),
    query_pause_max_ms: Number(values.query_pause_max_ms ?? 300_000),
    max_queries_per_run: Number(values.max_queries_per_run ?? 5),
    max_posts_per_day: Number(values.max_posts_per_day ?? 600),
    max_searches_per_day: Number(values.max_searches_per_day ?? 25),
    rest_hours_after_warning: Number(values.rest_hours_after_warning ?? 24),
    query_retry_limit: Number(values.query_retry_limit ?? 2),
    ignore_generic_addresses: values.ignore_generic_addresses !== "0",
    ignored_email_prefixes: values.ignored_email_prefixes
      ? JSON.parse(values.ignored_email_prefixes) as string[]
      : ["noreply", "no-reply", "donotreply"],
    exclude_earlier_emails: values.exclude_earlier_emails === "1",
    post_require_job_words: values.post_require_job_words !== "0",
    post_job_words: values.post_job_words ? JSON.parse(values.post_job_words) as string[] : [...DEFAULT_JOB_WORDS],
    post_match_query: values.post_match_query === "1",
    post_rule_custom: values.post_rule_custom ?? ""
  };
}

async function createBackup(db: DatabaseSync, backupDirectory: string): Promise<string> {
  await mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `tracker-${stamp}-${randomUUID().slice(0, 8)}.db`);
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  const backups = (await readdir(backupDirectory))
    .filter((name) => /^tracker-.*\.db$/.test(name))
    .sort()
    .reverse();
  for (const obsolete of backups.slice(14)) {
    await unlink(path.join(backupDirectory, obsolete));
  }
  return backupPath;
}

const SERVICE_STARTED_AT = new Date().toISOString();

export function createApp(options: AppOptions) {
  const { db } = options;
  const app = express();
  const workbookPath = path.join(options.exportDirectory ?? path.resolve(options.backupDirectory, "..", "exports"), "Unique-Emails.xlsx");
  const masterDirectory = options.masterDirectory ?? path.resolve(options.backupDirectory, "..", "master");
  const recomputeDay = async (day: string) => {
    const settings = readAppSettings(db, options.timezone);
    const comparison = recomputeDailyComparison(db, day, options.now?.() ?? new Date(), settings.exclude_earlier_emails);
    const masterRows = db.prepare("SELECT normalized_email FROM master_emails").all() as Array<{ normalized_email: string }>;
    await writeDailyComparison(workbookPath, comparison, new Set(masterRows.map((row) => row.normalized_email)));
    return comparison;
  };
  const dailySummary = (day: string) => {
    const result = db.prepare("SELECT * FROM daily_comparisons WHERE day = ?").get(day) as {
      collected_count: number; in_master_count: number; new_count: number; recomputed_at: string;
    } | undefined;
    if (!result) throw new Error(`Daily comparison was not saved for ${day}.`);
    const emails = db.prepare(`
      SELECT original_email, country_code, city, post_url, ordinal
      FROM daily_comparison_emails WHERE day = ? AND is_new = 1
      ORDER BY ordinal
    `).all(day);
    return {
      date: day,
      collected: Number(result.collected_count),
      already_in_master: Number(result.in_master_count),
      new: Number(result.new_count),
      recomputed_at: result.recomputed_at,
      emails
    };
  };
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const origin = request.header("origin");
    const isLocalOrigin = origin === "http://localhost" || /^http:\/\/localhost:\d+$/.test(origin ?? "");
    const isAllowedExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "")
      && (options.extensionIds ?? []).includes((origin ?? "").slice("chrome-extension://".length));

    if (origin && !isLocalOrigin && !isAllowedExtension) {
      jsonError(response, 403, "Origin is not allowed");
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use((request, response, next) => {
    const authorization = request.header("authorization") ?? "";
    const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokenMatches(candidate, options.token)) {
      jsonError(response, 401, "Missing or invalid service token");
      return;
    }
    next();
  });

  app.get("/health", (_request, response) => {
    const timezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
    // pid and started_at let the native host restart an outdated service after a code update.
    response.json({ status: "ok", database: "connected", timezone, pid: process.pid, started_at: SERVICE_STARTED_AT });
  });

  app.post("/master/import", express.raw({ type: "application/octet-stream", limit: "30mb" }), async (request, response) => {
    if (!Buffer.isBuffer(request.body)) {
      jsonError(response, 400, "Upload the master file as application/octet-stream.");
      return;
    }
    let fileName = request.header("x-file-name") ?? "";
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      jsonError(response, 400, "The uploaded filename is malformed.");
      return;
    }
    const result = await importMasterFile(db, request.body, fileName, masterDirectory, options.now?.() ?? new Date());
    const timezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
    await recomputeDay(localDate(options.now?.() ?? new Date(), timezone));
    response.status(201).json(result);
  });

  app.get("/master/status", (_request, response) => {
    response.json(masterStatus(db));
  });

  app.post("/daily/recompute", async (request, response) => {
    const day = dateSchema.parse(request.query.date);
    await recomputeDay(day);
    response.json(dailySummary(day));
  });

  app.get("/daily", async (request, response) => {
    const day = dateSchema.parse(request.query.date);
    const summary = db.prepare("SELECT * FROM daily_comparisons WHERE day = ?").get(day) as {
      collected_count: number;
    } | undefined;
    if (!summary) {
      await recomputeDay(day);
    }
    response.json(dailySummary(day));
  });

  app.get("/daily/history", async (request, response) => {
    const params = z.object({
      period: z.enum(["day", "week", "month"]),
      date: dateSchema,
      country: z.string().trim().length(2).optional()
    }).strict().parse(request.query);
    const range = periodRange(params.period, params.date);
    const missingDays = db.prepare(`
      SELECT DISTINCT c.local_day AS day FROM captures c
      LEFT JOIN daily_comparisons d ON d.day = c.local_day
      WHERE c.local_day >= ? AND c.local_day < ? AND d.day IS NULL
      ORDER BY c.local_day
    `).all(range.start, range.end) as Array<{ day: string }>;
    for (const item of missingDays) await recomputeDay(item.day);
    const countryClause = params.country ? " AND country_code = ?" : "";
    const rows = db.prepare(`
      SELECT day, country_code,
        COUNT(*) AS collected,
        SUM(in_master) AS already_in_master,
        SUM(is_new) AS new
      FROM daily_comparison_emails
      WHERE day >= ? AND day < ?${countryClause}
      GROUP BY day, country_code
      ORDER BY day, country_code
    `).all(...(params.country ? [range.start, range.end, params.country] : [range.start, range.end])) as Array<{
      day: string; country_code: string; collected: number; already_in_master: number; new: number;
    }>;
    response.json({
      period: params.period,
      date: params.date,
      start: range.start,
      end: range.end,
      days: rows
    });
  });

  app.get("/export/unique-xlsx", async (_request, response) => {
    if (!db.prepare("SELECT 1 FROM daily_comparison_emails LIMIT 1").get()) {
      jsonError(response, 404, "The daily workbook has not been created yet.");
      return;
    }
    const workbook = await buildDailyWorkbookFromDb(db);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", 'attachment; filename="Unique-Emails.xlsx"');
    response.send(workbook);
  });

  app.get("/export/unique-csv", (request, response) => {
    const day = dateSchema.parse(request.query.date);
    const country = request.query.country === undefined || request.query.country === ""
      ? undefined
      : z.string().trim().regex(/^[A-Za-z]{2}$/).parse(request.query.country).toUpperCase();
    const rows = db.prepare(`
      SELECT original_email, country_code, city FROM daily_comparison_emails
      WHERE day = ? AND is_new = 1${country ? " AND country_code = ?" : ""} ORDER BY ordinal
    `).all(...(country ? [day, country] : [day])) as Array<{ original_email: string; country_code: string; city: string }>;
    const countries = country ? [country] : rows.map((row) => row.country_code);
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="Unique-Emails-${day}-${countryFilePart(countries)}.csv"`);
    response.send(dailyCsv(rows));
  });

  app.get("/settings", (_request, response) => {
    response.json(readAppSettings(db, options.timezone));
  });

  app.put("/settings", (request, response) => {
    const input = settingsUpdate.parse(request.body);
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: input.timezone });
      } catch {
        jsonError(response, 400, "Invalid timezone", [{ path: ["timezone"], message: "Use a valid IANA timezone" }]);
        return;
      }
    }
    if (input.starting_query_id !== undefined && input.starting_query_id !== null) {
      requireQuery(db, input.starting_query_id);
    }
    const values: Array<[string, string]> = [];
    if (input.starting_country !== undefined) values.push(["starting_country", input.starting_country ?? ""]);
    if (input.starting_query_id !== undefined) values.push(["starting_query_id", input.starting_query_id?.toString() ?? ""]);
    if (input.timezone !== undefined) values.push(["timezone", input.timezone]);
    if (input.data_retention_days !== undefined) values.push(["data_retention_days", input.data_retention_days?.toString() ?? ""]);
    if (input.action_delay_min_ms !== undefined) values.push(["action_delay_min_ms", input.action_delay_min_ms.toString()]);
    if (input.action_delay_max_ms !== undefined) values.push(["action_delay_max_ms", input.action_delay_max_ms.toString()]);
    if (input.scan_delay_min_ms !== undefined) values.push(["scan_delay_min_ms", input.scan_delay_min_ms.toString()]);
    if (input.scan_delay_max_ms !== undefined) values.push(["scan_delay_max_ms", input.scan_delay_max_ms.toString()]);
    if (input.max_scrolls_per_query !== undefined) values.push(["max_scrolls_per_query", input.max_scrolls_per_query.toString()]);
    if (input.max_posts_per_query !== undefined) values.push(["max_posts_per_query", input.max_posts_per_query.toString()]);
    if (input.stop_after_no_new_posts !== undefined) values.push(["stop_after_no_new_posts", input.stop_after_no_new_posts.toString()]);
    if (input.query_pause_min_ms !== undefined) values.push(["query_pause_min_ms", input.query_pause_min_ms.toString()]);
    if (input.query_pause_max_ms !== undefined) values.push(["query_pause_max_ms", input.query_pause_max_ms.toString()]);
    if (input.max_queries_per_run !== undefined) values.push(["max_queries_per_run", input.max_queries_per_run.toString()]);
    if (input.max_posts_per_day !== undefined) values.push(["max_posts_per_day", input.max_posts_per_day.toString()]);
    if (input.max_searches_per_day !== undefined) values.push(["max_searches_per_day", input.max_searches_per_day.toString()]);
    if (input.rest_hours_after_warning !== undefined) values.push(["rest_hours_after_warning", input.rest_hours_after_warning.toString()]);
    if (input.query_retry_limit !== undefined) values.push(["query_retry_limit", input.query_retry_limit.toString()]);
    if (input.ignore_generic_addresses !== undefined) values.push(["ignore_generic_addresses", input.ignore_generic_addresses ? "1" : "0"]);
    if (input.exclude_earlier_emails !== undefined) values.push(["exclude_earlier_emails", input.exclude_earlier_emails ? "1" : "0"]);
    if (input.post_require_job_words !== undefined) values.push(["post_require_job_words", input.post_require_job_words ? "1" : "0"]);
    if (input.post_job_words !== undefined) values.push(["post_job_words", JSON.stringify([...new Set(input.post_job_words.map((word) => word.trim()).filter(Boolean))])]);
    if (input.post_match_query !== undefined) values.push(["post_match_query", input.post_match_query ? "1" : "0"]);
    if (input.post_rule_custom !== undefined) values.push(["post_rule_custom", input.post_rule_custom]);
    if (input.ignored_email_prefixes !== undefined) {
      const prefixes = [...new Set(input.ignored_email_prefixes.map((prefix) => prefix.trim().toLowerCase()))];
      values.push(["ignored_email_prefixes", JSON.stringify(prefixes)]);
    }
    const delayMin = input.action_delay_min_ms
      ?? Number((db.prepare("SELECT value FROM settings WHERE key = 'action_delay_min_ms'").get() as { value: string } | undefined)?.value ?? 1500);
    const delayMax = input.action_delay_max_ms
      ?? Number((db.prepare("SELECT value FROM settings WHERE key = 'action_delay_max_ms'").get() as { value: string } | undefined)?.value ?? 3000);
    if (delayMin > delayMax) {
      jsonError(response, 400, "Invalid action delay", [{ path: ["action_delay_max_ms"], message: "Maximum delay must be at least the minimum delay" }]);
      return;
    }
    const currentScanMin = Number((db.prepare("SELECT value FROM settings WHERE key = 'scan_delay_min_ms'").get() as { value: string } | undefined)?.value ?? 6000);
    const currentScanMax = Number((db.prepare("SELECT value FROM settings WHERE key = 'scan_delay_max_ms'").get() as { value: string } | undefined)?.value ?? 12_000);
    const scanDelayMin = input.scan_delay_min_ms ?? currentScanMin;
    const scanDelayMax = input.scan_delay_max_ms ?? currentScanMax;
    if (scanDelayMin > scanDelayMax) {
      jsonError(response, 400, "Invalid scan delay", [{ path: ["scan_delay_max_ms"], message: "Maximum scan delay must be at least the minimum delay" }]);
      return;
    }
    const queryPauseMin = input.query_pause_min_ms
      ?? Number((db.prepare("SELECT value FROM settings WHERE key = 'query_pause_min_ms'").get() as { value: string } | undefined)?.value ?? 120_000);
    const queryPauseMax = input.query_pause_max_ms
      ?? Number((db.prepare("SELECT value FROM settings WHERE key = 'query_pause_max_ms'").get() as { value: string } | undefined)?.value ?? 300_000);
    if (queryPauseMin > queryPauseMax) {
      jsonError(response, 400, "Invalid query pause", [{ path: ["query_pause_max_ms"], message: "Maximum pause must be at least the minimum pause" }]);
      return;
    }
    const upsert = db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of values) upsert.run(key, value);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    response.json(readAppSettings(db, options.timezone));
  });

  app.get("/queries", (_request, response) => {
    response.json(db.prepare(`
      SELECT q.*, f.date_posted, f.sort_by, f.content_type, f.from_member, f.other_note
      FROM queries q LEFT JOIN query_filters f ON f.query_id = q.id
      ORDER BY q.position, q.id
    `).all());
  });

  app.post("/queries", (request, response) => {
    const input = parseBody(queryInput, request.body);
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO queries(country_code, label, query_text, position, enabled, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.country_code, input.label, input.query_text, input.position, Number(input.enabled), input.notes, now, now);
    response.status(201).json(db.prepare("SELECT * FROM queries WHERE id = ?").get(Number(result.lastInsertRowid)));
  });

  app.get("/queries/:id", (request, response) => {
    const query = db.prepare(`
      SELECT q.*, f.date_posted, f.sort_by, f.content_type, f.from_member, f.other_note
      FROM queries q LEFT JOIN query_filters f ON f.query_id = q.id WHERE q.id = ?
    `).get(requiredId(request));
    if (!query) {
      jsonError(response, 404, "Query not found");
      return;
    }
    response.json(query);
  });

  app.put("/queries/:id", (request, response) => {
    const id = requiredId(request);
    const patch = parseBody(queryUpdate, request.body);
    requireQuery(db, id);
    const columns: Record<string, string> = {
      country_code: "country_code",
      label: "label",
      query_text: "query_text",
      position: "position",
      enabled: "enabled",
      notes: "notes"
    };
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    if (patch.country_code !== undefined) {
      assignments.push(`${columns.country_code} = ?`);
      values.push(patch.country_code);
    }
    if (patch.label !== undefined) {
      assignments.push(`${columns.label} = ?`);
      values.push(patch.label);
    }
    if (patch.query_text !== undefined) {
      assignments.push(`${columns.query_text} = ?`);
      values.push(patch.query_text);
    }
    if (patch.position !== undefined) {
      assignments.push(`${columns.position} = ?`);
      values.push(patch.position);
    }
    if (patch.enabled !== undefined) {
      assignments.push(`${columns.enabled} = ?`);
      values.push(Number(patch.enabled));
    }
    if (patch.notes !== undefined) {
      assignments.push(`${columns.notes} = ?`);
      values.push(patch.notes);
    }
    db.prepare(`UPDATE queries SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
    response.json(db.prepare("SELECT * FROM queries WHERE id = ?").get(id));
  });

  app.delete("/queries/:id", (request, response) => {
    const id = requiredId(request);
    requireQuery(db, id);
    if (db.prepare("SELECT 1 FROM captures WHERE query_id = ? LIMIT 1").get(id)) {
      jsonError(response, 409, "This query has saved captures and cannot be deleted.");
      return;
    }
    const result = db.prepare("DELETE FROM queries WHERE id = ?").run(id);
    if (result.changes === 0) {
      jsonError(response, 404, "Query not found");
      return;
    }
    db.prepare("UPDATE settings SET value = '' WHERE key = 'starting_query_id' AND value = ?")
      .run(String(id));
    response.status(204).end();
  });

  app.put("/queries/:id/filters", (request, response) => {
    const queryId = requiredId(request);
    const filters = parseBody(filtersInput, request.body);
    requireQuery(db, queryId);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO query_filters(query_id, date_posted, sort_by, content_type, from_member, other_note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(query_id) DO UPDATE SET date_posted = excluded.date_posted,
        sort_by = excluded.sort_by, content_type = excluded.content_type,
        from_member = excluded.from_member, other_note = excluded.other_note,
        updated_at = excluded.updated_at
    `).run(queryId, filters.date_posted, filters.sort_by, filters.content_type, filters.from_member, filters.other_note, now);
    response.json(db.prepare("SELECT * FROM query_filters WHERE query_id = ?").get(queryId));
  });

  app.get("/country-filters", (_request, response) => {
    response.json(db.prepare("SELECT country_code, params, summary, captured_at, profile_id FROM country_filters ORDER BY country_code").all());
  });

  app.get("/country-filters/:country", (request, response) => {
    const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/).parse(request.params.country);
    response.json(db.prepare("SELECT country_code, params, summary, captured_at, profile_id FROM country_filters WHERE country_code = ?").get(country) ?? null);
  });

  app.put("/country-filters/:country", (request, response) => {
    const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/).parse(request.params.country);
    const input = parseBody(countryFilterInput, request.body);
    const capturedAt = (options.now?.() ?? new Date()).toISOString();
    db.prepare(`
      INSERT INTO country_filters(country_code, params, summary, captured_at, profile_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(country_code) DO UPDATE SET
        params = excluded.params, summary = excluded.summary, captured_at = excluded.captured_at
    `).run(country, input.params, input.summary, capturedAt, randomUUID());
    response.json(db.prepare("SELECT country_code, params, summary, captured_at, profile_id FROM country_filters WHERE country_code = ?").get(country));
  });

  app.post("/runs", async (request, response, next) => {
    const input = parseBody(runInput, request.body ?? {});
    if (input.current_query_id !== null) requireQuery(db, input.current_query_id);
    const startedAt = (options.now?.() ?? new Date()).toISOString();
    const serviceTimezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
    const serviceDay = localDate(options.now?.() ?? new Date(), serviceTimezone);
    const backupDay = db.prepare("SELECT value FROM settings WHERE key = 'automatic_backup_day'").get() as { value: string } | undefined;
    if (backupDay?.value !== serviceDay) {
      try {
        await createBackup(db, options.backupDirectory);
        db.prepare("INSERT INTO settings(key, value) VALUES ('automatic_backup_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(serviceDay);
      } catch (error) {
        next(error);
        return;
      }
    }
    let runId = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = db.prepare("SELECT id FROM runs WHERE status IN ('running', 'paused', 'awaiting_filters', 'country_completed') AND profile_id = ? LIMIT 1").get(input.profile_id);
      if (active) {
        throw Object.assign(new Error("This Chrome profile already has an active run. Resume or stop it before starting another."), { status: 409 });
      }
      const result = db.prepare(`
        INSERT INTO runs(started_at, status, current_query_id, continue_next, progress_json, profile_label, profile_id)
        VALUES (?, 'running', ?, ?, ?, ?, ?)
      `).run(startedAt, input.current_query_id, Number(input.continue_next), JSON.stringify(input.progress_json), input.profile_label, input.profile_id);
      runId = Number(result.lastInsertRowid);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    response.status(201).json(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId));
  });

  app.get("/runs/active", (request, response) => {
    const profileId = z.string().trim().min(1).max(120).parse(request.query.profile_id);
    const row = db.prepare(`
      SELECT * FROM runs WHERE profile_id = ? AND status IN ('running', 'paused', 'awaiting_filters', 'country_completed')
      ORDER BY started_at DESC LIMIT 1
    `).get(profileId);
    response.json(row ?? null);
  });

  app.get("/runs/:id", (request, response) => {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(requiredId(request));
    if (!run) {
      jsonError(response, 404, "Run not found");
      return;
    }
    response.json(run);
  });

  app.post("/queries/:id/lock", (request, response) => {
    const queryId = requiredId(request);
    const input = parseBody(queryLockInput, request.body);
    requireQuery(db, queryId);
    requireRun(db, input.run_id);
    const query = db.prepare("SELECT enabled FROM queries WHERE id = ?").get(queryId) as { enabled: number };
    if (!query.enabled) {
      jsonError(response, 409, "Query is disabled");
      return;
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM query_locks WHERE expires_at <= ?").run(nowIso);
      const locked = db.prepare("SELECT run_id, profile_id, profile_label, expires_at FROM query_locks WHERE query_id = ?")
        .get(queryId) as { run_id: number; profile_id: string; profile_label: string; expires_at: string } | undefined;
      if (locked && locked.run_id !== input.run_id) {
        db.exec("ROLLBACK");
        response.status(409).json({
          error: "Query is currently locked by another run",
          profile_label: locked.profile_label,
          locked_run_id: locked.run_id,
          locked_profile_id: locked.profile_id,
          expires_at: locked.expires_at
        });
        return;
      }
      db.prepare(`
        INSERT INTO query_locks(query_id, run_id, profile_id, profile_label, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(query_id) DO UPDATE SET run_id = excluded.run_id,
          profile_id = excluded.profile_id, profile_label = excluded.profile_label,
          acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      `).run(queryId, input.run_id, input.profile_id, input.profile_label, nowIso, expiresAt);
      db.exec("COMMIT");
      response.json({ locked: true, expires_at: expiresAt });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  app.delete("/queries/:id/lock", (request, response) => {
    const queryId = requiredId(request);
    const runId = z.coerce.number().int().positive().parse(request.query.run_id);
    db.prepare("DELETE FROM query_locks WHERE query_id = ? AND run_id = ?").run(queryId, runId);
    response.status(204).end();
  });

  app.get("/runs/:id/recent-captures", (request, response) => {
    const runId = requiredId(request);
    requireRun(db, runId);
    response.json(db.prepare(`
      SELECT e.original_email AS email, c.post_url, o.seen_at, c.author_name, c.post_date_text
      FROM email_occurrences o
      JOIN captures c ON c.id = o.capture_id
      JOIN emails e ON e.id = o.email_id
      WHERE c.run_id = ?
      ORDER BY o.seen_at DESC, o.id DESC
      LIMIT 30
    `).all(runId));
  });

  app.patch("/runs/:id", async (request, response) => {
    const id = requiredId(request);
    const patch = parseBody(runUpdate, request.body);
    requireRun(db, id);
    if (patch.current_query_id !== undefined && patch.current_query_id !== null) {
      requireQuery(db, patch.current_query_id);
    }
    const columns: Record<string, string> = {
      ended_at: "ended_at",
      status: "status",
      current_query_id: "current_query_id",
      continue_next: "continue_next",
      progress_json: "progress_json",
      profile_label: "profile_label"
    };
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.ended_at !== undefined) {
      assignments.push(`${columns.ended_at} = ?`);
      values.push(patch.ended_at);
    }
    if (patch.status !== undefined) {
      assignments.push(`${columns.status} = ?`);
      values.push(patch.status);
    }
    if (patch.current_query_id !== undefined) {
      assignments.push(`${columns.current_query_id} = ?`);
      values.push(patch.current_query_id);
    }
    if (patch.continue_next !== undefined) {
      assignments.push(`${columns.continue_next} = ?`);
      values.push(Number(patch.continue_next));
    }
    if (patch.progress_json !== undefined) {
      assignments.push(`${columns.progress_json} = ?`);
      values.push(JSON.stringify(patch.progress_json));
    }
    if (patch.profile_label !== undefined) {
      assignments.push(`${columns.profile_label} = ?`);
      values.push(patch.profile_label);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
      const currentRun = db.prepare("SELECT current_query_id FROM runs WHERE id = ?").get(id) as { current_query_id: number | null };
      const queryId = patch.current_query_id ?? currentRun.current_query_id;
      const progress = patch.progress_json as Record<string, unknown> | undefined;
      const counters = progress?.counters as { postsScanned?: unknown } | undefined;
      if (queryId && typeof counters?.postsScanned === "number") {
        const previous = db.prepare("SELECT last_posts_scanned, completed FROM run_query_usage WHERE run_id = ? AND query_id = ?")
          .get(id, queryId) as { last_posts_scanned: number; completed: number } | undefined;
        const scanned = Math.max(0, Math.floor(counters.postsScanned));
        const delta = Math.max(0, scanned - (previous?.last_posts_scanned ?? 0));
        const completedNow = progress?.queryStatus === "completed" || progress?.stage === "completed";
        const completedDelta = completedNow && !previous?.completed ? 1 : 0;
        const dbTimezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
        const localDay = localDate(options.now?.() ?? new Date(), dbTimezone);
        db.prepare(`
          INSERT INTO run_query_usage(run_id, query_id, last_posts_scanned, completed)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(run_id, query_id) DO UPDATE SET
            last_posts_scanned = MAX(last_posts_scanned, excluded.last_posts_scanned),
            completed = MAX(completed, excluded.completed)
        `).run(id, queryId, scanned, Number(Boolean(previous?.completed) || completedNow));
        if (delta || completedDelta) {
          db.prepare(`
            INSERT INTO daily_run_stats(local_day, queries_completed, posts_scanned, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(local_day) DO UPDATE SET
              queries_completed = queries_completed + excluded.queries_completed,
              posts_scanned = posts_scanned + excluded.posts_scanned,
              updated_at = excluded.updated_at
          `).run(localDay, completedDelta, delta, new Date().toISOString());
        }
      }
      if (patch.status && ["completed", "query_completed", "country_completed", "stopped", "error", "blocked"].includes(patch.status)) {
        db.prepare("DELETE FROM query_locks WHERE run_id = ?").run(id);
      } else {
        db.prepare("UPDATE query_locks SET expires_at = ? WHERE run_id = ?")
          .run(new Date(Date.now() + 10 * 60_000).toISOString(), id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (patch.status && ["completed", "stopped", "error", "blocked"].includes(patch.status)) {
      const affectedDays = db.prepare("SELECT DISTINCT local_day FROM captures WHERE run_id = ? ORDER BY local_day")
        .all(id) as Array<{ local_day: string }>;
      if (affectedDays.length) {
        for (const row of affectedDays) await recomputeDay(row.local_day);
      } else {
        const timezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
        await recomputeDay(localDate(options.now?.() ?? new Date(), timezone));
      }
    }
    response.json(db.prepare("SELECT * FROM runs WHERE id = ?").get(id));
  });

  app.post("/emails/save-batch", (request, response) => {
    const input = parseBody(emailBatchInput, request.body);
    requireRun(db, input.run_id);
    requireQuery(db, input.query_id);
    const captures = "captures" in input
      ? input.captures
      : [{
        country_code: input.country_code,
        city: input.city,
        post_url: input.post_url,
        post_date: input.post_date,
        post_date_text: "",
        author_name: "",
        post_text: "",
        ignored_emails: 0,
        emails: input.emails.map((email) => ({ email, original: email }))
      }];
    const source = input.source;
    const reviewStatus = input.review_status;
    const dbTimezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
    const now = options.now?.() ?? new Date();
    const timestamp = now.toISOString();
    const day = localDate(now, dbTimezone);
    let added = 0;
    let duplicates = 0;
    let ignored = 0;
    let capturesSaved = 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      if ("batch_id" in input) {
        const previous = db.prepare("SELECT result_json FROM email_save_batches WHERE batch_id = ?")
          .get(input.batch_id) as { result_json: string } | undefined;
        if (previous) {
          db.exec("COMMIT");
          response.status(200).json(JSON.parse(previous.result_json));
          return;
        }
      }
      db.prepare("INSERT INTO daily_sheets(day, created_at) VALUES (?, ?) ON CONFLICT(day) DO NOTHING").run(day, timestamp);
      const insertCapture = db.prepare(`
        INSERT INTO captures(run_id, query_id, country_code, city, post_url, post_date, captured_at, local_day, post_date_text, author_name, post_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEmail = db.prepare(`
        INSERT INTO emails(normalized_email, original_email, first_seen_at, first_seen_day, country_code, city, post_url, post_date, source, review_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(normalized_email) DO NOTHING
      `);
      const selectEmail = db.prepare("SELECT id FROM emails WHERE normalized_email = ?");
      const insertOccurrence = db.prepare(`
        INSERT INTO email_occurrences(email_id, capture_id, seen_at, local_day, is_duplicate, original_email)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const capture of captures) {
        ignored += capture.ignored_emails;
        const captureResult = insertCapture.run(
          input.run_id, input.query_id, capture.country_code, capture.city, capture.post_url,
          capture.post_date, timestamp, day, capture.post_date_text, capture.author_name, capture.post_text
        );
        const captureId = Number(captureResult.lastInsertRowid);
        capturesSaved++;
        for (const extracted of capture.emails) {
          const normalized = normalizeForComparison(extracted.email);
          const result = insertEmail.run(
            normalized, extracted.original, timestamp, day, capture.country_code, capture.city,
            capture.post_url, capture.post_date, source, reviewStatus
          );
          const isDuplicate = result.changes === 0;
          if (isDuplicate) duplicates++;
          else added++;
          const emailRow = selectEmail.get(normalized) as { id: number };
          insertOccurrence.run(emailRow.id, captureId, timestamp, day, Number(isDuplicate), extracted.original);
        }
      }
      const result = { new: added, duplicates, ignored, captures_saved: capturesSaved };
      if ("batch_id" in input) {
        db.prepare("INSERT INTO email_save_batches(batch_id, run_id, result_json, created_at) VALUES (?, ?, ?, ?)")
          .run(input.batch_id, input.run_id, JSON.stringify(result), timestamp);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    response.status(201).json({ new: added, duplicates, ignored, captures_saved: capturesSaved });
  });

  app.get("/summary/today", (_request, response) => {
    const timezone = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
    const today = localDate(options.now?.() ?? new Date(), timezone);
    const rows = db.prepare(`
      SELECT country_code, SUM(new_count) AS new, SUM(duplicate_count) AS duplicates
      FROM (
        SELECT country_code, COUNT(*) AS new_count, 0 AS duplicate_count
        FROM emails WHERE first_seen_day = ? GROUP BY country_code
        UNION ALL
        SELECT c.country_code, 0 AS new_count, COUNT(*) AS duplicate_count
        FROM email_occurrences o JOIN captures c ON c.id = o.capture_id
        WHERE o.local_day = ? AND o.is_duplicate = 1 GROUP BY c.country_code
      )
      GROUP BY country_code ORDER BY country_code
    `).all(today, today);
    const activity = db.prepare("SELECT queries_completed, posts_scanned FROM daily_run_stats WHERE local_day = ?")
      .get(today) as { queries_completed: number; posts_scanned: number } | undefined;
    const lastSaved = db.prepare("SELECT MAX(captured_at) AS saved_at FROM captures WHERE local_day = ?")
      .get(today) as { saved_at: string | null };
    response.json({
      date: today,
      timezone,
      countries: rows,
      queries_completed: Number(activity?.queries_completed ?? 0),
      posts_scanned: Number(activity?.posts_scanned ?? 0),
      last_saved_at: lastSaved.saved_at
    });
  });

  app.get("/summary/history", (request, response) => {
    const params = parseBody(summaryQuery, request.query);
    const { start, end } = periodRange(params.period, params.date);
    const countryClause = params.country ? " AND country_code = ?" : "";
    const emailParams = params.country ? [start, end, params.country] : [start, end];
    const duplicateClause = params.country ? " AND c.country_code = ?" : "";
    const duplicateParams = params.country ? [start, end, params.country] : [start, end];
    const newRows = db.prepare(`
      SELECT country_code, COUNT(*) AS new FROM emails
      WHERE first_seen_day >= ? AND first_seen_day < ?${countryClause}
      GROUP BY country_code
    `).all(...emailParams) as Array<{ country_code: string; new: number }>;
    const duplicateRows = db.prepare(`
      SELECT c.country_code, COUNT(*) AS duplicates
      FROM email_occurrences o JOIN captures c ON c.id = o.capture_id
      WHERE o.local_day >= ? AND o.local_day < ? AND o.is_duplicate = 1${duplicateClause}
      GROUP BY c.country_code
    `).all(...duplicateParams) as Array<{ country_code: string; duplicates: number }>;

    const totals = new Map<string, { country_code: string; new: number; duplicates: number }>();
    for (const row of newRows) totals.set(row.country_code, { country_code: row.country_code, new: Number(row.new), duplicates: 0 });
    for (const row of duplicateRows) {
      const entry = totals.get(row.country_code) ?? { country_code: row.country_code, new: 0, duplicates: 0 };
      entry.duplicates = Number(row.duplicates);
      totals.set(row.country_code, entry);
    }
    response.json({
      period: params.period,
      date: params.date,
      start,
      end: new Date(`${end}T00:00:00.000Z`).toISOString().slice(0, 10),
      countries: [...totals.values()].sort((a, b) => a.country_code.localeCompare(b.country_code))
    });
  });

  for (const format of ["csv", "tsv"] as const) {
    app.get(`/export/${format}`, (request, response) => {
      const { date, period = "day", country } = parseBody(exportQuery, request.query);
      const { start, end } = periodRange(period, date);
      const rows = period === "day"
        ? emailRows(db, date, country)
        : rangedEmailRows(db, start, end, country);
      const cell = format === "csv" ? csvCell : tsvCell;
      const header = ["Email", "Country", "Country code", "City", "Post link", "Post date", "Captured date"];
      const lines = [header.map((field) => cell(field)).join(format === "csv" ? "," : "\t")];
      for (const row of rows) {
        lines.push([
          row.original_email, countryName(row.country_code), row.country_code, row.city, row.post_url, row.post_date, row.first_seen_day
        ].map((field) => cell(field)).join(format === "csv" ? "," : "\t"));
      }
      const countries = country ? [country] : rows.map((row) => row.country_code);
      response
        .type(format === "csv" ? "text/csv; charset=utf-8" : "text/tab-separated-values; charset=utf-8")
        .setHeader("Content-Disposition", `attachment; filename="tracker-${period}-${date}-${countryFilePart(countries)}.${format}"`)
        .send(`${format === "csv" ? "\uFEFF" : ""}${lines.join("\r\n")}`);
    });
  }

  app.post("/backup", async (_request, response, next) => {
    try {
      const backupPath = await createBackup(db, options.backupDirectory);
      response.status(201).json({ backup: backupPath });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    jsonError(response, 404, "Endpoint not found");
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    if (error instanceof ZodError) {
      jsonError(response, 400, "Invalid request", error.issues);
      return;
    }
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 500;
    if (status === 404) {
      jsonError(response, 404, error instanceof Error ? error.message : "Not found");
      return;
    }
    if (status >= 400 && status < 500) {
      jsonError(response, status, error instanceof Error ? error.message : "Invalid request");
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      jsonError(response, 400, "Malformed JSON body");
      return;
    }
    const errorCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    const diskFailure = ["ENOSPC", "EACCES", "EPERM", "SQLITE_FULL", "SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CANTOPEN"].includes(errorCode)
      || (error instanceof Error && /disk (?:i\/o )?error|database or disk is full|readonly database|permission denied/i.test(error.message));
    if (diskFailure) {
      jsonError(response, 507, "Database disk error. Check free disk space and permissions for the data and backups folders.");
      return;
    }
    const sqliteCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    const sqliteExtendedCode = typeof error === "object" && error !== null && "errcode" in error
      ? Number((error as { errcode: unknown }).errcode)
      : null;
    const diagnostic = {
      requestId: randomUUID(),
      method: request.method,
      path: request.path,
      errorName: error instanceof Error ? error.name : "UnknownError",
      sqliteCode,
      sqliteExtendedCode
    };
    console.error("API request failed:", {
      ...diagnostic,
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
    });
    response.status(500).json({ error: "Internal service error", details: { diagnostic } });
  };
  app.use(errorHandler);
  return app;
}
