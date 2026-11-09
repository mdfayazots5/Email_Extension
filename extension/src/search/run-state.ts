import type { SearchRunState } from "../api/types";

export type RunAction = "start" | "pause" | "resume" | "stop" | "error" | "filters_captured" | "country_complete";

export function transitionRun(status: SearchRunState["status"], action: RunAction): SearchRunState["status"] {
  const allowed: Record<SearchRunState["status"], RunAction[]> = {
    running: ["pause", "stop", "error", "country_complete"],
    paused: ["resume", "stop", "error"],
    awaiting_filters: ["filters_captured", "pause", "stop", "error"],
    country_completed: ["start", "stop"],
    stopped: ["start"],
    error: ["start"],
    query_completed: ["start"],
    completed: ["start"]
  };
  if (!allowed[status].includes(action)) return status;
  if (action === "filters_captured") return "running";
  if (action === "country_complete") return "country_completed";
  if (action === "start" || action === "resume") return "running";
  if (action === "pause") return "paused";
  if (action === "stop") return "stopped";
  return "error";
}

export function resumeRunStatus(
  status: SearchRunState["status"],
  stage: SearchRunState["stage"]
): SearchRunState["status"] {
  if (status !== "paused") return status;
  return stage === "awaiting_filters" ? "awaiting_filters" : "running";
}
