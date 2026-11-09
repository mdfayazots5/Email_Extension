import type { CountryFilterProfile } from "../api/types";
import { summarizeFilterParams } from "./search-url";

export type FilterChoice = "capture" | "saved" | "skip" | "continue";

export function resolveFilterChoice(
  choice: FilterChoice,
  capturedParams: string,
  fallbackActive: boolean,
  currentSummary: string,
  savedProfile?: CountryFilterProfile
): { params: string; summary: string; fallback: boolean; saveProfile: boolean } {
  if (choice === "skip") {
    return { params: "", summary: "Filters skipped", fallback: false, saveProfile: false };
  }
  if (choice === "saved") {
    if (!savedProfile) throw new Error("No saved country filter profile is available.");
    if (!savedProfile.params) throw new Error("This saved profile has no replayable URL filters. Set filters manually on LinkedIn for this run.");
    return {
      params: savedProfile.params,
      summary: savedProfile.summary,
      fallback: false,
      saveProfile: false
    };
  }
  if (choice === "continue" && fallbackActive) {
    return {
      params: "",
      summary: currentSummary || "LinkedIn UI filters · current tab only",
      fallback: true,
      saveProfile: false
    };
  }
  return {
    params: capturedParams,
    summary: capturedParams ? summarizeFilterParams(capturedParams) : "LinkedIn UI filters · current tab only",
    fallback: !capturedParams,
    saveProfile: true
  };
}

export function canUseAutomaticFilterClick(enabled: boolean): boolean {
  return enabled;
}

export function canStartAfterFallbackNavigation(fallbackActive: boolean, confirmedForRecord: boolean): boolean {
  return fallbackActive && confirmedForRecord;
}
