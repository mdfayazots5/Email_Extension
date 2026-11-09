import { describe, expect, it } from "vitest";
import { retryTransientSave, saveBatchWithSafetyCopy } from "./safe-batch-save";

describe("batch save safety copy", () => {
  it("retries transient service failures and returns when a later attempt succeeds", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const result = await retryTransientSave(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("Temporary service failure");
        return "saved";
      },
      () => true,
      async (milliseconds) => { waits.push(milliseconds); }
    );
    expect(result).toBe("saved");
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("does not retry non-transient validation failures", async () => {
    let attempts = 0;
    await expect(retryTransientSave(
      async () => {
        attempts++;
        throw new Error("Invalid request");
      },
      () => false,
      async () => undefined
    )).rejects.toThrow("Invalid request");
    expect(attempts).toBe(1);
  });

  it("reports when the safety copy itself cannot be persisted", async () => {
    const result = await saveBatchWithSafetyCopy(
      "batch-1",
      { save: async () => { throw new Error("Storage unavailable"); }, remove: async () => undefined },
      async () => ({ saved: true }),
      async () => undefined
    );
    expect(result).toMatchObject({ ok: false, safetyCopySaved: false, error: new Error("Storage unavailable") });
  });

  it("keeps an unsent batch when the service is offline and removes it after retry", async () => {
    const storage = new Map<string, string>();
    const store = {
      save: async (batch: string) => { storage.set("pending", batch); },
      remove: async () => { storage.delete("pending"); }
    };
    const offline = await saveBatchWithSafetyCopy(
      "batch-1",
      store,
      async () => { throw new Error("Service offline"); },
      async () => undefined
    );
    expect(offline).toMatchObject({ ok: false, error: new Error("Service offline") });
    expect(storage.get("pending")).toBe("batch-1");

    const retry = await saveBatchWithSafetyCopy(
      storage.get("pending")!,
      store,
      async (batch) => ({ saved: batch }),
      async () => undefined
    );
    expect(retry).toEqual({ ok: true, result: { saved: "batch-1" } });
    expect(storage.has("pending")).toBe(false);
  });
});
