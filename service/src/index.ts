import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config, dataDirectory } from "./config.js";
import { openDatabase } from "./database.js";
import { loadOrCreateToken } from "./token.js";
import { localDate } from "./date-utils.js";
import { recomputeDailyComparison, writeDailyComparison } from "./daily-comparison.js";
import path from "node:path";

async function main() {
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(config.backupDirectory, { recursive: true });
  const token = await loadOrCreateToken(config.tokenPath);
  const database = openDatabase(config.databasePath, config.timezone);
  const exportDirectory = path.join(dataDirectory, "exports");
  const masterDirectory = path.join(dataDirectory, "master");
  const server = createServer(createApp({
    db: database,
    token,
    timezone: (database.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value,
    backupDirectory: config.backupDirectory,
    exportDirectory,
    masterDirectory,
    extensionIds: config.extensionIds
  }));

  let observedDay = localDate(new Date(), (database.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value);
  const midnightTimer = setInterval(() => {
    const timezone = (database.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string }).value;
    const currentDay = localDate(new Date(), timezone);
    if (currentDay === observedDay) return;
    const previous = new Date(`${observedDay}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDay = previous.toISOString().slice(0, 10);
    observedDay = currentDay;
    try {
      const settings = database.prepare("SELECT value FROM settings WHERE key = 'exclude_earlier_emails'").get() as { value: string } | undefined;
      const comparison = recomputeDailyComparison(database, previousDay, new Date(), settings?.value === "1");
      const masterRows = database.prepare("SELECT normalized_email FROM master_emails").all() as Array<{ normalized_email: string }>;
      void writeDailyComparison(path.join(exportDirectory, "Unique-Emails.xlsx"), comparison, new Set(masterRows.map((row) => row.normalized_email)))
        .catch((error: unknown) => console.error(`Unable to write daily workbook for ${previousDay}:`, error));
    } catch (error) {
      console.error(`Unable to recompute daily comparison for ${previousDay}:`, error);
    }
  }, 30_000);
  midnightTimer.unref();

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`Email Extension service listening on http://127.0.0.1:${config.port}`);
  });

  const shutdown = () => {
    clearInterval(midnightTimer);
    server.close(() => {
      database.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("Unable to start Email Extension service:", error);
  process.exitCode = 1;
});
