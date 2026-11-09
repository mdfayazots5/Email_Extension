import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { findPostCards, findPostPermalink, postCardLinkDiagnostics, postDiscoveryDiagnostics } from "./post-discovery";

describe("LinkedIn post discovery", () => {
  it("finds posts with expandable text inside an article card", () => {
    const dom = new JSDOM(`
      <main>
        <article>
          <a href="https://www.linkedin.com/feed/update/urn:li:activity:1/">Post date</a>
          <div data-testid="commentary">Hiring roles...</div>
          <button data-testid="expandable-text-button">… more</button>
        </article>
      </main>
    `);

    expect(findPostCards(dom.window.document)).toEqual([dom.window.document.querySelector("article")]);
  });

  it("uses the nearest single-post ancestor when the card has no article or data-urn hook", () => {
    const dom = new JSDOM(`
      <main>
        <div class="unstable-card-hash">
          <div class="unstable-content-hash">Hiring post...</div>
          <a href="https://www.linkedin.com/feed/update/urn:li:activity:2/">Post date</a>
          <button type="button" aria-hidden="true" data-testid="expandable-text-button">… more</button>
        </div>
      </main>
    `);
    const card = dom.window.document.querySelector(".unstable-card-hash");

    expect(findPostCards(dom.window.document).map((element) => element.className))
      .toContain("unstable-card-hash");
  });

  it("recognizes LinkedIn search result list items containing one expand button", () => {
    const dom = new JSDOM(`
      <div role="list">
        <div role="listitem" componentkey="expanded_search_result">
          <div>
            <p><span data-testid="expandable-text-box">Post text...</span></p>
            <button data-testid="expandable-text-button">… more</button>
          </div>
        </div>
      </div>
    `);
    const card = dom.window.document.querySelector("[role='listitem']");

    expect(findPostCards(dom.window.document)).toEqual([card]);
  });

  it("does not treat a profile link as a post permalink", () => {
    const dom = new JSDOM(`
      <div role="listitem">
        <a href="https://www.linkedin.com/in/example/">Author profile</a>
        <button data-testid="expandable-text-button">… more</button>
      </div>
    `);
    const card = dom.window.document.querySelector<HTMLElement>("[role='listitem']")!;

    expect(findPostPermalink(card)).toBe("");
  });

  it("extracts supported post permalinks from LinkedIn cards", () => {
    const dom = new JSDOM(`
      <article>
        <a href="https://www.linkedin.com/feed/update/urn:li:activity:42/">Post</a>
      </article>
    `, { url: "https://www.linkedin.com/search/results/content/" });
    const card = dom.window.document.querySelector<HTMLElement>("article")!;

    expect(findPostPermalink(card)).toBe("https://www.linkedin.com/feed/update/urn:li:activity:42/");
  });

  it("builds the permalink from the card's own post URN before links in the post text", () => {
    const dom = new JSDOM(`
      <div role="listitem" data-urn="urn:li:activity:7390000000000000001">
        <span data-testid="expandable-text-box">See <a href="https://www.linkedin.com/feed/update/urn:li:activity:111111111111/">another post</a></span>
      </div>
    `, { url: "https://www.linkedin.com/search/results/content/" });
    const card = dom.window.document.querySelector<HTMLElement>("[role='listitem']")!;

    expect(findPostPermalink(card)).toBe("https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000001/");
  });

  it("finds the post URN in componentkey and encoded tracking-scope attributes", () => {
    const payload = [...JSON.stringify({ updateUrn: "urn:li:ugcPost:7390000000000000002" })].map((char) => char.charCodeAt(0));
    const scope = JSON.stringify([{ breadcrumb: { content: { type: "Buffer", data: payload } } }]);
    const dom = new JSDOM(`
      <div role="listitem"><div id="a" componentkey="expandedurn:li:share:7390000000000000003FeedType"></div></div>
      <div role="listitem"><div id="b"></div></div>
    `);
    const [first, second] = [...dom.window.document.querySelectorAll<HTMLElement>("[role='listitem']")];
    second.querySelector("#b")!.setAttribute("data-view-tracking-scope", scope);

    expect(findPostPermalink(first)).toBe("https://www.linkedin.com/feed/update/urn:li:share:7390000000000000003/");
    expect(findPostPermalink(second)).toBe("https://www.linkedin.com/feed/update/urn:li:ugcPost:7390000000000000002/");
  });

  it("logs link route and structure metadata without storing link text or profile identifiers", () => {
    const dom = new JSDOM(`
      <div role="listitem" componentkey="update-card-focus_opaque">
        <a href="https://www.linkedin.com/in/private-profile/" aria-label="Private author">
          <span>Private Author</span>
        </a>
        <a href="https://www.linkedin.com/feed/update/urn:li:activity:42/?tracking=private">
          <time>Oct 9</time>
        </a>
        <button data-testid="expandable-text-button">… more</button>
      </div>
    `, { url: "https://www.linkedin.com/search/results/content/" });
    const diagnostics = postCardLinkDiagnostics(dom.window.document);

    expect(diagnostics.cards[0]).toMatchObject({
      role: "listitem",
      componentType: "update-card-focus",
      anchors: [
        { hrefKind: "profile", hrefPath: "/in/:profile", textLooksLikeDate: false },
        { hrefKind: "feed-update", hrefPath: "/feed/update/:activity", isTimeElement: true, textLooksLikeDate: true }
      ]
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Private Author");
    expect(JSON.stringify(diagnostics)).not.toContain("private-profile");
    expect(JSON.stringify(diagnostics)).not.toContain("tracking=private");
  });

  it("redacts non-post link paths and records date element structure without date text", () => {
    const dom = new JSDOM(`
      <div role="listitem" componentkey="update-card-focus">
        <a href="https://www.linkedin.com/private-person@example.com/"><span>private-person@example.com</span></a>
        <p class="date-component"><span>Oct 9</span></p>
        <button data-testid="expandable-text-button">… more</button>
      </div>
    `, { url: "https://www.linkedin.com/search/results/content/" });

    const diagnostics = postCardLinkDiagnostics(dom.window.document);
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.cards[0].anchors[0].hrefPath).toBe("(other LinkedIn link)");
    expect(diagnostics.cards[0].dateCandidates.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("private-person@example.com");
    expect(serialized).not.toContain("Oct 9");
  });

  it("reports canonical post links that are outside detected post cards", () => {
    const dom = new JSDOM(`
      <div role="listitem"><button data-testid="expandable-text-button">… more</button></div>
      <a href="https://www.linkedin.com/feed/update/urn:li:activity:99/"><time>Oct 9</time></a>
    `, { url: "https://www.linkedin.com/search/results/content/" });

    expect(postCardLinkDiagnostics(dom.window.document)).toMatchObject({
      canonicalLinkCount: 1,
      canonicalLinksOutsideCards: [{
        hrefPath: "/feed/update/:activity",
        isTimeElement: true
      }]
    });
  });

  it("captures only safe menu action and route categories", () => {
    const dom = new JSDOM(`
      <div role="menu">
        <button role="menuitem" aria-label="Copy link to private post by Jane Doe">Copy link</button>
        <a href="https://www.linkedin.com/feed/update/urn:li:activity:private-id/">Private post</a>
      </div>
    `);
    const diagnostics = postCardLinkDiagnostics(dom.window.document);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.menus).toEqual([{
      role: "menu",
      itemCount: 2,
      actions: ["copy-link", "other"],
      anchorRoutes: ["feed-update"]
    }]);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("private-id");
  });

  it("finds menu surfaces identified by data-testid without exposing the identifier", () => {
    const dom = new JSDOM(`
      <div data-testid="post-control-menu-private">
        <button aria-label="Copy link to private post">Copy link</button>
        <a href="https://www.linkedin.com/posts/private-author_private-id/">Post link</a>
      </div>
    `);
    const diagnostics = postCardLinkDiagnostics(dom.window.document);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.menus).toEqual([{
      role: "",
      itemCount: 2,
      actions: ["copy-link", "other"],
      anchorRoutes: ["posts"]
    }]);
    expect(serialized).not.toContain("private-author");
    expect(serialized).not.toContain("private-id");
  });

  it("finds copy-link actions even when LinkedIn does not expose a recognized menu role", () => {
    const dom = new JSDOM(`
      <div class="private-menu-container">
        <button aria-label="Copy link to private post by Jane Doe">Copy link</button>
      </div>
    `);
    const diagnostics = postCardLinkDiagnostics(dom.window.document);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.menus).toEqual([]);
    expect(diagnostics.actionControls).toEqual([{
      tag: "button",
      role: "",
      action: "copy-link",
      route: "",
      parentRoles: []
    }]);
    expect(serialized).not.toContain("Jane Doe");
  });

  it("detects LinkedIn's unmarked Copy link to post menu item", () => {
    const dom = new JSDOM(`
      <div class="opaque-menu">
        <div class="opaque-menu-item"><span>Copy link to post</span></div>
      </div>
    `);
    const diagnostics = postCardLinkDiagnostics(dom.window.document);

    expect(diagnostics.menus).toEqual([]);
    expect(diagnostics.actionControls).toContainEqual({
      tag: "span",
      role: "",
      action: "copy-link",
      route: "",
      parentRoles: []
    });
  });

  it("reports the post menu toggle state without logging the author's name", () => {
    const dom = new JSDOM(`
      <div role="listitem">
        <button aria-label="Open control menu for post by Jane Doe" aria-expanded="false">…</button>
        <button data-testid="expandable-text-button">… more</button>
      </div>
    `);
    const diagnostics = postCardLinkDiagnostics(dom.window.document);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.menuToggles).toEqual([{
      tag: "button",
      expanded: "false",
      cardIndex: 0
    }]);
    expect(diagnostics.actionControls).toContainEqual({
      tag: "button",
      role: "",
      action: "open-post-menu",
      route: "",
      parentRoles: ["listitem"]
    });
    expect(serialized).not.toContain("Jane Doe");
  });

  it("does not treat list items with multiple expand buttons as a single post", () => {
    const dom = new JSDOM(`
      <div role="listitem">
        <button data-testid="expandable-text-button">… more</button>
        <button data-testid="expandable-text-button">… more</button>
      </div>
    `);

    expect(findPostCards(dom.window.document)).toEqual([]);
  });

  it("does not promote a feed container containing multiple expandable posts into one post", () => {
    const dom = new JSDOM(`
      <main>
        <div id="feed">
          <div>
            <a href="https://www.linkedin.com/feed/update/urn:li:activity:3/">First post</a>
            <button data-testid="expandable-text-button">… more</button>
          </div>
          <div>
            <a href="https://www.linkedin.com/feed/update/urn:li:activity:4/">Second post</a>
            <button data-testid="expandable-text-button">… more</button>
          </div>
        </div>
      </main>
    `);
    const feed = dom.window.document.querySelector("#feed");

    const cards = findPostCards(dom.window.document);
    expect(cards.some((card) => card.id === "feed")).toBe(false);
    expect(cards).toHaveLength(2);
  });

  it("reports selector counts and safe ancestor metadata without copying post text", () => {
    const dom = new JSDOM(`
      <main>
        <div>
          <a href="https://www.linkedin.com/feed/update/urn:li:activity:5/">Permalink</a>
          <div>Private post body text</div>
          <button data-testid="expandable-text-button">… more</button>
        </div>
      </main>
    `);

    const diagnostics = postDiscoveryDiagnostics(dom.window.document);

    expect(diagnostics).toMatchObject({
      matchedCards: 1,
      expandButtons: 1,
      articleElements: 0,
      buttonAncestors: [{ buttonIndex: 0, candidateHasPermalink: true, candidateExpandButtonCount: 1 }]
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Private post body text");
  });
});
