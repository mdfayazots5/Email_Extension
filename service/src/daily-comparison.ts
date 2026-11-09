import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import { normalizeForComparison } from "../../shared/email-normalization.ts";

export type DailyCapture = {
  originalEmail: string;
  countryCode: string;
  city: string;
  postUrl: string;
};

export type DailyEmail = DailyCapture & {
  normalizedEmail: string;
  inMaster: boolean;
  isNew: boolean;
  ordinal: number;
};

export type DailyComparison = {
  day: string;
  emails: DailyEmail[];
  collectedCount: number;
  inMasterCount: number;
  newCount: number;
};

export function computeDailyComparison(
  day: string,
  captures: DailyCapture[],
  masterEmails: Set<string>,
  earlierEmails: Set<string> = new Set(),
  excludeEarlier = false
): DailyComparison {
  const seen = new Set<string>();
  const emails: DailyEmail[] = [];
  for (const capture of captures) {
    const normalizedEmail = normalizeForComparison(capture.originalEmail);
    if (!normalizedEmail || seen.has(normalizedEmail)) continue;
    seen.add(normalizedEmail);
    const inMaster = masterEmails.has(normalizedEmail);
    emails.push({
      ...capture,
      normalizedEmail,
      inMaster,
      isNew: !inMaster && !(excludeEarlier && earlierEmails.has(normalizedEmail)),
      ordinal: emails.length
    });
  }
  assertNoMasterOverlap(emails, masterEmails);
  return {
    day,
    emails,
    collectedCount: emails.length,
    inMasterCount: emails.filter((email) => email.inMaster).length,
    newCount: emails.filter((email) => email.isNew).length
  };
}

export function assertNoMasterOverlap(emails: DailyEmail[], masterEmails: Set<string>): void {
  const overlap = emails.filter((email) => email.isNew && masterEmails.has(email.normalizedEmail));
  if (overlap.length) throw new Error(`Daily master comparison overlap check failed for ${overlap.length} email(s).`);
}

export function loadDailyCaptures(db: DatabaseSync, day: string): DailyCapture[] {
  return db.prepare(`
    SELECT
      COALESCE(NULLIF(o.original_email, ''), e.original_email) AS originalEmail,
      c.country_code AS countryCode,
      c.city AS city,
      c.post_url AS postUrl
    FROM email_occurrences o
    JOIN captures c ON c.id = o.capture_id
    JOIN emails e ON e.id = o.email_id
    WHERE c.local_day = ?
    ORDER BY o.seen_at, o.id
  `).all(day) as unknown as DailyCapture[];
}

export function recomputeDailyComparison(db: DatabaseSync, day: string, now: Date, excludeEarlier: boolean): DailyComparison {
  const captures = loadDailyCaptures(db, day);
  const masterRows = db.prepare("SELECT normalized_email FROM master_emails").all() as Array<{ normalized_email: string }>;
  const masterEmails = new Set(masterRows.map((row) => row.normalized_email));
  const earlierRows = excludeEarlier
    ? db.prepare("SELECT DISTINCT normalized_email FROM daily_comparison_emails WHERE day < ?").all(day) as Array<{ normalized_email: string }>
    : [];
  const earlierEmails = new Set(earlierRows.map((row) => row.normalized_email));
  const comparison = computeDailyComparison(day, captures, masterEmails, earlierEmails, excludeEarlier);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM daily_comparison_emails WHERE day = ?").run(day);
    const insert = db.prepare(`
      INSERT INTO daily_comparison_emails(
        day, normalized_email, original_email, country_code, city, post_url, ordinal, in_master, is_new
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const email of comparison.emails) {
      insert.run(
        day,
        email.normalizedEmail,
        email.originalEmail,
        email.countryCode,
        email.city,
        email.postUrl,
        email.ordinal,
        Number(email.inMaster),
        Number(email.isNew)
      );
    }
    db.prepare(`
      INSERT INTO daily_comparisons(day, collected_count, in_master_count, new_count, recomputed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        collected_count = excluded.collected_count,
        in_master_count = excluded.in_master_count,
        new_count = excluded.new_count,
        recomputed_at = excluded.recomputed_at
    `).run(day, comparison.collectedCount, comparison.inMasterCount, comparison.newCount, now.toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return comparison;
}

export async function writeDailyWorkbook(
  workbookPath: string,
  currentDay: string,
  currentEmails: DailyEmail[]
): Promise<void> {
  await mkdir(path.dirname(workbookPath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  let workbookExists = true;
  try {
    await access(workbookPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    workbookExists = false;
  }
  if (workbookExists) await workbook.xlsx.readFile(workbookPath);

  let sheet = workbook.getWorksheet(currentDay);
  if (!sheet) sheet = workbook.addWorksheet(currentDay);
  sheet.spliceRows(1, sheet.rowCount);
  sheet.getCell("A1").value = "Unique Emails for this Day";
  sheet.getCell("B1").value = "Not in Reference CSV";
  const allEmails = [...currentEmails].sort((a, b) => a.ordinal - b.ordinal);
  const newEmails = allEmails.filter((email) => email.isNew);
  for (let index = 0; index < allEmails.length; index++) {
    sheet.getCell(index + 2, 1).value = allEmails[index].originalEmail;
  }
  for (let index = 0; index < newEmails.length; index++) {
    sheet.getCell(index + 2, 2).value = newEmails[index].originalEmail;
  }

  const model = workbook.model;
  const dateNames = new Set(model.worksheets
    .filter((worksheet) => /^\d{4}-\d{2}-\d{2}$/.test(worksheet.name))
    .map((worksheet) => worksheet.name));
  const sortedNames = [
    ...[...dateNames].sort(),
    ...model.worksheets.map((worksheet) => worksheet.name).filter((name) => !dateNames.has(name))
  ];
  const sheetIds = new Map(model.worksheets.map((worksheet) => [worksheet.name, worksheet.id]));
  model.sheets = sortedNames.flatMap((name) => {
    const sheet = model.sheets.find((item) => item.id === sheetIds.get(name));
    return sheet ? [sheet] : [];
  });
  workbook.model = model;

  const temporaryPath = `${workbookPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await workbook.xlsx.writeFile(temporaryPath);
    await replaceWorkbookFile(temporaryPath, workbookPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function replaceWorkbookFile(
  temporaryPath: string,
  workbookPath: string,
  renameFile: typeof rename = rename
): Promise<void> {
  let lastError: unknown;
  for (const delay of [0, 350, 900, 1800]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await renameFile(temporaryPath, workbookPath);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error("Close Unique-Emails.xlsx in Excel and retry.");
  (error as Error & { cause?: unknown }).cause = lastError;
  throw error;
}

export async function writeDailyComparison(
  workbookPath: string,
  comparison: DailyComparison,
  masterEmails: Set<string>
): Promise<void> {
  assertNoMasterOverlap(comparison.emails, masterEmails);
  await writeDailyWorkbook(workbookPath, comparison.day, comparison.emails);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function dailyCsv(emails: Array<{ original_email: string }>): string {
  const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `\uFEFFEmail\r\n${emails.map((email) => escape(email.original_email)).join("\r\n")}`;
}
