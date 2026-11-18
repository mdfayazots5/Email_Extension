// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomeTour } from "./WelcomeTour";
import { PageTour } from "./PageTour";
import { WELCOME_STEPS } from "../guide/guide-content";

afterEach(cleanup);

describe("WelcomeTour", () => {
  it("moves with Next and Back and offers sample queries on the last step", () => {
    const onAddSamples = vi.fn();
    const onClose = vi.fn();
    render(<WelcomeTour onClose={onClose} onAddSamples={onAddSamples} onOpenQueries={vi.fn()} />);

    expect(screen.getByRole("heading", { name: WELCOME_STEPS[0].title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: WELCOME_STEPS[1].title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: WELCOME_STEPS[0].title })).toBeTruthy();

    for (let step = 1; step < WELCOME_STEPS.length; step += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Add sample queries" }));
    expect(onAddSamples).toHaveBeenCalledOnce();
  });

  it("closes with Skip tour", () => {
    const onClose = vi.fn();
    render(<WelcomeTour onClose={onClose} onAddSamples={vi.fn()} onOpenQueries={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("PageTour", () => {
  it("walks through the targets on the page and skips missing ones", () => {
    document.body.insertAdjacentHTML("beforeend", '<div data-tour="one"></div><div data-tour="three"></div>');
    const onDone = vi.fn();
    render(<PageTour onDone={onDone} steps={[
      { target: "one", title: "First", body: "a" },
      { target: "missing", title: "Missing", body: "b" },
      { target: "three", title: "Third", body: "c" }
    ]} />);

    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Third" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledOnce();
    document.querySelectorAll("[data-tour]").forEach((element) => element.remove());
  });

  it("ends at once when nothing on the page matches", () => {
    const onDone = vi.fn();
    render(<PageTour onDone={onDone} steps={[{ target: "nothing", title: "None", body: "x" }]} />);
    expect(onDone).toHaveBeenCalled();
  });
});
