import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import {
  assertNoMasterOverlap,
  computeDailyComparison,
  recomputeDailyComparison,
  replaceWorkbookFile,
  writeDailyComparison,
  writeDailyWorkbook,
  type DailyComparison
} from "../src/daily-comparison.js";

describe("daily master comparison", () => {
  let directory: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "job-tracker-daily-"));
    db = openDatabase(path.join(directory, "tracker.db"), "UTC");
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("compares case-insensitively after trimming quotes, preserves originals and first-occurrence order, and keeps unusual emails", () => {
    const result = computeDailyComparison("2026-10-25", [
      { originalEmail: ' "Recruiter@Example.com" ', countryCode: "GB", city: "London", postUrl: "https://example.test/1" },
      { originalEmail: "recruiter@example.com", countryCode: "GB", city: "Manchester", postUrl: "https://example.test/2" },
      { originalEmail: " 'KNOWN@example.com' ", countryCode: "CA", city: "Toronto", postUrl: "https://example.test/known" },
      { originalEmail: "x@x.io", countryCode: "US", city: "Austin", postUrl: "https://example.test/3" },
      { originalEmail: "hr@company.xyz", countryCode: "IE", city: "Dublin", postUrl: "https://example.test/4" }
    ], new Set(["known@example.com"]));

    expect(result.emails.map((email) => email.originalEmail)).toEqual([
      ' "Recruiter@Example.com" ',
      " 'KNOWN@example.com' ",
      "x@x.io",
      "hr@company.xyz"
    ]);
    expect(result.emails.map((email) => email.normalizedEmail)).toEqual([
      "recruiter@example.com",
      "known@example.com",
      "x@x.io",
      "hr@company.xyz"
    ]);
    expect(result.emails[0].ordinal).toBe(0);
    expect(result.inMasterCount).toBe(1);
    expect(result.newCount).toBe(3);
  });

  it("rejects a forced master overlap before creating or replacing the workbook", async () => {
    const badComparison: DailyComparison = {
      day: "2026-10-25",
      emails: [{
        originalEmail: "known@example.com",
        normalizedEmail: "known@example.com",
        countryCode: "GB",
        city: "London",
        postUrl: "https://example.test/post",
        inMaster: false,
        isNew: true,
        ordinal: 0
      }],
      collectedCount: 1,
      inMasterCount: 0,
      newCount: 1
    };
    const workbookPath = path.join(directory, "exports", "Unique-Emails.xlsx");

    await expect(writeDailyComparison(workbookPath, badComparison, new Set(["known@example.com"])))
      .rejects.toThrow("overlap check failed");
    await expect(stat(workbookPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => assertNoMasterOverlap(badComparison.emails, new Set(["known@example.com"])))
      .toThrow("overlap check failed");
  });

  it("passes the independent overlap check when every new email is absent from the master set", () => {
    const comparison = computeDailyComparison("2026-10-25", [
      { originalEmail: "new@example.com", countryCode: "GB", city: "London", postUrl: "https://example.test/post" }
    ], new Set(["existing@example.com"]));

    expect(() => assertNoMasterOverlap(comparison.emails, new Set(["existing@example.com"]))).not.toThrow();
    expect(comparison.newCount).toBe(1);
  });

  it("recomputes idempotently and keeps the first captured original text", () => {
    const query = db.prepare(`
      INSERT INTO queries(country_code, label, query_text, position, enabled, notes, created_at, updated_at)
      VALUES ('GB', 'London', 'query', 0, 1, '', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z')
    `).run();
    const queryId = Number(query.lastInsertRowid);
    const run = db.prepare(`
      INSERT INTO runs(started_at, status, current_query_id) VALUES ('2026-10-25T00:00:00Z', 'completed', ?)
    `).run(queryId);
    const runId = Number(run.lastInsertRowid);
    const insertCapture = db.prepare(`
      INSERT INTO captures(run_id, query_id, country_code, city, post_url, captured_at, local_day)
      VALUES (?, ?, 'GB', 'London', ?, ?, '2026-10-25')
    `);
    const first = Number(insertCapture.run(runId, queryId, "https://example.test/first", "2026-10-25T08:00:00Z").lastInsertRowid);
    const second = Number(insertCapture.run(runId, queryId, "https://example.test/second", "2026-10-25T08:01:00Z").lastInsertRowid);
    const email = db.prepare(`
      INSERT INTO emails(normalized_email, original_email, first_seen_at, first_seen_day, country_code, city, post_url, source)
      VALUES ('recruiter@example.com', 'Recruiter@example.com', '2026-10-25T08:00:00Z', '2026-10-25', 'GB', 'London', 'https://example.test/first', 'test')
    `).run();
    const emailId = Number(email.lastInsertRowid);
    const insertOccurrence = db.prepare(`
      INSERT INTO email_occurrences(email_id, capture_id, seen_at, local_day, is_duplicate, original_email)
      VALUES (?, ?, ?, '2026-10-25', ?, ?)
    `);
    insertOccurrence.run(emailId, first, "2026-10-25T08:00:00Z", 0, "Recruiter@Example.com");
    insertOccurrence.run(emailId, second, "2026-10-25T08:01:00Z", 1, "recruiter@example.com");
    const firstResult = recomputeDailyComparison(db, "2026-10-25", new Date("2026-10-25T12:00:00Z"), false);
    const secondResult = recomputeDailyComparison(db, "2026-10-25", new Date("2026-10-25T12:01:00Z"), false);
    const persisted = db.prepare("SELECT original_email, ordinal FROM daily_comparison_emails WHERE day = ? ORDER BY ordinal")
      .all("2026-10-25");

    expect(firstResult.emails).toEqual(secondResult.emails);
    expect(persisted).toEqual([{ original_email: "Recruiter@Example.com", ordinal: 0 }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM daily_comparison_emails").get()).toEqual({ count: 1 });
  });

  it("creates dated sheets with the required headers, preserves other sheets, and keeps dates ordered", async () => {
    const workbookPath = path.join(directory, "Unique-Emails.xlsx");
    const template = new ExcelJS.Workbook();
    template.addWorksheet("Notes").getCell("A1").value = "keep this";
    template.addWorksheet("2026-10-24").getCell("A2").value = "yesterday";
    await template.xlsx.writeFile(workbookPath);

    const emails = computeDailyComparison("2026-10-25", [
      { originalEmail: "one@example.com", countryCode: "GB", city: "London", postUrl: "https://example.test/1" },
      { originalEmail: "two@example.com", countryCode: "GB", city: "London", postUrl: "https://example.test/2" }
    ], new Set(["two@example.com"]));
    await writeDailyWorkbook(workbookPath, "2026-10-25", emails.emails);
    await writeDailyWorkbook(workbookPath, "2026-10-25", emails.emails);

    const saved = new ExcelJS.Workbook();
    await saved.xlsx.readFile(workbookPath);
    expect(saved.worksheets.map((sheet) => sheet.name)).toEqual(["2026-10-24", "2026-10-25", "Notes"]);
    expect(saved.getWorksheet("2026-10-25")?.getRow(1).values).toEqual([
      ,
      "Unique Emails for this Day",
      "Not in Reference CSV",
      "Country (column A)",
      "Country (column B)"
    ]);
    expect(saved.getWorksheet("2026-10-25")?.getCell("C2").value).toBe("United Kingdom");
    expect(saved.getWorksheet("2026-10-25")?.getCell("A2").value).toBe("one@example.com");
    expect(saved.getWorksheet("2026-10-25")?.getCell("B2").value).toBe("one@example.com");
    expect(saved.getWorksheet("Notes")?.getCell("A1").value).toBe("keep this");
    expect((await readFile(workbookPath)).byteLength).toBeGreaterThan(0);
  });

  it("creates the workbook when the file does not exist", async () => {
    const workbookPath = path.join(directory, "new", "Unique-Emails.xlsx");
    await writeDailyWorkbook(workbookPath, "2026-10-25", []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookPath);
    expect(workbook.getWorksheet("2026-10-25")?.getCell("A1").value).toBe("Unique Emails for this Day");
  });

  it("reports the close-workbook message when the OS denies replacement of a locked workbook", async () => {
    const permissionError = Object.assign(new Error("file is locked"), { code: "EPERM" });
    await expect(replaceWorkbookFile("temporary.xlsx", "Unique-Emails.xlsx", async () => {
      throw permissionError;
    }))
      .rejects.toThrow("Close Unique-Emails.xlsx in Excel and retry.");
  });
});
