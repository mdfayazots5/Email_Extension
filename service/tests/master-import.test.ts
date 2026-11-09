import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { importMasterFile, masterStatus } from "../src/master-import.js";

describe("master email import", () => {
  let directory: string;
  let masterDirectory: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "job-tracker-master-"));
    masterDirectory = path.join(directory, "master");
    db = openDatabase(path.join(directory, "tracker.db"), "UTC");
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("parses BOM headers, trims comparison values without changing originals, and reports duplicates and empties", async () => {
    const csv = "\uFEFFWorking Status,Email,Sent Status\r\nActive,\" Recruiter@Example.com \",No\r\nActive,recruiter@example.com,Yes\r\nActive,,No\r\n";
    const result = await importMasterFile(db, Buffer.from(csv, "utf8"), "master.csv", masterDirectory, new Date("2026-10-25T12:00:00Z"));

    expect(result).toMatchObject({ rows_read: 3, valid_emails: 2, empty_cells: 1, duplicate_emails: 1 });
    expect(db.prepare("SELECT normalized_email, original_text FROM master_emails").all())
      .toEqual([{ normalized_email: "recruiter@example.com", original_text: " Recruiter@Example.com " }]);
  });

  it("decodes non-UTF-8 CSV bytes and keeps unusual-looking values for comparison", async () => {
    const bytes = Buffer.from([0x45, 0x6d, 0x61, 0x69, 0x6c, 0x0d, 0x0a, 0x68, 0x72, 0x40, 0x63, 0x6f, 0x6d, 0x70, 0x61, 0x6e, 0x79, 0x2e, 0x63, 0x6f, 0x6d, 0xe9]);
    const result = await importMasterFile(db, bytes, "legacy.csv", masterDirectory, new Date("2026-10-25T12:00:00Z"));

    expect(result).toMatchObject({ rows_read: 1, suspicious_count: 0 });
    expect(db.prepare("SELECT normalized_email, original_text FROM master_emails").get()).toEqual({
      normalized_email: "hr@company.comé",
      original_text: "hr@company.comé"
    });
  });

  it("rejects an empty file and a CSV missing the Email header", async () => {
    await expect(importMasterFile(db, Buffer.alloc(0), "empty.csv", masterDirectory, new Date()))
      .rejects.toThrow("empty");
    await expect(importMasterFile(db, Buffer.from("Name,Status\r\nRecruiter,Active\r\n"), "missing.csv", masterDirectory, new Date()))
      .rejects.toThrow('must contain an "Email" column');
  });

  it("reads XLSX input and replaces active emails while retaining import history and archived copies", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Master");
    sheet.addRow(["Working Status", "Email", "Sent Status", "Schedule Mail ID"]);
    sheet.addRow(["Active", "first@example.com", "No", ""]);
    const xlsx = await workbook.xlsx.writeBuffer();
    await importMasterFile(db, Buffer.from(xlsx), "first.xlsx", masterDirectory, new Date("2026-10-25T12:00:00Z"));
    const secondCsv = "Email\r\nsecond@example.com\r\n";
    await importMasterFile(db, Buffer.from(secondCsv), "second.csv", masterDirectory, new Date("2026-10-26T12:00:00Z"));

    expect(db.prepare("SELECT normalized_email FROM master_emails").all()).toEqual([{ normalized_email: "second@example.com" }]);
    expect(masterStatus(db).imports).toHaveLength(2);
    expect((await readdir(masterDirectory)).sort()).toEqual([
      "2026-10-25T12-00-00-000Z-first.xlsx",
      "2026-10-26T12-00-00-000Z-second.csv"
    ]);
  });
});
