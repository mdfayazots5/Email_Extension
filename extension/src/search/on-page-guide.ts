import { LINKEDIN_TOUR, type LinkedInTourStep } from "../guide/guide-content";
import { markSeen, readGuideState } from "../guide/guide-state";

export const BAR_GUIDE_CSS = `
  .head-actions { display: flex; gap: 4px; }
  .help { min-width: 24px; min-height: 22px; padding: 0 6px; border-radius: 999px; font-weight: 700; }
  .collapse { min-height: 22px; }
  .tour-target { outline: 3px solid #f0aa31 !important; outline-offset: 2px; position: relative; z-index: 1; }
  .tip { margin: 4px 8px 8px; padding: 8px 9px; border: 1px solid #f0aa31; border-radius: 8px; background: #fff8e8; color: #3a2a05; }
  .tip strong { display: block; margin-bottom: 3px; font-size: 11px; }
  .tip p { margin: 0 0 6px; font-size: 11px; line-height: 1.4; }
  .tip-actions { display: flex; align-items: center; gap: 5px; }
  .tip-count { margin-right: auto; font-size: 10px; opacity: .8; }
  .tip button { min-height: 23px; padding: 2px 8px; }
  @media (prefers-color-scheme: dark) {
    .tip { background: #33290f; color: #fbe9bf; border-color: #b98a2c; }
  }
`;

type Targets = Record<LinkedInTourStep["target"], HTMLElement>;

/**
 * Step-by-step tips inside the LinkedIn control bar. Shows once per Chrome profile
 * (until tips are reset in the tracker), and again whenever the ? button is pressed.
 */
export function attachBarGuide(container: HTMLElement, targets: Targets, help: HTMLButtonElement): { show: () => void } {
  const tip = document.createElement("section");
  tip.className = "tip hidden";
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-label", "Control bar tips");
  tip.innerHTML = `<strong class="tip-title"></strong><p class="tip-body"></p>
    <div class="tip-actions"><span class="tip-count"></span><button class="tip-skip" type="button">Skip</button><button class="tip-back" type="button">Back</button><button class="tip-next primary" type="button">Next</button></div>`;
  container.append(tip);
  const title = tip.querySelector<HTMLElement>(".tip-title")!;
  const body = tip.querySelector<HTMLElement>(".tip-body")!;
  const count = tip.querySelector<HTMLElement>(".tip-count")!;
  const back = tip.querySelector<HTMLButtonElement>(".tip-back")!;
  const next = tip.querySelector<HTMLButtonElement>(".tip-next")!;
  const skip = tip.querySelector<HTMLButtonElement>(".tip-skip")!;
  let index = -1;

  const clearHighlight = () => Object.values(targets).forEach((element) => element.classList.remove("tour-target"));

  const showStep = () => {
    clearHighlight();
    const step = LINKEDIN_TOUR[index];
    title.textContent = step.title;
    body.textContent = step.body;
    count.textContent = `${index + 1} of ${LINKEDIN_TOUR.length}`;
    back.classList.toggle("hidden", index === 0);
    next.textContent = index === LINKEDIN_TOUR.length - 1 ? "Done" : "Next";
    targets[step.target].classList.add("tour-target");
    tip.classList.remove("hidden");
  };

  const finish = () => {
    clearHighlight();
    tip.classList.add("hidden");
    index = -1;
    void markSeen("linkedin");
  };

  next.addEventListener("click", () => {
    if (index >= LINKEDIN_TOUR.length - 1) finish();
    else { index += 1; showStep(); }
  });
  back.addEventListener("click", () => { index = Math.max(0, index - 1); showStep(); });
  skip.addEventListener("click", finish);

  const show = () => { index = 0; showStep(); };
  help.addEventListener("click", () => (index >= 0 ? finish() : show()));

  void readGuideState().then((state) => { if (!state.seen.linkedin) show(); });
  return { show };
}
