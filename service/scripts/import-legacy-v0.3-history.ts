// One-off: show emails collected by the old v0.3 extension in History.
// v0.3 kept only the address and the day it was seen (no country, city or post link),
// so they are stored under the placeholder country "XX" (shown as "Legacy (v0.3)")
// with a disabled placeholder query, one completed run and one capture per day.
// Safe to re-run: it does nothing once the placeholder query exists.
//   npx tsx scripts/import-legacy-v0.3-history.ts        (from the service folder)
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeForComparison } from "../../shared/email-normalization.ts";
import { config, dataDirectory } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { recomputeDailyComparison } from "../src/daily-comparison.js";

const LEGACY_COUNTRY = "XX";
const LEGACY_LABEL = "Legacy v0.3 import";

const db = openDatabase(config.databasePath, config.timezone);
if (db.prepare("SELECT 1 FROM queries WHERE country_code = ? AND label = ?").get(LEGACY_COUNTRY, LEGACY_LABEL)) {
  console.log("Legacy v0.3 emails are already in History; nothing to do.");
  process.exit(0);
}

const backupPath = path.join(config.backupDirectory, `tracker-${new Date().toISOString().replace(/[:.]/g, "-")}-pre-legacy-history.db`);
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`Backup: ${backupPath}`);

const state = JSON.parse(readFileSync(path.join(dataDirectory, "legacy-v0.3", "email-collector-state.json"), "utf8")) as {
  EmailsByDay: Record<string, string[]>;
};
const days = Object.keys(state.EmailsByDay).sort();
// v0.3 recorded only the day; use the last second of that local day so real captures
// from the same day come first and keep their country in the daily list.
const atDayEnd = (day: string) => {
  const offset = new Intl.DateTimeFormat("en", { timeZone: config.timezone, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${day}T23:59:59Z`)).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") || "Z";
  return new Date(`${day}T23:59:59${offset}`).toISOString();
};

let added = 0;
let repeats = 0;
db.exec("BEGIN IMMEDIATE");
try {
  const now = new Date().toISOString();
  const queryId = Number(db.prepare(`
    INSERT INTO queries(country_code, label, query_text, position, enabled, notes, created_at, updated_at)
    VALUES (?, ?, ?, 9999, 0, ?, ?, ?)
  `).run(
    LEGACY_COUNTRY, LEGACY_LABEL, "legacy-v0.3",
    "Placeholder for emails imported from the old v0.3 extension. Keep it disabled; deleting it is blocked while its captures exist.",
    now, now
  ).lastInsertRowid);
  const runId = Number(db.prepare(`
    INSERT INTO runs(started_at, ended_at, status, current_query_id, continue_next, progress_json, profile_label)
    VALUES (?, ?, 'completed', NULL, 0, '{}', 'legacy-v0.3')
  `).run(atDayEnd(days[0]), atDayEnd(days[days.length - 1])).lastInsertRowid);

  const insertCapture = db.prepare(`
    INSERT INTO captures(run_id, query_id, country_code, city, post_url, post_date, captured_at, local_day)
    VALUES (?, ?, ?, '', '', NULL, ?, ?)
  `);
  const insertEmail = db.prepare(`
    INSERT INTO emails(normalized_email, original_email, first_seen_at, first_seen_day, country_code, city, post_url, post_date, source, review_status)
    VALUES (?, ?, ?, ?, ?, '', '', NULL, 'legacy_v0.3', 'pending')
    ON CONFLICT(normalized_email) DO NOTHING
  `);
  const selectEmail = db.prepare("SELECT id FROM emails WHERE normalized_email = ?");
  const insertOccurrence = db.prepare(`
    INSERT INTO email_occurrences(email_id, capture_id, seen_at, local_day, is_duplicate, original_email)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const day of days) {
    const seenAt = atDayEnd(day);
    const captureId = Number(insertCapture.run(runId, queryId, LEGACY_COUNTRY, seenAt, day).lastInsertRowid);
    const seenToday = new Set<string>();
    for (const raw of state.EmailsByDay[day]) {
      const original = raw.trim();
      const normalized = normalizeForComparison(original);
      if (!normalized || seenToday.has(normalized)) continue;
      seenToday.add(normalized);
      const inserted = insertEmail.run(normalized, original, seenAt, day, LEGACY_COUNTRY).changes > 0;
      const email = selectEmail.get(normalized) as { id: number };
      if (inserted) added++;
      else repeats++;
      insertOccurrence.run(email.id, captureId, seenAt, day, inserted ? 0 : 1, original);
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const excludeEarlier = (db.prepare("SELECT value FROM settings WHERE key = 'exclude_earlier_emails'").get() as { value: string } | undefined)?.value === "1";
for (const day of days) {
  const comparison = recomputeDailyComparison(db, day, new Date(), excludeEarlier);
  console.log(`${day}: ${comparison.collectedCount} collected in History`);
}
db.close();
console.log(`Added ${added} new legacy emails and ${repeats} repeat sightings of emails already tracked.`);
