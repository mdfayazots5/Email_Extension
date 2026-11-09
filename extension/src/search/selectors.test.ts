import { describe, expect, it } from "vitest";
import { safetyPatterns } from "./selectors";

describe("LinkedIn safety notices", () => {
  it("recognizes unusual search traffic restrictions", () => {
    const notice = "Our systems have detected unusual search traffic coming from your account.";
    expect(safetyPatterns.some((pattern) => pattern.test(notice))).toBe(true);
  });
});
