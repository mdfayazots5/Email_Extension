import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGuideState, GUIDE_STATE_KEY, markSeen, markWelcomeDone, readGuideState, resetGuide } from "./guide-state";
import { addSampleQueries, SAMPLE_QUERIES } from "./sample-queries";
import { PAGE_TOURS, WELCOME_STEPS } from "./guide-content";
import type { QueryRecord } from "../api/types";

let store: Record<string, unknown>;
let failing = false;

beforeEach(() => {
  store = {};
  failing = false;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (failing) throw new Error("storage unavailable");
          return key in store ? { [key]: store[key] } : {};
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          if (failing) throw new Error("storage unavailable");
          Object.assign(store, structuredClone(values));
        })
      }
    }
  });
});

describe("guide state", () => {
  it("starts with nothing seen", async () => {
    expect(await readGuideState()).toEqual(defaultGuideState());
  });

  it("remembers the welcome guide and each page, and resets", async () => {
    await markWelcomeDone();
    await markSeen("queries");
    await markSeen("linkedin");
    const state = await readGuideState();
    expect(state.welcomeDone).toBe(true);
    expect(state.seen).toMatchObject({ queries: true, linkedin: true, view: false });

    await resetGuide();
    expect(await readGuideState()).toEqual(defaultGuideState());
  });

  it("ignores malformed stored values", async () => {
    store[GUIDE_STATE_KEY] = { welcomeDone: "yes", seen: { view: 1, history: true } };
    const state = await readGuideState();
    expect(state.welcomeDone).toBe(false);
    expect(state.seen).toMatchObject({ view: false, history: true });
  });

  it("never throws when storage fails", async () => {
    failing = true;
    expect(await readGuideState()).toEqual(defaultGuideState());
    await expect(markSeen("view")).resolves.toBeDefined();
  });
});

const record = (country_code: string, label: string, position: number): QueryRecord => ({
  id: position + 1, country_code, label, query_text: "x", position, enabled: true, notes: "", created_at: "", updated_at: ""
});

describe("sample queries", () => {
  it("meet the same rules the service validates", () => {
    for (const sample of SAMPLE_QUERIES) {
      expect(sample.country_code).toMatch(/^[A-Z]{2,3}$/);
      expect(sample.label.length).toBeGreaterThan(0);
      expect(sample.label.length).toBeLessThanOrEqual(120);
      expect(sample.query_text.length).toBeLessThanOrEqual(2000);
      expect(sample.notes.length).toBeLessThanOrEqual(4000);
    }
  });

  it("adds missing samples after existing records and skips duplicates", async () => {
    const created: Array<{ country_code: string; label: string; position: number }> = [];
    const api = { createQuery: vi.fn(async (input: QueryRecord) => { created.push(input); return input; }) };
    const existing = [record("IN", "bengaluru", 0), record("IN", "Pune", 4)];

    const added = await addSampleQueries(api as never, existing);

    expect(added).toBe(SAMPLE_QUERIES.length - 1);
    expect(created.find((item) => item.label === "Bengaluru")).toBeUndefined();
    expect(created.find((item) => item.label === "Hyderabad")?.position).toBe(5);
    expect(created.find((item) => item.label === "Dubai")?.position).toBe(0);
  });
});

describe("guide content", () => {
  it("shows only example addresses in the demo previews and text", () => {
    const text = JSON.stringify({ WELCOME_STEPS, PAGE_TOURS });
    const emails = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g) ?? [];
    for (const email of emails) expect(email).toMatch(/@example\.(com|org|net)$/);
  });
});
