import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { findExpandableTextButton } from "./post-expansion";

describe("expandable post text control", () => {
  it("finds LinkedIn's expandable-text-button even when its label contains an ellipsis and space", () => {
    const dom = new JSDOM(`
      <article>
        <button type="button" aria-hidden="true" data-testid="expandable-text-button">
          <span>… <span>more</span></span>
        </button>
      </article>
    `);

    expect(findExpandableTextButton(dom.window.document.querySelector("article")!))
      .toBe(dom.window.document.querySelector("[data-testid='expandable-text-button']"));
  });

  it("recognizes the visible See more and ellipsis labels without depending on classes", () => {
    for (const label of ["See more", "... more", "…more"]) {
      const dom = new JSDOM(`<article><button>${label}</button></article>`);
      expect(findExpandableTextButton(dom.window.document.querySelector("article")!))
        .toBe(dom.window.document.querySelector("button"));
    }
  });

  it("does not mistake unrelated post buttons for expand controls", () => {
    const dom = new JSDOM("<article><button>Like</button><button>Share</button></article>");

    expect(findExpandableTextButton(dom.window.document.querySelector("article")!)).toBeNull();
  });
});
