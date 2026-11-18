// Native messaging host for the Email Extension (Windows).
//
// Chrome starts this script on demand through host.bat (written by install.ps1).
// On an "ensure" request it makes sure the local storage service is running,
// starting it hidden and outside Chrome's process tree when needed, and returns
// the service token so the extension never asks the user to paste it. Every Chrome
// profile of the current Windows user reaches the same host, so all profiles share
// one service and one SQLite database.
//
// Chrome reads framed messages from stdout: never print anything else to stdout.

import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_URL = "http://127.0.0.1:4317";
const START_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceDirectory = path.join(root, "service");
const tokenPath = path.join(serviceDirectory, "token.txt");
const dataDirectory = path.join(root, "data");
const logDirectory = path.join(dataDirectory, "logs");
const logPath = path.join(logDirectory, "service.log");
const lockPath = path.join(dataDirectory, ".ensure.lock");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (token, started) => ({ ok: true, token, baseUrl: SERVICE_URL, started });
const fail = (error) => ({ ok: false, error });

// ---- Chrome native messaging framing: 4-byte little-endian length, then UTF-8 JSON.

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return new Promise((resolve) => process.stdout.write(Buffer.concat([header, body]), () => resolve()));
}

async function* readMessages() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_MESSAGE_BYTES) throw new Error("Invalid message length.");
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      yield JSON.parse(body.toString("utf8"));
    }
  }
}

// ---- Service checks.

function readToken() {
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

async function health(token) {
  try {
    const response = await fetch(`${SERVICE_URL}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000)
    });
    if (response.status === 401) return { result: "unauthorized" };
    if (!response.ok) return { result: "unreachable" };
    const body = await response.json();
    const startedAt = Date.parse(body?.started_at ?? "");
    return { result: "ok", pid: Number(body?.pid) || 0, startedAt: Number.isNaN(startedAt) ? null : startedAt };
  } catch {
    return { result: "unreachable" };
  }
}

function newestSourceTime(folder) {
  let newest = 0;
  if (!existsSync(folder)) return newest;
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    newest = Math.max(newest, statSync(path.join(entry.parentPath ?? entry.path, entry.name)).mtimeMs);
  }
  return newest;
}

// True when service code changed (for example after update.bat) after the running service started.
function isOutdated(info) {
  if (!info.startedAt || info.pid <= 0) return false;
  const newest = Math.max(newestSourceTime(path.join(serviceDirectory, "src")), newestSourceTime(path.join(root, "shared")));
  return newest > info.startedAt;
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, ...options }, (error, stdout, stderr) =>
      resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}

async function processName(pid) {
  const { stdout } = await run("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const match = /^"([^"]+)"/.exec(stdout.trim());
  return match ? match[1].toLowerCase() : null;
}

// Stops the running service and waits for port 4317 to free up. Returns false if it could not.
async function stopService(pid, token) {
  const name = await processName(pid);
  if (name && name !== "node.exe") return false;
  if (name) await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await health(token)).result === "unreachable") return true;
    await sleep(200);
  }
  return false;
}

// ---- Starting the service.

function findTsx() {
  for (const candidate of [
    path.join(serviceDirectory, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs")
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Service packages are missing. Double-click install.bat in the project folder again.");
}

function prepareLog() {
  mkdirSync(logDirectory, { recursive: true });
  try {
    if (existsSync(logPath) && statSync(logPath).size > 5 * 1024 * 1024) renameSync(logPath, `${logPath}.old`);
  } catch {
    /* Keep appending to the current log. */
  }
}

// Win32_Process.Create starts the service outside Chrome's job object and process tree,
// without a window and without the native-messaging pipes, so it keeps running after
// this host exits and is not tied to the Chrome window that asked for it.
async function startService() {
  const tsx = findTsx();
  prepareLog();
  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const command =
    `cmd.exe /d /s /c "echo [${stamp}] Starting tracker service >> "${logPath}" && ` +
    `"${process.execPath}" "${tsx}" src/index.ts >> "${logPath}" 2>&1"`;
  const script =
    "$ErrorActionPreference = 'Stop';" +
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 };" +
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:TRACKER_COMMAND; CurrentDirectory = $env:TRACKER_DIRECTORY; ProcessStartupInformation = $startup };" +
    "if ($result.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($result.ReturnValue)\" }";
  const { error, stderr } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env: { ...process.env, TRACKER_COMMAND: command, TRACKER_DIRECTORY: serviceDirectory } }
  );
  if (error) throw new Error(`Could not start the tracker service: ${(stderr || error.message).trim().slice(0, 300)}`);
}

// ---- Cross-profile lock: two profiles may open the extension at the same moment.

async function withLock(action) {
  mkdirSync(dataDirectory, { recursive: true });
  const deadline = Date.now() + START_TIMEOUT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 2 * START_TIMEOUT_MS) rmSync(lockPath, { force: true });
      } catch {
        /* Removed by its owner meanwhile. */
      }
      if (Date.now() > deadline) break; // Proceed anyway; the service tolerates a second start attempt.
      await sleep(250);
    }
  }
  try {
    return await action();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}

async function ensure() {
  return withLock(async () => {
    let token = readToken();
    const info = token ? await health(token) : { result: "unreachable" };
    if (info.result === "ok") {
      // After an update the old service keeps running; replace it with the new code.
      if (!isOutdated(info) || !(await stopService(info.pid, token))) return ok(token, false);
    }
    if (info.result === "unauthorized") {
      return fail("Port 4317 is used by a service with a different token. Close the other tracker service window and try again.");
    }

    await startService();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      token = readToken();
      if (token && (await health(token)).result === "ok") return ok(token, true);
    }
    return fail("The tracker service did not start within 30 seconds. See data\\logs\\service.log in the project folder.");
  });
}

async function handle(request) {
  switch (request?.type) {
    case "ensure":
      return ensure();
    case "ping":
      return { ok: true, version: 2 };
    default:
      return fail(`Unsupported request '${request?.type}'.`);
  }
}

try {
  for await (const request of readMessages()) {
    let response;
    try {
      response = await handle(request);
    } catch (error) {
      response = fail(error instanceof Error ? error.message : String(error));
    }
    await writeMessage(response);
  }
  process.exit(0);
} catch (error) {
  try {
    await writeMessage(fail(error instanceof Error ? error.message : String(error)));
  } catch {
    /* Chrome already disconnected. */
  }
  process.exit(1);
}
