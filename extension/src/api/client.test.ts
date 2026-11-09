// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, TrackerApi, type TokenStore } from "./client";
import { readConnectionLogs } from "./connection-logs";

const tokens: TokenStore = { get: async () => "test-token" };

beforeEach(() => {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ connectionLogsEnabled: false }),
        set: vi.fn().mockResolvedValue(undefined)
      }
    }
  });
});

describe("TrackerApi errors", () => {
  it("calls the browser fetch function with its required global context", async () => {
    const fetcher = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(
        JSON.stringify({ status: "ok", database: "connected", timezone: "UTC" }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(new TrackerApi(tokens).health()).resolves.toMatchObject({ status: "ok" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps offline errors to a clear message", async () => {
    const api = new TrackerApi(tokens, vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(api.health()).rejects.toMatchObject({
      kind: "offline",
      message: "Could not reach the tracker service."
    });
  });

  it("records the browser fetch failure reason without request headers", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            serviceToken: "test-token",
            connectionLogsEnabled: true,
            connectionLogs: []
          }),
          set: vi.fn().mockResolvedValue(undefined)
        }
      }
    });
    const api = new TrackerApi(tokens, vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.health()).rejects.toBeInstanceOf(ApiError);
    const entries = await readConnectionLogs();
    expect(entries.at(-1)).toMatchObject({
      event: "request_failed",
      details: {
        reason: "network_or_cors_error",
        error_name: "TypeError",
        error_message: "Failed to fetch"
      }
    });
  });

  it("maps unauthorized responses to a token error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Missing or invalid service token" }),
      { status: 401, headers: { "content-type": "application/json" } }
    ));
    const api = new TrackerApi(tokens, fetcher);
    await expect(api.health()).rejects.toMatchObject({
      kind: "unauthorized",
      message: "The tracker service rejected the saved token."
    });
  });

  it("preserves validation error details", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Invalid request", details: [{ path: ["label"] }] }),
      { status: 400, headers: { "content-type": "application/json" } }
    ));
    const api = new TrackerApi(tokens, fetcher);
    try {
      await api.health();
      throw new Error("Expected API request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ kind: "validation", details: [{ path: ["label"] }] });
    }
  });
});

const okHealth = () => new Response(
  JSON.stringify({ status: "ok", database: "connected", timezone: "UTC" }),
  { status: 200, headers: { "content-type": "application/json" } }
);

describe("TrackerApi automatic service start", () => {
  it("asks the native host for a token when none is saved", async () => {
    const store: TokenStore = { get: async () => "", refresh: vi.fn().mockResolvedValue("host-token") };
    const fetcher = vi.fn().mockResolvedValue(okHealth());
    await expect(new TrackerApi(store, fetcher).health()).resolves.toMatchObject({ status: "ok" });
    expect(store.refresh).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer host-token");
  });

  it("starts the service and retries once when it is not running", async () => {
    const store: TokenStore = { get: async () => "old-token", refresh: vi.fn().mockResolvedValue("new-token") };
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okHealth());
    await expect(new TrackerApi(store, fetcher).health()).resolves.toMatchObject({ status: "ok" });
    expect(store.refresh).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe("Bearer new-token");
  });

  it("does not retry validation errors", async () => {
    const store: TokenStore = { get: async () => "token", refresh: vi.fn() };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    await expect(new TrackerApi(store, fetcher).health()).rejects.toMatchObject({ kind: "validation" });
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it("explains the one-time install when the native host is missing", async () => {
    const { ensureService, HOST_NOT_INSTALLED_MESSAGE } = await import("./client");
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
      runtime: { sendNativeMessage: vi.fn().mockRejectedValue(new Error("Specified native messaging host not found.")) }
    });
    await expect(ensureService()).rejects.toMatchObject({ kind: "offline", message: HOST_NOT_INSTALLED_MESSAGE });
  });
});
