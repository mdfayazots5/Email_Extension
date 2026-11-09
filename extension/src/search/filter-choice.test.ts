import { describe, expect, it } from "vitest";
import { canStartAfterFallbackNavigation, canUseAutomaticFilterClick, resolveFilterChoice } from "./filter-choice";
import type { CountryFilterProfile } from "../api/types";

const savedProfile: CountryFilterProfile = {
  country_code: "GB",
  params: "datePosted=%22past-week%22&sortBy=%22date_posted%22",
  summary: "Past week · Latest · All content",
  captured_at: "2026-10-25T00:00:00.000Z",
  profile_id: "profile-1"
};

describe("manual filter choices", () => {
  it("uses saved filters only after explicit selection", () => {
    expect(resolveFilterChoice("saved", "", false, "", savedProfile)).toMatchObject({
      params: savedProfile.params,
      summary: savedProfile.summary,
      fallback: false,
      saveProfile: false
    });
  });

  it("rejects saved profiles that contain no replayable filter parameters", () => {
    expect(() => resolveFilterChoice("saved", "", false, "", {
      ...savedProfile,
      params: ""
    })).toThrow("no replayable URL filters");
  });

  it("supports skip and URL-unavailable confirmation paths", () => {
    expect(resolveFilterChoice("skip", "ignored=1", false, "")).toEqual({
      params: "", summary: "Filters skipped", fallback: false, saveProfile: false
    });
    expect(resolveFilterChoice("capture", "", false, "")).toMatchObject({
      params: "", fallback: true, saveProfile: true
    });
    expect(resolveFilterChoice("continue", "", true, "LinkedIn UI filters · current tab only")).toMatchObject({
      params: "", fallback: true, saveProfile: false
    });
  });

  it("does not permit automatic filter clicks unless the experimental setting is enabled", () => {
    expect(canUseAutomaticFilterClick(false)).toBe(false);
    expect(canUseAutomaticFilterClick(true)).toBe(true);
  });

  it("starts a fallback record after its filters were confirmed before navigation", () => {
    expect(canStartAfterFallbackNavigation(true, true)).toBe(true);
    expect(canStartAfterFallbackNavigation(true, false)).toBe(false);
    expect(canStartAfterFallbackNavigation(false, true)).toBe(false);
  });
});
