import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConnectionLogs, recordConnectionLog } from "./connection-logs";

describe("connection diagnostics", () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = { connectionLogsEnabled: true, connectionLogs: [] };
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.map((key) => [key, storage[key]]));
          }),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(storage, values);
          })
        }
      }
    });
  });

  it("stores connection events only when logging is enabled", async () => {
    storage.connectionLogsEnabled = false;
    await recordConnectionLog("request_started", { endpoint: "/health" });
    expect(await readConnectionLogs()).toEqual([]);

    storage.connectionLogsEnabled = true;
    await recordConnectionLog("request_succeeded", { status: 200 });
    expect(await readConnectionLogs()).toMatchObject([
      { event: "request_succeeded", details: { status: 200 } }
    ]);
  });

  it("keeps only the latest 500 entries", async () => {
    storage.connectionLogs = Array.from({ length: 500 }, (_, index) => ({
      timestamp: new Date(0).toISOString(),
      event: `event-${index}`,
      details: {}
    }));
    await recordConnectionLog("latest");
    const entries = await readConnectionLogs();
    expect(entries).toHaveLength(500);
    expect(entries[0].event).toBe("event-1");
    expect(entries[499].event).toBe("latest");
  });
});
