# Email Extension

Chrome Manifest V3 extension and a localhost Node.js storage service. The permanent SQLite database is owned by the service at `data\tracker.db`; the extension never writes the database file.

## Requirements

- Node.js 22.5 or newer and npm
- Google Chrome

The storage service uses Node's built-in `node:sqlite` module. It does not require SQLite packages or Windows C++ build tools. Node 22 may display an experimental-module warning for `node:sqlite`.

## Install (once per Windows user)

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the folder you cloned this project into (the one containing `manifest.json`). Do this in every Chrome profile you want to use.
2. Right-click `native-host\install.ps1` and choose **Run with PowerShell** (or run `.\native-host\install.ps1`). It installs the service packages if needed, builds a small native messaging host, registers it for Chrome, Brave, and Edge, and allows the extension's ID (calculated from the folder path) in `service\.env`.
3. Close every Chrome window and reopen Chrome.

That's all. There is no service to start and no token to paste. When any Chrome profile opens the extension, Chrome starts the native host. The host starts the storage service hidden in the background (if it is not already running) and hands the extension its token. Every profile of this Windows user shares the same service and the same `data\tracker.db`. The service keeps running in the background; the first start after Windows boots takes a few seconds. Its output goes to `data\logs\service.log`.

Run `install.ps1` again only after changing `native-host\Program.cs` or moving the project folder. `native-host\uninstall.ps1` removes the registration.

