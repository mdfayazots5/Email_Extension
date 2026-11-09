import type { FilterResult } from "../api/types";
import { filterPillLabels, filterValueAliases, selectorSets, sortFilterPillValues } from "./selectors";

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s:·•]+/g, " ").trim();
}

export function filterOptionMatchesValue(
  option: HTMLElement,
  expected: string,
  aliases: string[] = []
): boolean {
  const wanted = [expected, ...aliases].map(normalize);
  const labels = [
    option.getAttribute("aria-label") ?? "",
    option.getAttribute("title") ?? "",
    option.textContent ?? ""
  ].map(normalize).filter(Boolean);
  return labels.some((actual) =>
    wanted.some((value) => actual === value || actual.startsWith(`${value} `) || actual.endsWith(` ${value}`))
  );
}

export function isFilterOptionSelected(option: HTMLElement): boolean {
  return option.getAttribute("aria-checked") === "true"
    || option.getAttribute("aria-selected") === "true"
    || Boolean(option.querySelector<HTMLInputElement>("input[type='radio'], input[type='checkbox']")?.checked);
}

export function filterChipMatches(expected: string, chips: string[]): boolean {
  const candidates = [expected, ...(filterValueAliases[expected] ?? [])].map(normalize);
  return chips.some((chip) => {
    const value = normalize(chip);
    return candidates.some((candidate) => value === candidate || value.endsWith(` ${candidate}`));
  });
}

export function getActiveFilterChipTexts(
  root: ParentNode,
  isVisible: (element: Element) => boolean = () => true
): string[] {
  return [...root.querySelectorAll<HTMLElement>(selectorSets.chips)]
    .filter(isVisible)
    .map((element) => [
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? "",
      element.textContent ?? ""
    ].join(" ").trim())
    .filter(Boolean);
}

export function findFilterPill(
  root: ParentNode,
  key: FilterResult["key"],
  isVisible: (element: Element) => boolean = () => true
): HTMLElement | null {
  const labels = filterPillLabels[key].map(normalize);
  return [...root.querySelectorAll<HTMLElement>(selectorSets.filterPills)]
    .find((element) => {
      if (!isVisible(element)) return false;
      const label = getFilterPillLabel(element);
      return label !== null && labels.includes(normalize(label));
    }) ?? null;
}

export function getFilterPillLabel(pill: HTMLElement): string | null {
  const ariaLabel = pill.matches("[aria-label^='Filter by ']")
    ? pill.getAttribute("aria-label")
    : pill.querySelector<HTMLElement>("[aria-label^='Filter by ']")?.getAttribute("aria-label");
  if (ariaLabel && normalize(ariaLabel) !== normalize("Filter by Sort by")) return ariaLabel;

  const visibleText = normalize(pill.innerText || pill.textContent || "");
  if (visibleText.includes("top match")) return "Filter by Top Match";
  if (visibleText.includes("latest")) return "Filter by Latest";
  if (ariaLabel) return ariaLabel;
  const knownSortLabel = filterPillLabels.sort_by.find((label) =>
    visibleText === normalize(label.replace(/^Filter by /, ""))
  );
  return knownSortLabel ?? null;
}

export function filterPillMatchesValue(
  key: FilterResult["key"],
  expected: string,
  pill: HTMLElement | null
): boolean {
  if (key !== "sort_by" || !pill) return false;
  return normalize(getFilterPillLabel(pill) ?? "") === normalize(sortFilterPillValues[expected] ?? "");
}

export function filterIsAlreadyApplied(
  key: FilterResult["key"],
  expected: string,
  pill: HTMLElement | null,
  chips: string[]
): boolean {
  return filterChipMatches(expected, chips) || filterPillMatchesValue(key, expected, pill);
}

export function verifyFilterChip(
  key: FilterResult["key"],
  label: string,
  expected: string,
  chips: string[],
  requested = true
): FilterResult {
  if (!requested) return { key, label, expected: "Any", status: "not_requested" };
  const applied = filterChipMatches(expected, chips);
  return {
    key,
    label,
    expected,
    status: applied ? "applied" : "not_applied",
    message: applied ? "Matching active filter is visible." : "Matching active filter chip was not found."
  };
}
