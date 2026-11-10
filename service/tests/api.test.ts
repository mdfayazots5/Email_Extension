import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { csvCell, tsvCell } from "../src/csv.js";

const token = "test-token-which-is-long-enough-for-the-api";

describe("storage service API", () => {
  let directory: string;
  let databasePath: string;
  let db: ReturnType<typeof openDatabase>;
  let server: Server;
  let baseUrl: string;
  let fakeNow: Date;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "job-tracker-test-"));
    databasePath = path.join(directory, "tracker.db");
    fakeNow = new Date("2026-10-25T12:00:00.000Z");
    db = openDatabase(databasePath, "UTC");
    const app = createApp({
      db,
      token,
      timezone: "UTC",
      backupDirectory: path.join(directory, "backups"),
      extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
      now: () => new Date(fakeNow)
    });

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function api(pathname: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers
      }
    });
  }

  async function createRunAndQuery() {
    const queryResponse = await api("/queries", {
      method: "POST",
      body: JSON.stringify({
        country_code: "GB",
        label: "London",
        query_text: "developer AND London AND hiring",
        position: 0,
        enabled: true,
        notes: ""
      })
    });
    const query = await queryResponse.json() as { id: number };
    const runResponse = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ current_query_id: query.id })
    });
    const run = await runResponse.json() as { id: number };
    return { queryId: query.id, runId: run.id };
  }

  it("serializes simultaneous duplicate email writes into one master record", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const secondRunResponse = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ current_query_id: queryId, profile_id: "profile-2", profile_label: "Profile 2" })
    });
    const secondRunId = (await secondRunResponse.json() as { id: number }).id;
    const batch = (email: string, profileRunId: number) => api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        run_id: profileRunId,
        query_id: queryId,
        country_code: "GB",
        city: "London",
        post_url: "https://www.linkedin.com/posts/example",
        post_date: "2026-10-25",
        emails: [email]
      })
    });

    const responses = await Promise.all([
      batch(" Recruiter@example.com ", runId),
      batch("recruiter@example.com", secondRunId)
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const counts = await Promise.all(responses.map((response) => response.json()));
    expect(counts.reduce((sum, value) => sum + value.new, 0)).toBe(1);
    expect(counts.reduce((sum, value) => sum + value.duplicates, 0)).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM emails").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM email_occurrences").get() as { count: number }).count).toBe(2);
  });

  it("saves post metadata and makes a retried capture batch idempotent", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const requestBody = {
      batch_id: "a3a31a87-e92c-4788-9465-07b701236598",
      run_id: runId,
      query_id: queryId,
      captures: [{
        country_code: "GB",
        city: "London",
        post_url: "https://www.linkedin.com/posts/example",
        post_date: "2026-10-22",
        post_date_text: "3d",
        author_name: "Recruiter",
        post_text: "Contact recruiter@example.com for roles.",
        ignored_emails: 2,
        emails: [{ email: "recruiter@example.com", original: "Recruiter@Example.com." }]
      }]
    };
    const first = await api("/emails/save-batch", { method: "POST", body: JSON.stringify(requestBody) });
    const retry = await api("/emails/save-batch", { method: "POST", body: JSON.stringify(requestBody) });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await first.json()).toMatchObject({ new: 1, duplicates: 0, ignored: 2, captures_saved: 1 });
    expect(await retry.json()).toMatchObject({ new: 1, duplicates: 0, ignored: 2, captures_saved: 1 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM captures").get() as { count: number }).count).toBe(1);
    expect(db.prepare("SELECT post_date_text, author_name, post_text FROM captures").get()).toEqual({
      post_date_text: "3d",
      author_name: "Recruiter",
      post_text: "Contact recruiter@example.com for roles."
    });

    const recent = await (await api(`/runs/${runId}/recent-captures`)).json() as Array<{ email: string; post_url: string }>;
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ email: "Recruiter@Example.com.", post_url: requestBody.captures[0].post_url });
  });

  it("returns a safe request ID and SQLite details for save failures", async () => {
    const { queryId, runId } = await createRunAndQuery();
    db.exec(`CREATE TRIGGER fail_capture_insert BEFORE INSERT ON captures BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;`);
    const response = await api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "39a5e4db-1fa3-4149-bfb2-9bc4750bce37",
        run_id: runId,
        query_id: queryId,
        captures: [{
          country_code: "GB",
          city: "London",
          post_url: "",
          post_date: null,
          post_date_text: "",
          author_name: "",
          post_text: "",
          ignored_emails: 0,
          emails: []
        }]
      })
    });
    expect(response.status).toBe(500);
    const body = await response.json() as {
      error: string;
      details: { diagnostic: { requestId: string; method: string; path: string; errorName: string; sqliteCode: string } };
    };
    expect(body.error).toBe("Internal service error");
    expect(body.details.diagnostic).toMatchObject({
      method: "POST",
      path: "/emails/save-batch",
      errorName: "Error",
      sqliteCode: "ERR_SQLITE_ERROR"
    });
    expect(body.details.diagnostic.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain("forced test failure");
  });

  it("saves captures and emails when LinkedIn does not expose a post permalink", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const response = await api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "8c2bb197-2c26-44c8-88b4-9b37c606a53a",
        run_id: runId,
        query_id: queryId,
        captures: [{
          country_code: "GB",
          city: "London",
          post_url: "",
          post_date: null,
          post_date_text: "Oct 9",
          author_name: "",
          post_text: "Contact recruiter@example.com for roles.",
          ignored_emails: 0,
          emails: [{ email: "recruiter@example.com", original: "recruiter@example.com" }]
        }]
      })
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ new: 1, captures_saved: 1 });
    expect(db.prepare("SELECT post_url FROM captures").get()).toEqual({ post_url: "" });
    expect(db.prepare("SELECT post_url FROM emails").get()).toEqual({ post_url: "" });

    const deleteQuery = await api(`/queries/${queryId}`, { method: "DELETE" });
    expect(deleteQuery.status).toBe(409);
    expect(await deleteQuery.json()).toMatchObject({
      error: "This query has saved captures and cannot be deleted."
    });

    const daily = await api("/daily?date=2026-10-25");
    expect(daily.status).toBe(200);
    expect(await daily.json()).toMatchObject({
      collected: 1,
      new: 1,
      emails: [{ original_email: "recruiter@example.com", post_url: "" }]
    });

    const invalidUrl = await api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "3fc751b2-23ca-4405-8255-91a89a76faf4",
        run_id: runId,
        query_id: queryId,
        captures: [{
          country_code: "GB",
          city: "London",
          post_url: "https://example.com/not-a-linkedin-post",
          post_date: null,
          post_date_text: "",
          author_name: "",
          post_text: "",
          ignored_emails: 0,
          emails: [{ email: "another@example.com", original: "another@example.com" }]
        }]
      })
    });
    expect(invalidUrl.status).toBe(400);
  });

  it("imports a master list and serves only new daily results with the permanent workbook", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const saved = await api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        run_id: runId,
        query_id: queryId,
        country_code: "GB",
        city: "London",
        post_url: "https://www.linkedin.com/posts/example",
        emails: ["new@example.com", "known@example.com"]
      })
    });
    expect(saved.status).toBe(201);

    const imported = await api("/master/import", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "master.csv"
      },
      body: Buffer.from("Email\r\nknown@example.com\r\n")
    });
    expect(imported.status).toBe(201);
    expect(JSON.stringify(await imported.json())).not.toContain("known@example.com");

    const daily = await api("/daily?date=2026-10-25");
    expect(daily.status).toBe(200);
    expect(await daily.json()).toMatchObject({
      collected: 2,
      already_in_master: 1,
      new: 1,
      emails: [{ original_email: "new@example.com", country_code: "GB", city: "London" }]
    });

    const history = await api("/daily/history?period=day&date=2026-10-25");
    expect(await history.json()).toMatchObject({
      days: [{ day: "2026-10-25", country_code: "GB", collected: 2, already_in_master: 1, new: 1 }]
    });
    const workbook = await api("/export/unique-xlsx");
    expect(workbook.status).toBe(200);
    expect(workbook.headers.get("content-disposition")).toContain("Unique-Emails.xlsx");
    const downloaded = new ExcelJS.Workbook();
    await downloaded.xlsx.load(await workbook.arrayBuffer());
    const daySheet = downloaded.getWorksheet("2026-10-25")!;
    expect(daySheet.getCell("C1").value).toBe("Country (column A)");
    expect(daySheet.getCell("D2").value).toBe("United Kingdom");

    const countryCsv = await api("/export/unique-csv?date=2026-10-25&country=GB");
    expect(countryCsv.headers.get("content-disposition")).toContain("Unique-Emails-2026-10-25-United-Kingdom.csv");
    // fetch().text() drops the leading BOM.
    expect(await countryCsv.text()).toBe("Email,Country,City\r\nnew@example.com,United Kingdom,London");
    const otherCountry = await api("/export/unique-csv?date=2026-10-25&country=US");
    expect(await otherCountry.text()).toBe("Email,Country,City\r\n");
  });

  it("runs versioned migrations repeatedly without errors", () => {
    db.close();
    db = openDatabase(databasePath, "UTC");
    db.close();
    db = openDatabase(databasePath, "UTC");
    expect(db.prepare("SELECT version FROM migrations").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 }
    ]);
    // New installs start empty: no author-specific queries are seeded.
    expect(db.prepare("SELECT COUNT(*) AS count FROM queries").get()).toEqual({ count: 0 });
  });

  it("moves settings still at the old defaults to the slower account-health defaults", () => {
    db.prepare("DELETE FROM migrations WHERE version = 14").run();
    db.prepare("INSERT INTO settings(key, value) VALUES ('max_scrolls_per_query', '50'), ('query_pause_min_ms', '60000') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.close();
    db = openDatabase(databasePath, "UTC");
    const value = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value;
    expect(value("max_scrolls_per_query")).toBe("15");
    // Changed by hand, so it is kept.
    expect(value("query_pause_min_ms")).toBe("60000");
  });

  it("allows separate profiles but gives a query lock to only one at a time", async () => {
    const { queryId } = await createRunAndQuery();
    const second = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ current_query_id: queryId, profile_label: "Second Chrome profile", profile_id: "profile-2" })
    });
    expect(second.status).toBe(201);
    const secondRun = await second.json() as { id: number };
    const firstRunId = Number((db.prepare("SELECT id FROM runs ORDER BY id LIMIT 1").get() as { id: number }).id);
    const lockRequests = await Promise.all([
      api(`/queries/${queryId}/lock`, {
        method: "POST",
        body: JSON.stringify({ run_id: firstRunId, profile_id: "default-profile", profile_label: "Profile 1" })
      }),
      api(`/queries/${queryId}/lock`, {
        method: "POST",
        body: JSON.stringify({ run_id: secondRun.id, profile_id: "profile-2", profile_label: "Profile 2" })
      })
    ]);
    expect(lockRequests.map((response) => response.status).sort()).toEqual([200, 409]);
    const lockOwner = (db.prepare("SELECT run_id FROM query_locks WHERE query_id = ?").get(queryId) as { run_id: number }).run_id;
    const conflictBody = await lockRequests.find((response) => response.status === 409)!.json() as {
      error: string;
      locked_run_id: number;
      locked_profile_id: string;
      expires_at: string;
      profile_label: string;
    };
    expect(conflictBody).toMatchObject({
      error: "Query is currently locked by another run",
      locked_run_id: lockOwner,
      locked_profile_id: lockOwner === firstRunId ? "default-profile" : "profile-2"
    });
    expect(conflictBody.expires_at).toMatch(/Z$/);
    await api(`/queries/${queryId}/lock?run_id=${lockOwner}`, { method: "DELETE" });
    expect((await api(`/queries/${queryId}/lock`, {
      method: "POST",
      body: JSON.stringify({ run_id: secondRun.id, profile_id: "profile-2", profile_label: "Profile 2" })
    })).status).toBe(200);
    db.prepare("UPDATE query_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE query_id = ?").run(queryId);
    expect((await api(`/queries/${queryId}/lock`, {
      method: "POST",
      body: JSON.stringify({ run_id: firstRunId, profile_id: "default-profile", profile_label: "Profile 1" })
    })).status).toBe(200);
    expect(await (await api("/runs/active?profile_id=profile-2")).json()).toMatchObject({ id: secondRun.id });
  });

  it("returns correct today and history counts", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const save = (email: string) => api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        run_id: runId,
        query_id: queryId,
        country_code: "GB",
        city: "London",
        post_url: "https://www.linkedin.com/posts/example",
        post_date: "2026-10-25",
        emails: [email]
      })
    });
    await save("first@example.com");
    await save("first@example.com");
    const today = await (await api("/summary/today")).json() as {
      date: string;
      countries: Array<{ country_code: string; new: number; duplicates: number }>;
    };
    expect(today.countries).toEqual([{ country_code: "GB", new: 1, duplicates: 1 }]);

    const history = await (await api(`/summary/history?period=day&date=${today.date}&country=GB`)).json() as {
      countries: Array<{ country_code: string; new: number; duplicates: number }>;
    };
    expect(history.countries).toEqual([{ country_code: "GB", new: 1, duplicates: 1 }]);
  });

  it("returns the same daily summary shape after a recompute as the daily endpoint", async () => {
    const { queryId, runId } = await createRunAndQuery();
    await api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        batch_id: "38db43d3-b578-48df-9620-75f5b0109226",
        run_id: runId,
        query_id: queryId,
        captures: [{
          country_code: "GB",
          city: "London",
          post_url: "",
          post_date: null,
          post_date_text: "",
          author_name: "",
          post_text: "",
          ignored_emails: 0,
          emails: [{ email: "daily@example.com", original: "daily@example.com" }]
        }]
      })
    });
    const recomputed = await api("/daily/recompute?date=2026-10-25", { method: "POST" });
    const regular = await api("/daily?date=2026-10-25");
    expect(recomputed.status).toBe(200);
    const result = await recomputed.json();
    expect(result).toMatchObject({
      date: "2026-10-25",
      collected: 1,
      already_in_master: 0,
      new: 1,
      emails: [{
        original_email: "daily@example.com",
        country_code: "GB",
        city: "London",
        post_url: ""
      }]
    });
    expect(result).toEqual(await regular.json());
  });

  it("exports CSV with quoting and TSV with sanitized line breaks", async () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(tsvCell("a\tb\r\nc")).toBe("a b c");
    const { queryId, runId } = await createRunAndQuery();
    await api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        run_id: runId,
        query_id: queryId,
        country_code: "GB",
        city: "London, South\nWest",
        post_url: "https://www.linkedin.com/posts/example",
        post_date: "2026-10-25",
        emails: ["csv@example.com"]
      })
    });
    const today = await (await api("/summary/today")).json() as { date: string };
    const csvResponse = await api(`/export/csv?date=${today.date}`);
    const csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
    expect([...csvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(csvBytes);
    expect(csv).toContain("Email,Country,Country code,City,Post link,Post date,Captured date");
    expect(csv).toContain("csv@example.com,United Kingdom,GB,");
    expect(csvResponse.headers.get("content-disposition")).toContain("-United-Kingdom.csv");
    expect(csv).toContain('"London, South\nWest"');
    const tsvResponse = await api(`/export/tsv?date=${today.date}`);
    const tsv = await tsvResponse.text();
    expect(tsv.split("\r\n")[0]).toBe("Email\tCountry\tCountry code\tCity\tPost link\tPost date\tCaptured date");
    expect(tsv).toContain("csv@example.com\tUnited Kingdom\tGB\tLondon, South West");
  });

  it("rejects missing and invalid tokens with 401", async () => {
    const missing = await fetch(`${baseUrl}/health`);
    const invalid = await fetch(`${baseUrl}/health`, { headers: { authorization: "Bearer wrong-token" } });
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Missing or invalid service token" });
  });

  it("allows only configured extension origins through CORS", async () => {
    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    );

    const blocked = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}`, origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" }
    });
    expect(blocked.status).toBe(403);
  });

  it("stores service settings and validates IANA timezone values", async () => {
    const defaults = await (await api("/settings")).json() as { max_scrolls_per_query: number; max_searches_per_day: number; rest_hours_after_warning: number };
    expect(defaults.max_scrolls_per_query).toBe(15);
    expect(defaults.max_searches_per_day).toBe(25);
    expect(defaults.rest_hours_after_warning).toBe(24);
    const saved = await api("/settings", {
      method: "PUT",
      body: JSON.stringify({
        starting_country: "gb",
        timezone: "Europe/London",
        data_retention_days: 365,
        scan_delay_min_ms: 2000,
        scan_delay_max_ms: 4000,
        max_scrolls_per_query: 25,
        max_posts_per_query: 150,
        stop_after_no_new_posts: 4,
        query_pause_min_ms: 25000,
        query_pause_max_ms: 45000,
        max_queries_per_run: 5,
        max_posts_per_day: 10000,
        query_retry_limit: 2,
        ignore_generic_addresses: true,
        ignored_email_prefixes: ["noreply", "no-reply", "donotreply"]
      })
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      starting_country: "GB",
      timezone: "Europe/London",
      data_retention_days: 365,
      max_scrolls_per_query: 25,
      query_pause_min_ms: 25000,
      max_queries_per_run: 5,
      max_posts_per_day: 10000,
      ignore_generic_addresses: true
    });

    const invalid = await api("/settings", {
      method: "PUT",
      body: JSON.stringify({ timezone: "Not/A_Timezone" })
    });
    expect(invalid.status).toBe(400);

    const excessiveScrolls = await api("/settings", {
      method: "PUT",
      body: JSON.stringify({ max_scrolls_per_query: 51 })
    });
    expect(excessiveScrolls.status).toBe(400);
  });

  it("counts query progress exactly once and enforces daily aggregate counters", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const patchProgress = (postsScanned: number, queryStatus: string) => api(`/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify({
        progress_json: { stage: queryStatus === "completed" ? "completed" : "scanning", queryStatus, counters: { postsScanned } }
      })
    });

    await patchProgress(4, "scanning");
    await patchProgress(7, "completed");
    await patchProgress(7, "completed");
    const today = await (await api("/summary/today")).json() as { queries_completed: number; posts_scanned: number };
    expect(today).toMatchObject({ queries_completed: 1, posts_scanned: 7 });
    expect(queryId).toBeGreaterThan(0);
  });

  it("stores one country filter profile and returns its capture metadata", async () => {
    const params = "datePosted=%22past-week%22&sortBy=%22date_posted%22&customFacet=value";
    const saved = await api("/country-filters/gb", {
      method: "PUT",
      body: JSON.stringify({ params, summary: "Past week · Latest · All content" })
    });
    expect(saved.status).toBe(200);
    const profile = await saved.json() as {
      country_code: string; params: string; summary: string; captured_at: string; profile_id: string;
    };
    expect(profile).toMatchObject({ country_code: "GB", params, summary: "Past week · Latest · All content" });
    expect(profile.captured_at).toBe(fakeNow.toISOString());
    expect(profile.profile_id).toBeTruthy();
    expect(await (await api("/country-filters")).json()).toEqual([profile]);

    const updated = await api("/country-filters/GB", {
      method: "PUT",
      body: JSON.stringify({ params: "", summary: "No URL filters" })
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as typeof profile).params).toBe("");
  });

  it("persists awaiting-filter and country-completed run states for recovery", async () => {
    const { runId } = await createRunAndQuery();
    const update = (status: string) => api(`/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, progress_json: { stage: status, statusText: status } })
    });
    expect((await update("awaiting_filters")).status).toBe(200);
    expect((await (await api("/runs/active?profile_id=default-profile")).json() as { status: string }).status).toBe("awaiting_filters");
    expect((await update("country_completed")).status).toBe(200);
    expect((await (await api("/runs/active?profile_id=default-profile")).json() as { status: string }).status).toBe("country_completed");
  });

  it("validates country filter profile input", async () => {
    const invalid = await api("/country-filters/invalid", {
      method: "PUT",
      body: JSON.stringify({ params: "ok", summary: "valid" })
    });
    expect(invalid.status).toBe(400);
  });

  it("assigns each email occurrence to the local day when it is saved across midnight", async () => {
    fakeNow = new Date("2026-10-25T23:59:59.000Z");
    const { queryId, runId } = await createRunAndQuery();
    const post = (url: string) => api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        run_id: runId,
        query_id: queryId,
        country_code: "GB",
        city: "London",
        post_url: `https://www.linkedin.com/posts/${url}`,
        post_date: "2026-10-25",
        emails: ["midnight@example.com"]
      })
    });
    await post("before-midnight");
    fakeNow = new Date("2026-10-26T00:00:01.000Z");
    await post("after-midnight");
    expect(db.prepare("SELECT day FROM daily_sheets ORDER BY day").all()).toEqual([{ day: "2026-10-25" }, { day: "2026-10-26" }]);
    expect(db.prepare("SELECT local_day, is_duplicate FROM email_occurrences ORDER BY id").all()).toEqual([
      { local_day: "2026-10-25", is_duplicate: 0 },
      { local_day: "2026-10-26", is_duplicate: 1 }
    ]);
    const today = await (await api("/summary/today")).json() as { countries: Array<{ new: number; duplicates: number }> };
    expect(today.countries).toEqual([{ country_code: "GB", new: 0, duplicates: 1 }]);
  });

  it("keeps only the newest fourteen backup snapshots", async () => {
    for (let index = 0; index < 15; index++) {
      expect((await api("/backup", { method: "POST" })).status).toBe(201);
    }
    const backups = await readdir(path.join(directory, "backups"));
    expect(backups.filter((name) => /^tracker-.*\.db$/.test(name))).toHaveLength(14);
  });

  it("matches day, week, and month summaries against the underlying saved rows", async () => {
    const { queryId, runId } = await createRunAndQuery();
    const save = (email: string) => api("/emails/save-batch", {
      method: "POST",
      body: JSON.stringify({
        run_id: runId,
        query_id: queryId,
        country_code: "GB",
        city: "London",
        post_url: "https://www.linkedin.com/posts/history",
        post_date: "2026-10-24",
        emails: [email]
      })
    });
    await save("history-one@example.com");
    await save("history-two@example.com");
    await save("history-one@example.com");
    db.prepare("UPDATE emails SET first_seen_day = '2026-10-24'").run();
    db.prepare("UPDATE email_occurrences SET local_day = '2026-10-24'").run();
    for (const period of ["day", "week", "month"] as const) {
      const summary = await (await api(`/summary/history?period=${period}&date=2026-10-24`)).json() as {
        countries: Array<{ country_code: string; new: number; duplicates: number }>;
      };
      expect(summary.countries).toEqual([{ country_code: "GB", new: 2, duplicates: 1 }]);
    }
  });
});