Optional service settings in `service\.env`: `DB_PATH`, `BACKUP_DIR`, `APP_TIMEZONE`, `PORT` (defaults: `data\tracker.db`, `data\backups`, the computer's timezone, 4317). The service creates `service\token.txt` on first start; keep it private. The service binds only to `127.0.0.1` and accepts only allowed extension origins.

For development you can still run the service in a terminal with `.\start-service.bat` or `npm run service`.

A new installation starts with no saved searches. Open **Queries → Add country**, pick a country and add your first search record (usually a city) with a LinkedIn-style query for the job you want, for example `("Job title" OR "Other title") AND "City" AND hiring`.

## Build the extension

After changing extension code, build from the project root:

```powershell
npm run build
```

`npm run build` builds into `extension\dist` and then copies the result to the root (`scripts\sync-extension.mjs`); click reload on the extension card after each build.

The MV3 manifest requests `nativeMessaging` to start the local service, `storage` for the service token, selected query and resumable run snapshot, `tabs` to reuse or open the LinkedIn search tab, and `sidePanel` for the tracker view. Clicking the extension icon opens a compact popup with **Start**, **Stop**, and **View**. On a LinkedIn Posts search page, a draggable compact control bar has country and record selectors with **Start** and **Stop**; use the extension popup or tracker View for Pause/Resume and diagnostics. **View** opens the tracker side panel when Chrome allows it, otherwise it falls back to a tracker tab. Host access is limited to `www.linkedin.com`, the local service at `127.0.0.1:4317`, and its `localhost` alias. The content script matches only `https://www.linkedin.com/search/results/content/*`; `scripting` and `activeTab` are not used.

**Settings → Activity log** keeps one log per local day (newest 14 days, this Chrome profile only). It is on by default and can be switched off there. Each day starts empty and records runs, searches the extension opened (retries included), every LinkedIn search page load in the profile (manual ones too), scrolls, posts, pauses, stops and LinkedIn warnings, with times. It also shows the busiest hour, typical spacing, and the activity in the hour before the first warning. Each day can be viewed, copied or downloaded as a .txt file. No emails, post text, names or links are stored.

**Settings → Speed & limits → Account health** sets a daily cap on searches the extension opens (default 25 per Chrome profile) and a rest period after any LinkedIn security check, captcha or "unusual search traffic" notice (default 24 hours). During that rest Start is refused; **End rest now** overrides it. Migration 14 moved settings still at the old defaults to slower ones: 6–12 s between scrolls, 15 scrolls and 150 posts per record, 2–5 min between records, 5 records per run and 600 posts per day. Values changed by hand were kept.

Connection diagnostics are off by default. In **Settings → Advanced → Connection diagnostics**, turn **Logs** on before testing a connection, then select **View Logs** to inspect or copy the latest 500 connection events. The same controls are available on the Setup screen while disconnected. Logs are local to the current Chrome profile and record connection steps, endpoint, result, and duration; service tokens and captured email contents are not logged.

Choose a country and starting record, then Start. For each country, set Date posted, Sort by, Content type, and From member directly in LinkedIn and select **Continue**. The extension captures the URL query parameters (except `keywords` and `origin`) as that country's filter profile and replays them for later records in the same country. **Use saved filters** reuses that country's stored profile; profiles older than today are marked stale. If LinkedIn does not expose filter parameters in the URL, the extension clearly switches to a per-record confirmation fallback. Filters lost during navigation pause the run and request recapture. Each country boundary waits for an explicit Continue, Skip country, or Stop action. Pause, Resume, and Stop preserve the run in the service, including the filter setup step.

LinkedIn filter-pill clicking is disabled by default. **Settings → Advanced → Automatic filter clicking (experimental)** opts into the legacy automation. **Debug filters** logs filter diagnostics to the browser console. For a post-discovery error, turn on **Enable scan diagnostics** before starting; after the error, click **Copy scan logs** on the LinkedIn control bar and share the copied JSON. Scan logs are local to the current Chrome profile and avoid post text, emails, author names, and URL identifiers; links are recorded only as route categories.

After filters verify, the extension scans the current query, up to the configured maximum of 50 scrolls per record (or until another stop limit is reached). It expands post text before reading it, extracts only explicitly present email-shaped strings, and can ignore configured generic local-part prefixes. A missing post permalink does not stop expansion, extraction, or scrolling. Such captures are saved with an empty post link, shown as **Link unavailable** in the tracker, and exported with a blank Post link field; an unsupported non-empty URL is still rejected by the service. Captures store the post text and URL when available, author, ISO and original date text, country/city, and email occurrence. A batch is saved transactionally with a per-batch idempotency key; transient service/network failures are retried up to three times with a short backoff. If saving still fails, the pending batch is copied to profile-local extension storage and the run pauses for an explicit retry so it cannot be overwritten by later unsaved batches.

Before saving a post, the extension requires at least one email address and then applies the checks in **Settings → Collecting**. Your LinkedIn search already finds posts about the job you want, so by default a post only has to **look like a job post**: it must contain at least one of the editable job words (for example hiring, vacancy, immediate joiner, send your CV). Optionally, a post can also be required to **match the record's search query**, and/or an **extra rule** that applies to every record (for example `"remote" OR "work from home"`). Rules support `AND`, `OR`, `NOT`, brackets, "quoted phrases" and `word*` prefixes; letter case and LinkedIn's bold Unicode letters are ignored, and words inside email addresses do not count. An invalid rule is reported and skipped rather than blocking every post. Skipped posts are counted as **Skipped by rule** in the live run, and the settings page has a tester for pasting a post and seeing which checks pass. Nothing is tied to a particular job or skill, and a new installation starts with no saved queries. Scrolling (scrolls per record, stop after scrolls with no new posts, posts per record, and wait between scrolls) is set in **Settings → Speed & limits → Scrolling**.

When **Continue through this country's records** is enabled, the service-locked run moves through enabled records in the selected country, in position order, with the configured randomized pause. It never switches countries automatically. LinkedIn login checks, captchas, and rate-limit notices stop the whole run. Daily post and per-run query caps stop scanning at their limits. View shows per-country progress, filter profiles, run and daily progress, current profile, last-saved time, and recent captures. History summaries and period exports use the selected day/week/month.

Runs are stored in SQLite and profile-local extension storage. On extension/browser restart, an active run is paused and can be resumed or discarded. Resume reuses processed post IDs; if its LinkedIn tab was closed, Resume opens a replacement. Multiple Chrome profiles can run independently, but the service grants a renewable ten-minute lock per query so only one profile scans a given query at a time. Email uniqueness is database-enforced across profiles.

The configured timezone determines the local day when a batch is saved; a run that crosses midnight continues and subsequent saves appear under the new date. A database backup is created before the first run each local day; **Backup now** creates one immediately. The service retains the newest 14 backup files.

## Tests

Run the storage service tests:

```powershell
npm run test:service
```

Run the extension API, component, email extraction, date conversion, scroll-loop, and batch-retry tests:

```powershell
npm run test:extension
```

Type-check the service:

```powershell
npm run typecheck:service
```

## Permanent data

The service owns `data\tracker.db` and creates timestamped, consistent SQLite backups in `data\backups\` through `POST /backup`. Database files, backups, environment configuration, and the installation token are excluded from version control. Extension reloads and reinstalls do not remove service-owned data.

Settings include timezone, starting country/query, profile label, retention preference, filter and scan delays, query pause/retry limits, per-query and daily safety caps, generic-address filtering, and the experimental automatic-filter option. Retention is stored as a preference but is not automatically enforced.

## Daily use

1. Open LinkedIn and sign in yourself. Navigate to a Posts search page; the compact extension control bar appears at the top right.
2. Select a country and starting record in the bar or View, leave **Try automatic filter clicking (experimental)** off, and choose **Start**.
3. Set the four filters manually in LinkedIn, then click **Continue** in the compact panel. Confirm the summary and that record 1 begins scanning.
4. Let record 1 finish. Confirm the next record uses the same captured parameters and the run stops at the last record of the country with the next country named. It must not start that next country until you click **Set filters & continue with ...**.
5. Start the same country again and choose **Use saved filters**. Verify the captured summary and capture date, then confirm the first record starts. Repeat with **Skip filters** and verify that no filter parameters are replayed.
6. Use Pause/Resume from the extension popup or View while **Set filters** is displayed. Then start another run, reload the extension while it is awaiting filters, and resume; it should return to the same setup step.
7. At a country boundary, verify the run remains stopped at **Country finished**. Choose **Set filters & continue with ...**, set that country's filters, and confirm the next country does not start before you continue.
8. If LinkedIn's URL does not include filter parameters, verify the fallback message and confirm filters once for each record. Filter loss after navigation is covered by the extension tests; if LinkedIn strips a captured parameter in the browser, verify that the run pauses with **Filters were lost. Set the filters again, then click Continue.**
9. Copy today's TSV or export today's/selected-period CSV from View or History.

Automation of LinkedIn pages and extraction of personal contact information may violate LinkedIn's terms or trigger account restrictions. Use conservative delays and limits, confirm you have a lawful basis to process the data, protect the database and backups, and never bypass login checks, captchas, rate limits, or other access controls.

## Backup and restore

Backups are SQLite-consistent snapshots in `data\backups\`. The automatic backup runs before the first new run each service-local day; manual backup is available in Settings. To restore, stop the service, make a separate copy of the current `data\tracker.db`, replace it with the selected backup file, then restart the service and verify the Home summary. Keep restore files private and do not overwrite the only copy of the current database.

## Troubleshooting

- **One-time setup screen:** the native host is not registered. Run `native-host\install.ps1`, then restart Chrome.
- **Could not connect / service did not start:** select **Retry**. If it keeps failing, check `data\logs\service.log`. Port 4317 must be free.
- **403 / blocked extension origin:** the extension was loaded from a different folder. Run `native-host\install.ps1` again, end the background `node.exe` service process, then click **Not connected · Reconnect** in the header.
- **Query locked:** another profile may currently be scanning it; wait for that run to finish or pause, or continue to the next enabled record.
- **LinkedIn security notice:** the run stops. Resolve any account notice manually; do not attempt automatic retries or bypasses.
- **Database/disk error:** check free disk space and permissions on `data\` and `data\backups\`; failed saves are reported and are not counted as successful.
- **Search page does not respond:** ensure Chrome is signed in, keep the LinkedIn Posts search tab open, and resume to reopen a closed tab. LinkedIn may change its page controls, so verify filters and post selectors manually.
