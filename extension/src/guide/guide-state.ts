// Remembers which guides this Chrome profile has already seen.
// Every call tolerates storage failures: a guide may then show again, which is harmless.

export type GuidePage = "view" | "queries" | "history" | "settings" | "linkedin";

export type GuideState = {
  welcomeDone: boolean;
  seen: Record<GuidePage, boolean>;
};

export const GUIDE_STATE_KEY = "guideState";

export function defaultGuideState(): GuideState {
  return { welcomeDone: false, seen: { view: false, queries: false, history: false, settings: false, linkedin: false } };
}

function normalize(value: unknown): GuideState {
  const state = defaultGuideState();
  if (!value || typeof value !== "object") return state;
  const raw = value as Partial<GuideState>;
  state.welcomeDone = raw.welcomeDone === true;
  if (raw.seen && typeof raw.seen === "object") {
    for (const page of Object.keys(state.seen) as GuidePage[]) state.seen[page] = raw.seen[page] === true;
  }
  return state;
}

export async function readGuideState(): Promise<GuideState> {
  try {
    const stored = await chrome.storage.local.get(GUIDE_STATE_KEY);
    return normalize(stored[GUIDE_STATE_KEY]);
  } catch {
    return defaultGuideState();
  }
}

async function update(change: (state: GuideState) => void): Promise<GuideState> {
  const state = await readGuideState();
  change(state);
  try {
    await chrome.storage.local.set({ [GUIDE_STATE_KEY]: state });
  } catch {
    /* Storage unavailable: the guide may show again next time. */
  }
  return state;
}

export function markWelcomeDone(): Promise<GuideState> {
  return update((state) => { state.welcomeDone = true; });
}

export function markSeen(page: GuidePage): Promise<GuideState> {
  return update((state) => { state.seen[page] = true; });
}

export function resetGuide(): Promise<GuideState> {
  return update((state) => { Object.assign(state, defaultGuideState()); });
}
