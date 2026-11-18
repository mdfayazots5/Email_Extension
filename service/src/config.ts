import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Fixed by the "key" in extension/tracker.manifest.json, so it is the same for every user and folder.
export const EXTENSION_ID = "dellkemhijjjiopbmnbcokdnklmcmona";

export const serviceDirectory = fileURLToPath(new URL("../", import.meta.url));
export const projectDirectory = path.resolve(serviceDirectory, "..");
export const dataDirectory = path.join(projectDirectory, "data");

export const config = {
  port: Number(process.env.PORT ?? 4317),
  databasePath: path.resolve(
    process.env.DB_PATH ?? path.join(dataDirectory, "tracker.db")
  ),
  backupDirectory: path.resolve(
    process.env.BACKUP_DIR ?? path.join(dataDirectory, "backups")
  ),
  tokenPath: path.join(serviceDirectory, "token.txt"),
  extensionIds: [
    ...new Set([
      EXTENSION_ID,
      ...(process.env.CORS_EXTENSION_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ])
  ],
  timezone: process.env.APP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone
};

try {
  new Intl.DateTimeFormat("en", { timeZone: config.timezone });
} catch {
  throw new Error(`Invalid APP_TIMEZONE: ${config.timezone}`);
}
