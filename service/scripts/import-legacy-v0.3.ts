// One-off: merge emails collected by the old v0.3 extension
// (data/legacy-v0.3/email-collector-state.json) into the master list, so the
// daily comparison treats them as already known. Run with the service stopped:
//   npx tsx scripts/import-legacy-v0.3.ts        (from the service folder)
import { readFileSync } from "node:fs";
import path from "node:path";
import { config, dataDirectory, projectDirectory } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { importMasterFile } from "../src/master-import.js";

const legacyDirectory = path.join(dataDirectory, "legacy-v0.3");
const masterDirectory = path.join(dataDirectory, "master");
const db = openDatabase(config.databasePath, config.timezone);

// Older imports recorded absolute paths under the previous project folder.
db.prepare("UPDATE master_imports SET file_path = replace(file_path, ?, ?)")
  .run("C:\\Live\\Email_Extension", projectDirectory.replace(/[\\/]$/, ""));

const current = db.prepare("SELECT file_name, file_path FROM master_imports ORDER BY id DESC LIMIT 1")
  .get() as { file_name: string; file_path: string } | undefined;
if (!current) throw new Error("No master list has been imported yet.");
if (current.file_name.includes("legacy-v0.3")) {
  console.log("Legacy v0.3 emails are already in the current master list; nothing to do.");
  process.exit(0);
}

const masterText = readFileSync(path.join(masterDirectory, path.win32.basename(current.file_path)), "utf8");
const known = new Set(
  (db.prepare("SELECT normalized_email FROM master_emails").all() as Array<{ normalized_email: string }>)
    .map((row) => row.normalized_email)
);
const state = JSON.parse(readFileSync(path.join(legacyDirectory, "email-collector-state.json"), "utf8")) as {
  EmailsByDay: Record<string, string[]>;
};
const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const rows: string[] = [];
for (const [day, emails] of Object.entries(state.EmailsByDay)) {
  for (const email of emails) {
    const normalized = email.trim().toLocaleLowerCase();
    if (!normalized || known.has(normalized)) continue;
    known.add(normalized);
    // Columns: Working Status,Email,Sent Status,Schedule Mail ID
    rows.push([`legacy-v0.3 ${day}`, email.trim(), "", ""].map(csvCell).join(","));
  }
}
if (!rows.length) {
  console.log("Every legacy v0.3 email is already in the master list; nothing to do.");
  process.exit(0);
}

const merged = `${masterText.replace(/\s*$/, "")}\r\n${rows.join("\r\n")}\r\n`;
const fileName = `${path.parse(current.file_name).name} + legacy-v0.3.csv`;
const result = await importMasterFile(db, Buffer.from(merged, "utf8"), fileName, masterDirectory, new Date());
db.close();
console.log(`Added ${rows.length} legacy v0.3 emails. New master list:`, result);
