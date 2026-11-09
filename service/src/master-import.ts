import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import { normalizeForComparison } from "../../shared/email-normalization.ts";

export type MasterIssue = { row: number; reason: string };

export type MasterValidation = {
  file_name: string;
  uploaded_at: string;
  rows_read: number;
  valid_emails: number;
  empty_cells: number;
  duplicate_emails: number;
  suspicious_count: number;
  suspicious_entries: MasterIssue[];
};

type ParsedMaster = {
  validation: Omit<MasterValidation, "file_name" | "uploaded_at">;
  entries: Array<{ normalizedEmail: string; originalText: string; rowNumber: number }>;
};

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\r" || character === "\n") && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (character === "\r" && input[index + 1] === "\n") index++;
    } else {
      cell += character;
    }
  }
  if (cell.length || row.length || input.endsWith(",")) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function decodeCsv(bytes: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    decoded = new TextDecoder("windows-1252").decode(bytes);
  }
  return decoded.replace(/^\uFEFF/, "");
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((item) => item.text).join("");
    if ("result" in value && value.result !== undefined) return String(value.result);
    return "";
  }
  return String(value);
}

async function parseXlsx(bytes: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from([bytes]));
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(Array.from({ length: Math.max(row.cellCount, sheet.columnCount) }, (_, index) =>
      cellText(row.getCell(index + 1).value)
    ));
  });
  return rows;
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseRows(rows: string[][]): ParsedMaster {
  if (!rows.length) throw Object.assign(new Error("The uploaded file is empty."), { status: 400 });
  const emailColumn = rows[0].findIndex((value) => value.trim().replace(/^\uFEFF/, "").toLocaleLowerCase() === "email");
  if (emailColumn < 0) {
    throw Object.assign(new Error('The uploaded file must contain an "Email" column in its first row.'), { status: 400 });
  }
  const entries: ParsedMaster["entries"] = [];
  const seen = new Set<string>();
  const suspiciousEntries: MasterIssue[] = [];
  let emptyCells = 0;
  let validEmails = 0;
  let duplicateEmails = 0;
  const dataRows = rows.slice(1);
  for (const [index, row] of dataRows.entries()) {
    const originalText = row[emailColumn] ?? "";
    const normalizedEmail = normalizeForComparison(originalText);
    if (!normalizedEmail) {
      emptyCells++;
      continue;
    }
    const valid = isEmailLike(normalizedEmail);
    if (valid) validEmails++;
    else suspiciousEntries.push({ row: index + 2, reason: "Email value does not match a basic email-address structure." });
    if (seen.has(normalizedEmail)) {
      duplicateEmails++;
      continue;
    }
    seen.add(normalizedEmail);
    entries.push({ normalizedEmail, originalText, rowNumber: index + 2 });
  }
  return {
    validation: {
      rows_read: dataRows.length,
      valid_emails: validEmails,
      empty_cells: emptyCells,
      duplicate_emails: duplicateEmails,
      suspicious_count: suspiciousEntries.length,
      suspicious_entries: suspiciousEntries
    },
    entries
  };
}

export async function importMasterFile(
  db: DatabaseSync,
  bytes: Buffer,
  fileName: string,
  masterDirectory: string,
  uploadedAt: Date
): Promise<MasterValidation> {
  const extension = path.extname(fileName).toLocaleLowerCase();
  if (extension !== ".csv" && extension !== ".xlsx") {
    throw Object.assign(new Error("Choose a CSV or XLSX master file."), { status: 400 });
  }
  if (!bytes.length) throw Object.assign(new Error("The uploaded file is empty."), { status: 400 });
  const rows = extension === ".csv"
    ? parseCsv(decodeCsv(bytes))
    : await parseXlsx(bytes);
  const parsed = parseRows(rows);
  const safeName = path.basename(fileName).replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 180) || `master${extension}`;
  const timestamp = uploadedAt.toISOString();
  const archiveName = `${timestamp.replace(/[:.]/g, "-")}-${safeName}`;
  await mkdir(masterDirectory, { recursive: true });
  const archivePath = path.join(masterDirectory, archiveName);
  const temporaryPath = `${archivePath}.tmp`;
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, archivePath).catch(async (error: unknown) => {
    await rm(temporaryPath, { force: true });
    throw error;
  });

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO master_imports(
        file_name, file_path, uploaded_at, rows_read, valid_emails, empty_cells, duplicate_emails, suspicious_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      safeName,
      archivePath,
      timestamp,
      parsed.validation.rows_read,
      parsed.validation.valid_emails,
      parsed.validation.empty_cells,
      parsed.validation.duplicate_emails,
      parsed.validation.suspicious_count
    );
    const importId = Number(result.lastInsertRowid);
    db.prepare("DELETE FROM master_emails").run();
    const insert = db.prepare(`
      INSERT INTO master_emails(normalized_email, original_text, row_number, import_id)
      VALUES (?, ?, ?, ?)
    `);
    for (const entry of parsed.entries) {
      insert.run(entry.normalizedEmail, entry.originalText, entry.rowNumber, importId);
    }
    const insertIssue = db.prepare(`
      INSERT INTO master_import_issues(import_id, row_number, reason) VALUES (?, ?, ?)
    `);
    for (const issue of parsed.validation.suspicious_entries) {
      insertIssue.run(importId, issue.row, issue.reason);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { file_name: safeName, uploaded_at: timestamp, ...parsed.validation };
}

export function masterStatus(db: DatabaseSync) {
  const imports = db.prepare(`
    SELECT id, file_name, uploaded_at, rows_read, valid_emails, empty_cells, duplicate_emails, suspicious_count
    FROM master_imports ORDER BY id DESC LIMIT 20
  `).all() as Array<{
    id: number;
    file_name: string;
    uploaded_at: string;
    rows_read: number;
    valid_emails: number;
    empty_cells: number;
    duplicate_emails: number;
    suspicious_count: number;
  }>;
  const current = imports[0] ?? null;
  const currentCount = current
    ? Number((db.prepare("SELECT COUNT(*) AS count FROM master_emails").get() as { count: number }).count)
    : 0;
  const issues = current
    ? db.prepare("SELECT row_number AS row, reason FROM master_import_issues WHERE import_id = ? ORDER BY row_number")
      .all(current.id) as MasterIssue[]
    : [];
  return { current: current ? { ...current, email_count: currentCount, suspicious_entries: issues } : null, imports };
}
