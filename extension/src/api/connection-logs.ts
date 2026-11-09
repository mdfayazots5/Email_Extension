export type ConnectionLogEntry = {
  timestamp: string;
  event: string;
  details: Record<string, string | number | boolean | null>;
};

const ENABLED_KEY = "connectionLogsEnabled";
const ENTRIES_KEY = "connectionLogs";
const MAX_ENTRIES = 500;

let writes = Promise.resolve();

export async function recordConnectionLog(
  event: string,
  details: ConnectionLogEntry["details"] = {}
): Promise<void> {
  writes = writes.then(async () => {
    const state = await chrome.storage.local.get([ENABLED_KEY, ENTRIES_KEY]);
    if (state[ENABLED_KEY] !== true) return;
    const entries = Array.isArray(state[ENTRIES_KEY])
      ? state[ENTRIES_KEY] as ConnectionLogEntry[]
      : [];
    entries.push({ timestamp: new Date().toISOString(), event, details });
    await chrome.storage.local.set({ [ENTRIES_KEY]: entries.slice(-MAX_ENTRIES) });
  }).catch((error: unknown) => {
    console.error("Unable to save connection diagnostic log:", error);
  });
  await writes;
}

export async function readConnectionLogs(): Promise<ConnectionLogEntry[]> {
  const state = await chrome.storage.local.get(ENTRIES_KEY);
  if (!Array.isArray(state[ENTRIES_KEY])) return [];
  return (state[ENTRIES_KEY] as ConnectionLogEntry[]).slice(-MAX_ENTRIES);
}
