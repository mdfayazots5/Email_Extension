import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { filterChipMatches, filterIsAlreadyApplied, filterOptionMatchesValue, isFilterOptionSelected, filterPillMatchesValue, findFilterPill, getActiveFilterChipTexts, verifyFilterChip } from "./filter-verification";
import { selectorSets } from "./selectors";

describe("filter chip verification", () => {
  it("matches normalized active chip labels and aliases", () => {
    expect(filterChipMatches("week", ["Date posted: Past week"])).toBe(true);
    expect(filterChipMatches("recent", ["Sort by · Most recent"])).toBe(true);
    expect(filterChipMatches("Videos", ["Videos"])).toBe(true);
  });

  it("does not accept a different value or a missing chip", () => {
    expect(filterChipMatches("week", ["Past month"])).toBe(false);
    expect(verifyFilterChip("date_posted", "Date posted", "week", []).status).toBe("not_applied");
    expect(verifyFilterChip("from_member", "From member", "", [], false).status).toBe("not_requested");
  });

  it("finds chips in a saved LinkedIn search-page fixture", () => {
    const fixturePath = path.join(import.meta.dirname, "fixtures", "linkedin-search.html");
    const dom = new JSDOM(readFileSync(fixturePath, "utf8"));
    const chips = getActiveFilterChipTexts(dom.window.document);
    expect(verifyFilterChip("date_posted", "Date posted", "week", chips).status).toBe("applied");
    expect(verifyFilterChip("sort_by", "Sort by", "recent", chips).status).toBe("applied");
    expect(verifyFilterChip("content_type", "Content type", "Videos", chips).status).toBe("applied");
  });

  it("uses accessible filter labels rather than hashed classes", () => {
    const fixturePath = path.join(import.meta.dirname, "fixtures", "linkedin-search.html");
    const dom = new JSDOM(readFileSync(fixturePath, "utf8"));
    const datePill = findFilterPill(dom.window.document, "date_posted");
    expect(datePill?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Filter by Date posted");
    expect(findFilterPill(dom.window.document, "content_type")?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Filter by Content type");
    expect(findFilterPill(dom.window.document, "from_member")?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Filter by From member");
    expect(findFilterPill(dom.window.document, "sort_by")?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Filter by Top Match");
    expect(selectorSets.filterPills).not.toMatch(/class|componentkey/i);
    expect(selectorSets.postsTab).not.toMatch(/class|componentkey/i);
    expect(selectorSets.searchInput).toBe("[data-testid='typeahead-input'][placeholder='Search']");
    datePill?.setAttribute("class", "completely-different-hash");
    expect(findFilterPill(dom.window.document, "date_posted")).toBe(datePill);
  });

  it("matches the sort pill when LinkedIn labels it Top Match or Latest", () => {
    const dom = new JSDOM("<main><div role='button'><div aria-label='Filter by Top Match'>Top Match</div></div></main>");
    const pill = findFilterPill(dom.window.document, "sort_by");
    expect(filterPillMatchesValue("sort_by", "relevance", pill)).toBe(true);
    expect(filterPillMatchesValue("sort_by", "recent", pill)).toBe(false);
    pill?.querySelector("[aria-label]")?.setAttribute("aria-label", "Filter by Latest");
    expect(filterPillMatchesValue("sort_by", "recent", pill)).toBe(true);
  });

  it("finds LinkedIn's generic Sort by control without treating it as an applied value", () => {
    const dom = new JSDOM(`
      <main>
        <div role="button" tabindex="0" aria-expanded="false">
          <div aria-label="Filter by Sort by">
            <label>Sort by</label>
          </div>
        </div>
      </main>
    `);
    const pill = findFilterPill(dom.window.document, "sort_by");

    expect(pill?.getAttribute("role")).toBe("button");
    expect(filterPillMatchesValue("sort_by", "relevance", pill)).toBe(false);
    expect(filterPillMatchesValue("sort_by", "recent", pill)).toBe(false);
  });

  it("recognizes the selected sort value nested inside LinkedIn's generic Sort by control", () => {
    const dom = new JSDOM(`
      <main>
        <div role="button" tabindex="0" aria-expanded="false">
          <div aria-label="Filter by Sort by">
            <label>Top Match</label>
          </div>
        </div>
      </main>
    `);
    const pill = findFilterPill(dom.window.document, "sort_by");

    expect(filterPillMatchesValue("sort_by", "relevance", pill)).toBe(true);
    expect(filterPillMatchesValue("sort_by", "recent", pill)).toBe(false);
  });

  it("does not stop when relevance is requested but the current sort is Latest", () => {
    const dom = new JSDOM("<main><div role='button'><div aria-label='Filter by Latest'>Latest</div></div></main>");
    const pill = findFilterPill(dom.window.document, "sort_by");

    expect(filterIsAlreadyApplied("sort_by", "relevance", pill, [])).toBe(false);
    expect(filterIsAlreadyApplied("sort_by", "relevance", null, ["Sort by · Top Match"])).toBe(true);
  });

  it("includes LinkedIn radio-style dropdown options in stable option selectors", () => {
    expect(selectorSets.options).toContain("[role='radio']");
    expect(selectorSets.options).toContain("[role='menuitemradio']");
    expect(selectorSets.overlays).toContain("[popover]");
    expect(selectorSets.controls).toContain("a[href]");
    expect(selectorSets.options).not.toMatch(/class|componentkey/i);
  });

  it("finds sort radio options and Show results in LinkedIn's manual popover fixture", () => {
    const fixturePath = path.join(import.meta.dirname, "fixtures", "linkedin-search.html");
    const dom = new JSDOM(readFileSync(fixturePath, "utf8"));
    const popover = dom.window.document.querySelector<HTMLElement>(selectorSets.overlays);
    const radios = [...(popover?.querySelectorAll<HTMLElement>(selectorSets.options) ?? [])];
    const showResultsLinks = [...dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter((element) => element.textContent?.trim() === "Show results");

    expect(popover?.getAttribute("popover")).toBe("manual");
    expect(radios.some((option) => filterOptionMatchesValue(option, "Relevance", ["Top Match"]))).toBe(true);
    expect(radios.some((option) => filterOptionMatchesValue(option, "Recent", ["Latest"]))).toBe(true);
    expect(showResultsLinks).toHaveLength(1);
  });

  it("matches date and content-type radio options by accessible label and supports their result link", () => {
    const dom = new JSDOM(`
      <main>
        <div popover="manual">
          <div role="radio" aria-label="Past 24 hours" aria-checked="false"><span>Past 24 hours</span></div>
          <div role="radio" aria-label="Past week" aria-checked="true"><span>Past week</span></div>
          <div role="radio" aria-label="Videos" aria-checked="false"><span>Videos</span></div>
          <div role="radio" aria-label="Job posts" aria-checked="false"><span>Job posts</span></div>
          <div role="radio" aria-label="Live videos" aria-checked="false"><span>Live videos</span></div>
          <div role="radio" aria-label="Documents" aria-checked="false"><span>Documents</span></div>
          <a href="?keywords=example">Show results</a>
        </div>
      </main>
    `);
    const options = [...dom.window.document.querySelectorAll<HTMLElement>("[role='radio']")];

    expect(options.some((option) => filterOptionMatchesValue(option, "24h", ["Past 24 hours"]))).toBe(true);
    expect(options.some((option) => filterOptionMatchesValue(option, "videos"))).toBe(true);
    expect(options.some((option) => filterOptionMatchesValue(option, "job_posts", ["Job posts"]))).toBe(true);
    expect(options.some((option) => filterOptionMatchesValue(option, "live_videos", ["Live videos"]))).toBe(true);
    expect(options.some((option) => filterOptionMatchesValue(option, "documents"))).toBe(true);
    expect(isFilterOptionSelected(options[1])).toBe(true);
    expect(dom.window.document.querySelector("a[href]")?.textContent?.trim()).toBe("Show results");
  });

  it("finds LinkedIn's nested aria-label on the role=button wrapper from the live markup shape", () => {
    const dom = new JSDOM(`
      <main>
        <div role="toolbar">
          <div role="radiogroup">
            <div role="button" tabindex="0" aria-expanded="false">
              <div componentkey="unstable-key" aria-label="Filter by Top Match">
                <input type="checkbox" checked>
                <label>Top Match</label>
              </div>
            </div>
          </div>
        </div>
      </main>
    `);
    const pill = findFilterPill(dom.window.document, "sort_by");
    expect(pill?.getAttribute("role")).toBe("button");
    expect(filterPillMatchesValue("sort_by", "relevance", pill)).toBe(true);
  });

  it("recognizes the visible Top Match label when LinkedIn omits the nested aria-label", () => {
    const dom = new JSDOM(`
      <main><div role="button" aria-expanded="false"><label>Top Match</label></div></main>
    `);
    const pill = findFilterPill(dom.window.document, "sort_by");
    expect(filterPillMatchesValue("sort_by", "relevance", pill)).toBe(true);
  });

  it("does not treat filter controls as selected chips", () => {
    const dom = new JSDOM("<main><button aria-label='Content type'>Videos</button></main>");
    const chips = getActiveFilterChipTexts(dom.window.document);
    expect(filterChipMatches("Videos", chips)).toBe(false);
  });
});
