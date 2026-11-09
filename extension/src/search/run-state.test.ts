import { describe, expect, it } from "vitest";
import { resumeRunStatus, transitionRun } from "./run-state";

describe("search run state transitions", () => {
  it("supports Start → Pause → Resume → Stop", () => {
    const started = transitionRun("stopped", "start");
    const paused = transitionRun(started, "pause");
    const resumed = transitionRun(paused, "resume");
    const stopped = transitionRun(resumed, "stop");
    expect([started, paused, resumed, stopped]).toEqual(["running", "paused", "running", "stopped"]);
  });

  it("does not allow illegal transitions", () => {
    expect(transitionRun("stopped", "pause")).toBe("stopped");
    expect(transitionRun("error", "resume")).toBe("error");
    expect(transitionRun("query_completed", "start")).toBe("running");
  });

  it("resumes an interrupted filter setup at the same step", () => {
    expect(resumeRunStatus("paused", "awaiting_filters")).toBe("awaiting_filters");
    expect(resumeRunStatus("paused", "scanning")).toBe("running");
    expect(transitionRun("awaiting_filters", "filters_captured")).toBe("running");
    expect(transitionRun("running", "country_complete")).toBe("country_completed");
  });
});
