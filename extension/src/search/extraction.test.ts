import { describe, expect, it } from "vitest";
import { extractEmails, isGenericEmail, relativeDateToISO } from "./extraction";

describe("email extraction", () => {
  it("extracts valid, uppercase, punctuated and multiple addresses", () => {
    expect(extractEmails("Contact A@Example.com, or second.user@example.org!")).toEqual([
      { original: "A@Example.com", normalized: "a@example.com" },
      { original: "second.user@example.org", normalized: "second.user@example.org" }
    ]);
  });

  it("recognizes common at/dot obfuscations without inventing addresses", () => {
    expect(extractEmails("one [at] example [dot] com; two(at)example.org")).toEqual([
      { original: "one [at] example [dot] com", normalized: "one@example.com" },
      { original: "two(at)example.org", normalized: "two@example.org" }
    ]);
    expect(extractEmails("Contact Jane Smith for details")).toEqual([]);
  });

  it("rejects malformed addresses and identifies generic prefixes only", () => {
    expect(extractEmails("bad..name@example.com, no-domain@, @missing.com, x@y..com")).toEqual([]);
    expect(isGenericEmail("noreply@company.com", ["noreply", "no-reply", "donotreply"])).toBe(true);
    expect(isGenericEmail("person@gmail.com", ["noreply", "no-reply", "donotreply"])).toBe(false);
  });
});

describe("relative post dates", () => {
  const now = new Date(2026, 9, 25, 12);
  it.each([
    ["5m", "2026-10-25"],
    ["2h", "2026-10-25"],
    ["3d", "2026-10-22"],
    ["1w", "2026-10-18"],
    ["2mo", "2026-08-25"]
  ])("converts %s to %s", (relative, expected) => {
    expect(relativeDateToISO(relative, now)).toBe(expected);
  });
});
