import { selectorSets } from "./selectors";

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function findExpandableTextButton(post: HTMLElement): HTMLElement | null {
  const buttons = [...post.querySelectorAll<HTMLElement>(selectorSets.expandButtons)];
  return buttons.find((button) => button.getAttribute("data-testid") === "expandable-text-button")
    ?? buttons.find((button) => {
      const label = normalize([
        button.getAttribute("aria-label") ?? "",
        button.getAttribute("title") ?? "",
        button.innerText || button.textContent || ""
      ].join(" "));
      return label === "see more" || /^(?:…|\.{3})\s*more$/.test(label);
    })
    ?? null;
}
